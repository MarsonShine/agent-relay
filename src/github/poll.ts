import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GitHubApi, pullSchema } from './api.ts';
import { Deliveries } from './delivery-store.ts';
import type { Delivery, DeliveryIntent } from './delivery-store.ts';
import { GitHubError, successful, seconds } from './transport.ts';
import { codeFailures } from './diagnostics.ts';
import type { Reply, Transport } from './transport.ts';
import { repository } from './source.ts';
import { RelayError } from '../core/errors.ts';
import type { GitHubPolicy } from './contracts.ts';

export const commentSchema = z.object({
  id: z.number().int().positive(),
  updated_at: z.string(),
  body: z.string().max(32768),
  user: z.object({ id: z.number().int().positive(), login: z.string() }),
});
export const ciSchema = z.strictObject({
  requirementVersion: z.number(),
  revision: z.string(),
  sourceVersion: z.string(),
  checkedAt: z.number(),
  state: z.enum(['passed', 'pending', 'code-failure', 'infrastructure']),
  details: z.array(z.string()),
});
export type CI = z.infer<typeof ciSchema>;
const checkSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ id: z.number() }),
  check_suite: z.object({ id: z.number() }),
});
export function classifyCI(
  checks: unknown[],
  statuses: unknown[],
  policy: GitHubPolicy,
  revision: string,
  codeFailureIds: readonly number[] = [],
): Pick<CI, 'state' | 'details'> {
  const runs = checks.map((c) => checkSchema.parse(c));
  const legacy = statuses.map((s) =>
    z.object({ context: z.string(), state: z.string() }).parse(s),
  );
  const details: string[] = [];
  let state: CI['state'] = 'passed';
  for (const required of policy.requiredChecks) {
    const matching = runs.filter((r) => r.name === required.name);
    if (
      !matching.length ||
      matching.some(
        (r) => r.head_sha !== revision || r.app.id !== required.appId,
      ) ||
      legacy.some((s) => s.context === required.name)
    ) {
      details.push(`${required.name}: missing or ambiguous trusted context`);
      state = 'pending';
      continue;
    }
    // Reruns replace their own suite only; parallel suites must all pass.
    const latest = new Map<number, (typeof matching)[number]>();
    for (const run of matching)
      if (run.id > (latest.get(run.check_suite.id)?.id ?? -1))
        latest.set(run.check_suite.id, run);
    for (const run of latest.values()) {
      details.push(
        `${required.name}:${run.id}:${run.status}:${run.conclusion}`,
      );
      if (codeFailureIds.includes(run.id))
        details.push(
          `Trusted project step failed after successful setup: ${required.codeStep}`,
        );
      if (run.status !== 'completed' || run.conclusion === null)
        state = 'pending';
      else if (run.conclusion !== 'success' && state !== 'pending')
        state =
          run.conclusion === 'failure' &&
          codeFailureIds.includes(run.id) &&
          !['infrastructure'].includes(state)
            ? 'code-failure'
            : 'infrastructure';
    }
  }
  return { state, details };
}
/** Persisted ETags are only used with a previously complete, bounded response. */
class CachedTransport implements Transport {
  readonly store: Deliveries;
  readonly taskId: string;
  nextAt = 0;
  constructor(store: Deliveries, taskId: string) {
    this.store = store;
    this.taskId = taskId;
  }
  async request(path: string): Promise<Reply> {
    const delivery = this.store.get(this.taskId);
    if (
      !delivery ||
      delivery.status !== 'watching' ||
      Date.now() >= delivery.deadlineAt
    )
      throw new RelayError('conflict', 'poll stopped or deadline exhausted');
    const sql = this.store.tasks.db.sql;
    const row = sql
      .prepare(
        'SELECT document FROM github_cache WHERE task_id=? AND endpoint=?',
      )
      .get(this.taskId, path);
    const cached = row ? (JSON.parse(String(row.document)) as Reply) : null;
    const reply = await this.store.sources.transport.request(
      path,
      'GET',
      undefined,
      cached?.headers.etag,
    );
    this.nextAt = Math.max(
      this.nextAt,
      Date.now() + (seconds(reply.headers['x-poll-interval']) ?? 0) * 1000,
    );
    if (reply.status === 304) {
      if (!cached)
        throw new RelayError(
          'conflict',
          'conditional response has no persisted body',
        );
      return cached;
    }
    successful(reply);
    sql
      .prepare(
        'INSERT INTO github_cache VALUES(?,?,?) ON CONFLICT(task_id,endpoint) DO UPDATE SET document=excluded.document',
      )
      .run(this.taskId, path, JSON.stringify(reply));
    return reply;
  }
}
export class Poller {
  readonly store: Deliveries;
  private busy = false;
  constructor(store: Deliveries) {
    this.store = store;
  }
  ci(taskId: string): CI | null {
    const row = this.store.tasks.db.sql
      .prepare('SELECT document FROM github_ci WHERE task_id=?')
      .get(taskId);
    return row ? ciSchema.parse(JSON.parse(String(row.document))) : null;
  }
  inbox(taskId: string) {
    return this.store.tasks.db.sql
      .prepare(
        'SELECT event_key, document, disposition FROM github_inbox WHERE task_id=? ORDER BY rowid',
      )
      .all(taskId)
      .map((r) => ({
        key: String(r.event_key),
        comment: commentSchema.parse(JSON.parse(String(r.document))),
        disposition: String(r.disposition),
      }));
  }
  private current(delivery: Delivery, intent: DeliveryIntent): void {
    const d = this.store.get(delivery.taskId),
      t = this.store.tasks.get(delivery.taskId);
    if (
      d?.current !== delivery.current ||
      d.polls !== delivery.polls ||
      d.status !== 'watching' ||
      t.status !== 'succeeded' ||
      t.requirementVersion !== intent.requirementVersion ||
      t.codeRevision !== intent.revision ||
      Date.now() >= d.deadlineAt
    )
      throw new RelayError(
        'conflict',
        'poll evidence was superseded or stopped',
      );
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const d of this.store
        .list()
        .filter(
          (d) =>
            d.status === 'watching' &&
            (d.nextPollAt <= Date.now() || d.deadlineAt <= Date.now()),
        ))
        await this.poll(d.taskId);
    } finally {
      this.busy = false;
    }
  }
  async poll(taskId: string): Promise<void> {
    const delivery = this.store.tasks.db.transaction(() => {
      const d = this.store.get(taskId)!,
        policy = this.store.sources.get(taskId)!.policy;
      if (
        d.status !== 'watching' ||
        (d.nextPollAt > Date.now() && d.deadlineAt > Date.now())
      )
        return null;
      if (d.polls >= policy.maxPolls || Date.now() >= d.deadlineAt) {
        this.store.save({
          ...d,
          status: 'blocked',
          diagnostic: 'delivery polling budget exhausted',
        });
        return null;
      }
      const next = {
        ...d,
        polls: d.polls + 1,
        nextPollAt: Date.now() + policy.pollIntervalMs,
      };
      this.store.save(next);
      return next;
    });
    if (!delivery) return;
    const intent = this.store.intent(delivery.current),
      source = this.store.sources.get(taskId)!;
    const transport = new CachedTransport(this.store, taskId),
      api = new GitHubApi(transport, source.policy);
    try {
      this.current(delivery, intent);
      await repository(transport, source.policy);
      const pull = pullSchema.parse(
        successful(await transport.request(`${api.root}/pulls/${intent.pr}`)),
      );
      api.validatePull(
        pull,
        intent.branch,
        intent.marker,
        intent.revision,
        intent.baseRevision,
      );
      if (
        (await api.ref(intent.branch)) !== intent.revision ||
        (await api.ref(source.policy.base)) !== intent.baseRevision
      )
        throw new RelayError('conflict', 'remote branch changed or deleted');
      const comments: unknown[] = [];
      // Full conditional collections include edits to older comments; no time watermark can hide them.
      for (const number of new Set([source.issue, intent.pr!]))
        comments.push(...(await api.pages(`/issues/${number}/comments`)));
      const checks = await api.pages(
        `/commits/${intent.revision}/check-runs?filter=all`,
        'check_runs',
      );
      const statuses = await api.pages(`/commits/${intent.revision}/statuses`);
      const ci = ciSchema.parse({
        ...classifyCI(
          checks,
          statuses,
          source.policy,
          intent.revision,
          await codeFailures(api, checks, intent.revision),
        ),
        revision: intent.revision,
        requirementVersion: intent.requirementVersion,
        sourceVersion: intent.sourceVersion,
        checkedAt: Date.now(),
      });
      this.store.tasks.db.transaction(() => {
        this.current(delivery, intent);
        const sql = this.store.tasks.db.sql;
        for (const value of comments) {
          const comment = commentSchema.parse(value);
          const key = `${comment.id}:${comment.updated_at}:${createHash('sha256').update(comment.body).digest('hex')}`;
          const self = !!sql
            .prepare(
              'SELECT 1 FROM github_own_events WHERE task_id=? AND event_id=?',
            )
            .get(taskId, comment.id);
          sql
            .prepare(
              "UPDATE github_inbox SET disposition='superseded' WHERE task_id=? AND json_extract(document,'$.id')=? AND event_key!=? AND disposition='pending'",
            )
            .run(taskId, comment.id, key);
          sql
            .prepare('INSERT OR IGNORE INTO github_inbox VALUES(?,?,?,?)')
            .run(
              taskId,
              key,
              JSON.stringify(comment),
              self ? 'self' : 'pending',
            );
        }
        sql
          .prepare(
            'INSERT INTO github_ci VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document',
          )
          .run(taskId, JSON.stringify(ci));
        this.store.save({
          ...this.store.get(taskId)!,
          nextPollAt: Math.max(delivery.nextPollAt, transport.nextAt),
          diagnostic: null,
        });
      });
    } catch (error) {
      const d = this.store.get(taskId)!;
      if (
        d.current !== delivery.current ||
        d.polls !== delivery.polls ||
        d.status !== 'watching'
      )
        return;
      const retry =
        error instanceof GitHubError &&
        ([429, 502, 503, 504].includes(error.status) || error.rateLimited);
      this.store.save({
        ...d,
        status: retry ? 'watching' : 'blocked',
        nextPollAt: Math.max(
          d.nextPollAt,
          error instanceof GitHubError ? error.retryAt : 0,
        ),
        diagnostic:
          error instanceof RelayError || error instanceof GitHubError
            ? error.message
            : 'incomplete GitHub poll; no evidence accepted',
      });
    }
  }
}
