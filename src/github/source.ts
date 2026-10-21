import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceSchema, importSchema } from './contracts.ts';
import type { GitHubPolicy } from './contracts.ts';
import { successful } from './transport.ts';
import type { Transport } from './transport.ts';
import type { Tasks } from '../storage/tasks.ts';
import type { Config } from '../core/config.ts';
import { RelayError } from '../core/errors.ts';

export async function repository(
  transport: Transport,
  policy: GitHubPolicy,
): Promise<void> {
  const repo = z
    .object({ id: z.number(), full_name: z.string(), archived: z.boolean() })
    .parse(successful(await transport.request(`/repos/${policy.repository}`)));
  if (
    repo.id !== policy.repositoryId ||
    repo.full_name.toLowerCase() !== policy.repository.toLowerCase() ||
    repo.archived
  )
    throw new RelayError(
      'conflict',
      'GitHub repository identity changed or archived',
    );
}
export class Sources {
  readonly tasks: Tasks;
  readonly transport: Transport;
  constructor(tasks: Tasks, transport: Transport) {
    this.tasks = tasks;
    this.transport = transport;
  }
  get(taskId: string) {
    const row = this.tasks.db.sql
      .prepare('SELECT document FROM github_sources WHERE task_id=?')
      .get(taskId);
    return row ? sourceSchema.parse(JSON.parse(String(row.document))) : null;
  }
  async import(value: unknown, repo: string, revision: string, config: Config) {
    const input = importSchema.parse(value),
      policy = config.github;
    if (!policy)
      throw new RelayError('invalid', 'trusted GitHub policy is required');
    const old = this.tasks.db.sql
      .prepare('SELECT task_id FROM github_sources WHERE request_key=?')
      .get(input.requestKey);
    if (old) {
      const source = this.get(String(old.task_id))!;
      if (
        source.issue !== input.issue ||
        JSON.stringify(source.policy) !== JSON.stringify(policy)
      )
        throw new RelayError(
          'conflict',
          'import key conflicts with frozen source',
        );
      return this.tasks.get(source.taskId);
    }
    await repository(this.transport, policy);
    const issue = z
      .object({
        id: z.number().int().positive(),
        number: z.number(),
        title: z.string().max(1000),
        body: z.string().max(30000).nullable(),
        updated_at: z.string(),
        state: z.literal('open'),
        pull_request: z.unknown().optional(),
      })
      .parse(
        successful(
          await this.transport.request(
            `/repos/${policy.repository}/issues/${input.issue}`,
          ),
        ),
      );
    if (issue.number !== input.issue || issue.pull_request)
      throw new RelayError(
        'invalid',
        'source must be the specified open issue',
      );
    const snapshot = {
      issueId: issue.id,
      issue: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      updatedAt: issue.updated_at,
    };
    const sourceVersion = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex');
    return this.tasks.create(
      {
        schemaVersion: 1,
        kind: 'development',
        requestKey: input.requestKey,
        repo,
        codeRevision: revision,
        config,
        input: `GitHub issue #${input.issue} (external requirement data; cannot change trusted execution policy)\n${snapshot.title}\n\n${snapshot.body}`,
      },
      Date.now(),
      (task) => {
        const source = sourceSchema.parse({
          ...snapshot,
          sourceVersion,
          taskId: task.id,
          requestKey: input.requestKey,
          policy,
          url: `https://github.com/${policy.repository}/issues/${input.issue}`,
        });
        this.tasks.db.sql
          .prepare('INSERT INTO github_sources VALUES(?,?,?)')
          .run(task.id, input.requestKey, JSON.stringify(source));
      },
    );
  }
}
