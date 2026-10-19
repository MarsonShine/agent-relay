import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { codexProfileSchema } from '../src/adapters/codex/config.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { Config } from '../src/core/config.ts';
import type { ExecutionRequest } from '../src/core/execution.ts';
import { Runs } from '../src/storage/runs.ts';
import { fixture, request } from './helpers.ts';
import { testedCodexVersion } from '../src/adapters/codex/events.ts';

export function codexFixture(t: TestContext) {
  const f = fixture(t);
  const workspace = join(f.directory, 'repository');
  mkdirSync(workspace);
  const profile = codexProfileSchema.parse({
    role: 'design',
    executor: 'codex-cli',
    provider: 'openai',
    model: 'gpt-6-luna',
    permission: 'read-only',
    native: { reasoningEffort: 'low' },
    timeoutMs: 5_000,
  });
  const config: Config = {
    ...defaultConfig(),
    profiles: {
      design: profile,
      implement: {
        ...profile,
        role: 'implement',
        permission: 'workspace-write',
      },
      review: { ...profile, role: 'review' },
    },
  };
  const task = f.tasks.create({ ...request(), repo: workspace, config });
  const run = new Runs(f.tasks).claim(
    task.id,
    `codex-cli/${testedCodexVersion}`,
  )!;
  const execution: ExecutionRequest = {
    schemaVersion: 1,
    task: f.tasks.get(task.id),
    run,
    workspace: { path: workspace, kind: 'repository' },
    decisions: [],
    artifacts: [],
  };
  return {
    ...f,
    workspace,
    execution,
    next: (): ExecutionRequest => ({
      ...execution,
      run: { ...run, id: randomUUID(), owner: randomUUID(), attempt: 2 },
    }),
  };
}
