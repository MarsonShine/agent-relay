import { z } from 'zod';
import type { Transport } from './transport.ts';
import { successful } from './transport.ts';
import type { GitHubPolicy } from './contracts.ts';
import { RelayError } from '../core/errors.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repo = z.object({ id: z.number(), full_name: z.string() });
const branch = z.object({ ref: z.string(), sha, repo });
export const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  body: z.string().nullable(),
  head: branch,
  base: branch,
  html_url: z.string(),
});
export type Pull = z.infer<typeof pullSchema>;
export class GitHubApi {
  readonly transport: Transport;
  readonly policy: GitHubPolicy;
  readonly root: string;
  constructor(transport: Transport, policy: GitHubPolicy) {
    this.transport = transport;
    this.policy = policy;
    this.root = `/repos/${policy.repository}`;
  }
  async ref(branch: string): Promise<string | null> {
    const reply = await this.transport.request(
      `${this.root}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (reply.status === 404) return null;
    const value = z
      .object({
        ref: z.literal(`refs/heads/${branch}`),
        object: z.object({ type: z.literal('commit'), sha }),
      })
      .parse(successful(reply));
    return value.object.sha;
  }
  async pages(path: string, field?: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= this.policy.maxPages; page++) {
      const reply = await this.transport.request(
        `${this.root}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      const body = successful(reply);
      const values = z
        .array(z.unknown())
        .parse(
          field ? z.record(z.string(), z.unknown()).parse(body)[field] : body,
        );
      all.push(...values);
      if (!reply.headers.link?.includes('rel="next"')) {
        if (
          field &&
          typeof body === 'object' &&
          body &&
          'total_count' in body &&
          Number(body.total_count) > all.length
        )
          throw new RelayError('conflict', 'incomplete GitHub page collection');
        return all;
      }
    }
    throw new RelayError(
      'conflict',
      'GitHub pagination bound reached; incomplete collection',
    );
  }
  async pulls(branch: string): Promise<Pull[]> {
    return (
      await this.pages(
        `/pulls?state=all&head=${encodeURIComponent(`${this.policy.repository.split('/')[0]}:${branch}`)}`,
      )
    ).map((p) => pullSchema.parse(p));
  }
  validatePull(
    pull: Pull,
    branch: string,
    marker: string,
    revision: string,
    baseRevision: string,
  ): void {
    if (
      pull.state !== 'open' ||
      pull.merged_at ||
      pull.head.ref !== branch ||
      pull.base.ref !== this.policy.base ||
      pull.head.sha !== revision ||
      pull.base.sha !== baseRevision ||
      !pull.body?.includes(marker) ||
      [pull.head.repo, pull.base.repo].some(
        (r) =>
          r.id !== this.policy.repositoryId ||
          r.full_name.toLowerCase() !== this.policy.repository.toLowerCase(),
      )
    )
      throw new RelayError(
        'conflict',
        'PR is closed, merged, changed or does not belong to this delivery',
      );
    if (
      pull.html_url !==
      `https://github.com/${this.policy.repository}/pull/${pull.number}`
    )
      throw new RelayError('conflict', 'unexpected PR URL');
  }
}
