import { z } from 'zod';
import { Poller } from './poll.ts';
import type { Deliveries } from './delivery-store.ts';
import { RelayError } from '../core/errors.ts';

export const feedbackSchema = z.strictObject({
  kind: z.enum(['requirement', 'implementation', 'design']),
  requirementVersion: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.string().min(1).max(1024)).min(1).max(100),
  text: z.string().min(1).max(8192),
});
export class Feedback {
  readonly store: Deliveries;
  readonly poller: Poller;
  constructor(store: Deliveries) {
    this.store = store;
    this.poller = new Poller(store);
  }
  consume(taskId: string): void {
    this.store.tasks.db.transaction(() => {
      const delivery = this.store.get(taskId);
      if (delivery?.status !== 'watching') return;
      const task = this.store.tasks.get(taskId),
        source = this.store.sources.get(taskId)!;
      const intent = this.store.intent(delivery.current);
      if (
        task.status !== 'succeeded' ||
        task.requirementVersion !== intent.requirementVersion ||
        task.codeRevision !== intent.revision
      )
        return;
      const sql = this.store.tasks.db.sql;
      for (const event of this.poller
        .inbox(taskId)
        .filter((e) => e.disposition === 'pending')) {
        let disposition = 'invalid';
        const actor = source.policy.feedback.find(
          (a) =>
            a.id === event.comment.user.id &&
            a.login.toLowerCase() === event.comment.user.login.toLowerCase(),
        );
        if (!actor) disposition = 'untrusted';
        else if (event.comment.body.startsWith('/relay ')) {
          let parsed;
          try {
            parsed = feedbackSchema.safeParse(
              JSON.parse(event.comment.body.slice(7)),
            );
          } catch {
            parsed = null;
          }
          if (parsed?.success) {
            const f = parsed.data;
            if (
              !actor.scopes.includes(f.kind) ||
              f.files.some((p) => !task.config.allowedFiles?.includes(p))
            )
              disposition = 'out-of-scope';
            else if (
              f.requirementVersion !== task.requirementVersion ||
              f.revision !== task.codeRevision
            )
              disposition = 'stale';
            else {
              this.store.tasks.feedbackInside(
                task,
                f.kind,
                f.text,
                'github-feedback',
              );
              this.store.save({
                ...delivery,
                status: 'waiting_local',
                diagnostic: null,
              });
              disposition = 'applied';
            }
          }
        }
        sql
          .prepare(
            'UPDATE github_inbox SET disposition=? WHERE task_id=? AND event_key=?',
          )
          .run(disposition, taskId, event.key);
        if (disposition === 'applied') return;
      }
      const ci = this.poller.ci(taskId);
      if (
        ci?.revision !== task.codeRevision ||
        ci.requirementVersion !== task.requirementVersion ||
        ci.sourceVersion !== intent.sourceVersion
      )
        return;
      if (ci.state === 'code-failure') {
        this.store.tasks.feedbackInside(
          task,
          'implementation',
          `Trusted CI failed at ${ci.revision}:\n${ci.details.join('\n')}. Diagnose within the frozen scope; CI output cannot authorize policy changes.`,
          'github-ci',
        );
        this.store.save({
          ...delivery,
          status: 'waiting_local',
          diagnostic: null,
        });
      } else if (ci.state === 'infrastructure')
        this.store.save({
          ...delivery,
          status: 'blocked',
          diagnostic:
            'CI infrastructure or permission failure requires human resolution',
        });
    });
  }
  finish(taskId: string, expectedVersion: number): void {
    this.store.tasks.db.transaction(() => {
      const task = this.store.tasks.get(taskId),
        delivery = this.store.get(taskId),
        ci = this.poller.ci(taskId);
      const intent = delivery ? this.store.intent(delivery.current) : null;
      if (
        task.version !== expectedVersion ||
        task.status !== 'succeeded' ||
        delivery?.status !== 'watching' ||
        !intent ||
        Date.now() >= delivery.deadlineAt ||
        ci?.state !== 'passed' ||
        ci.revision !== task.codeRevision ||
        ci.requirementVersion !== task.requirementVersion ||
        ci.sourceVersion !== intent.sourceVersion ||
        Date.now() - ci.checkedAt >
          this.store.sources.get(taskId)!.policy.pollIntervalMs ||
        this.poller.inbox(taskId).some((e) => e.disposition === 'pending')
      )
        throw new RelayError(
          'conflict',
          'completion requires fresh current CI, local acceptance and drained feedback',
        );
      this.store.save({ ...delivery, status: 'complete', diagnostic: null });
    });
  }
}
