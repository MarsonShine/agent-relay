import { z } from 'zod';
import type { GitHubApi } from './api.ts';
import { successful } from './transport.ts';

/** Generic job failure is not evidence of a code defect. Only a frozen check step after successful setup qualifies. */
export async function codeFailures(
  api: GitHubApi,
  checks: unknown[],
  revision: string,
): Promise<number[]> {
  const ids: number[] = [];
  for (const value of checks) {
    const check = z
      .object({
        id: z.number(),
        name: z.string(),
        head_sha: z.string(),
        conclusion: z.string().nullable(),
        app: z.object({ id: z.number() }),
        details_url: z.string().nullable().optional(),
      })
      .parse(value);
    const trusted = api.policy.requiredChecks.find(
      (c) => c.name === check.name && c.appId === check.app.id && c.codeStep,
    );
    const prefix = `https://github.com/${api.policy.repository}/actions/runs/`;
    const match = check.details_url?.startsWith(prefix)
      ? /^(\d+)\/job\/(\d+)$/.exec(check.details_url.slice(prefix.length))
      : null;
    if (
      check.head_sha !== revision ||
      check.conclusion !== 'failure' ||
      !trusted ||
      !match
    )
      continue;
    const job = z
      .object({
        head_sha: z.string(),
        check_run_url: z.string(),
        name: z.string(),
        steps: z
          .array(
            z.object({
              name: z.string(),
              conclusion: z.string().nullable(),
              number: z.number(),
            }),
          )
          .max(100),
      })
      .parse(
        successful(
          await api.transport.request(`${api.root}/actions/jobs/${match[2]}`),
        ),
      );
    const step = job.steps.find(
      (s) => s.name === trusted.codeStep && s.conclusion === 'failure',
    );
    if (
      job.head_sha === revision &&
      job.check_run_url ===
        `https://api.github.com${api.root}/check-runs/${check.id}` &&
      job.name === check.name &&
      step &&
      job.steps
        .filter((s) => s.number < step.number)
        .every((s) => s.conclusion === 'success')
    )
      ids.push(check.id);
  }
  return ids;
}
