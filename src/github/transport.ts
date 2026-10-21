import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RelayError } from '../core/errors.ts';

export type Reply = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};
export interface Transport {
  request(
    path: string,
    method?: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    etag?: string,
  ): Promise<Reply>;
}
export class GitHubError extends Error {
  readonly rateLimited: boolean;
  readonly status: number;
  readonly retryAt: number;
  constructor(reply: Reply) {
    super(`GitHub HTTP ${reply.status}`);
    this.status = reply.status;
    const retry = seconds(reply.headers['retry-after']);
    const reset = seconds(reply.headers['x-ratelimit-reset']);
    this.rateLimited =
      reply.status === 429 ||
      retry !== null ||
      (reply.headers['x-ratelimit-remaining'] === '0' && reset !== null);
    this.retryAt = Math.max(
      Date.now() + Math.max(60000, (retry ?? 0) * 1000),
      reply.headers['x-ratelimit-remaining'] === '0' ? (reset ?? 0) * 1000 : 0,
    );
  }
}
export function seconds(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 8640000000000
    ? number
    : null;
}
export function successful(reply: Reply): unknown {
  if (reply.status < 200 || reply.status >= 300) throw new GitHubError(reply);
  return reply.body;
}
/** Credentials stay in the controller; destinations never come from issue text. */
export class GitHubTransport implements Transport {
  async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
    etag?: string,
  ): Promise<Reply> {
    if (
      !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/?]|$)/.test(path) ||
      path.includes('..') ||
      path.includes('\\')
    )
      throw new RelayError('invalid', 'untrusted GitHub endpoint');
    const { stdout } = await promisify(execFile)(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      {
        timeout: 5000,
        maxBuffer: 8192,
        windowsHide: true,
      },
    );
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${stdout.trim()}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'user-agent': 'agent-relay',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          await response.body.cancel().catch(() => {});
          throw new RelayError('invalid', 'GitHub response limit exceeded');
        }
        chunks.push(chunk);
      }
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: text ? (JSON.parse(text) as unknown) : null,
    };
  }
}
