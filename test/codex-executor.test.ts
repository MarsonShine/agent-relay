import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { CodexExecutor } from '../src/adapters/codex/executor.ts';
import type {
  ExecutionRequest,
  ExecutionHandle,
} from '../src/core/execution.ts';
import { codexFixture } from './codex-helpers.ts';

function setup(t: TestContext, scenario: string) {
  const f = codexFixture(t);
  const directory = join(f.directory, 'executions');
  const executor = new CodexExecutor({
    directory,
    command: {
      executable: process.execPath,
      prefixArgs: [resolve('test/fixtures/fake-codex.ts'), scenario],
    },
  });
  return { ...f, directory, executor };
}
async function collect(handle: ExecutionHandle) {
  const events = [];
  for await (const event of handle.events) events.push(event);
  return { events, result: await handle.result };
}

test('adapter joins native termination, structured results and bound evidence before completing', async (t) => {
  const { executor, execution, directory } = setup(t, 'stderr');
  const { events, result } = await collect(await executor.start(execution));
  assert.equal(result.status, 'completed');
  assert.equal(result.stopped, true);
  assert.deepEqual(result.evidence, execution.run.evidence);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(await executor.reconcile(execution.run), 'stopped');
  const log = readFileSync(
    join(directory, execution.run.id, 'stderr.txt'),
    'utf8',
  );
  assert.ok(!log.includes('private-fixture-value'));
  const captured = JSON.parse(
    readFileSync(join(directory, execution.run.id, 'invocation.json'), 'utf8'),
  );
  assert.ok(captured.args.includes('gpt-6-luna'));
  assert.ok(!captured.args.includes(execution.task.input));
  await assert.rejects(executor.start(execution), /already started/);
});

for (const scenario of [
  'blocked',
  'missing-file',
  'invalid-json',
  'oversized-file',
  'stale',
  'empty',
  'missing-terminal',
  'malformed',
  'nonzero',
  'stderr-limit',
]) {
  test(`adapter cannot accept ${scenario}`, async (t) => {
    const { executor, execution } = setup(t, scenario);
    const { events, result } = await collect(await executor.start(execution));
    assert.notEqual(result.status, 'completed');
    assert.ok(!events.some((event) => event.type === 'completed'));
  });
}

test('explicit continuation reuses the bound session and rejects wrong identity', async (t) => {
  const { executor, execution, next, directory } = setup(t, 'success');
  const first = await collect(await executor.start(execution));
  const second = next();
  const result = await collect(
    await executor.continue(second, first.result.continuation!),
  );
  assert.equal(result.result.status, 'completed');
  const captured = JSON.parse(
    readFileSync(join(directory, second.run.id, 'invocation.json'), 'utf8'),
  );
  assert.ok(
    captured.args.includes('resume') && !captured.args.includes('--last'),
  );
  const wrong = new CodexExecutor({
    directory,
    command: {
      executable: process.execPath,
      prefixArgs: [resolve('test/fixtures/fake-codex.ts'), 'wrong-session'],
    },
  });
  const mismatch = await collect(
    await wrong.continue(next(), first.result.continuation!),
  );
  assert.notEqual(mismatch.result.status, 'completed');
  assert.equal(mismatch.result.continuation, null);
});

test('question outputs get a controller-owned ID and current requirement version', async (t) => {
  const { executor, execution } = setup(t, 'question');
  const { result } = await collect(await executor.start(execution));
  assert.equal(result.status, 'input_required');
  assert.equal(result.question?.version, execution.task.requirementVersion);
  assert.match(result.question!.id, /^[a-f0-9-]{36}$/);
});

test('cancellation kills the owned tool tree before reporting stopped', async (t) => {
  const { executor, execution, workspace } = setup(t, 'tree');
  const handle = await executor.start(execution);
  const completion = collect(handle);
  const heartbeat = join(workspace, 'heartbeat.json');
  for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await delay(20);
  assert.ok(existsSync(heartbeat));
  assert.equal(
    await executor.cancel({ ...execution.run, owner: 'unrelated-owner' }),
    'unknown',
  );
  assert.equal(await executor.cancel(execution.run), 'stopped');
  const before = readFileSync(heartbeat, 'utf8');
  await delay(150);
  assert.equal(readFileSync(heartbeat, 'utf8'), before);
  assert.throws(() => process.kill(JSON.parse(before).pid, 0));
  assert.equal((await completion).result.status, 'cancelled');
});

test('cancellation during preflight cannot launch a delayed writer', async (t) => {
  const { executor, execution, directory } = setup(t, 'delayed-version');
  const pending = executor.start(execution);
  assert.equal(await executor.cancel(execution.run), 'stopped');
  await assert.rejects(pending, /cancelled before process start/);
  assert.ok(!existsSync(join(directory, execution.run.id, 'invocation.json')));
});

test('finite deadline stops silent execution; unknown parent exit never implies completion', async (t) => {
  const f = setup(t, 'slow');
  f.execution.task.config.profiles.design.timeoutMs = 300;
  const request: ExecutionRequest = {
    ...f.execution,
    run: {
      ...f.execution.run,
      profile: { ...f.execution.run.profile, timeoutMs: 300 },
    },
  };
  const result = await collect(await f.executor.start(request));
  assert.notEqual(result.result.status, 'completed');
  assert.match(result.result.diagnostic!, /timeout/);
  const orphan = setup(t, 'orphan');
  orphan.execution.task.config.profiles.design.timeoutMs = 300;
  orphan.execution.run.profile.timeoutMs = 300;
  const uncertain = await collect(
    await orphan.executor.start(orphan.execution),
  );
  assert.notEqual(uncertain.result.status, 'completed');
  await delay(1400); // The bounded orphan fixture exits itself; no PID guessing.
});

test('unsupported versions, missing workspaces and original-checkout writes are rejected before launch', async (t) => {
  const { executor, execution, directory, workspace } = setup(
    t,
    'wrong-version',
  );
  await assert.rejects(
    executor.start(execution),
    /version has not been verified/,
  );
  assert.ok(!existsSync(directory));
  const writer = setup(t, 'success');
  const request = {
    ...writer.execution,
    run: {
      ...writer.execution.run,
      profile: writer.execution.task.config.profiles.implement,
    },
  };
  await assert.rejects(writer.executor.start(request), /isolated worktree/);
  assert.equal(
    await new CodexExecutor({
      directory,
      command: { executable: process.execPath },
    }).reconcile(execution.run),
    'unknown',
  );
  assert.ok(existsSync(workspace));
});

test('unsafe evidence locations and absent workspace declarations never launch a process', async (t) => {
  const { execution, workspace } = setup(t, 'success');
  const command = {
    executable: process.execPath,
    prefixArgs: [resolve('test/fixtures/fake-codex.ts'), 'success'],
  };
  const executor = new CodexExecutor({
    command,
    directory: join(workspace, 'unsafe-evidence'),
  });
  await assert.rejects(
    executor.start(execution),
    /outside the agent workspace/,
  );
  const { workspace: _workspace, ...undeclared } = execution;
  await assert.rejects(
    executor.start(undeclared),
    /controller-provided workspace/,
  );
});

test('path containment treats dot-prefixed children as inside the original checkout', async (t) => {
  const { execution, executor, workspace } = setup(t, 'success');
  const child = join(workspace, '..worktree');
  mkdirSync(child);
  const request = {
    ...execution,
    workspace: { path: child, kind: 'worktree' as const },
    run: {
      ...execution.run,
      profile: execution.task.config.profiles.implement,
    },
  };
  await assert.rejects(executor.start(request), /isolated worktree/);
});

test('run cannot expand the task frozen permission profile', async (t) => {
  const { executor, execution, workspace } = setup(t, 'success');
  const task = structuredClone(execution.task);
  task.config.profiles.implement.permission = 'read-only';
  const request = {
    ...execution,
    task,
    run: {
      ...execution.run,
      profile: execution.task.config.profiles.implement,
    },
    workspace: { path: workspace, kind: 'worktree' as const },
  };
  await assert.rejects(executor.start(request), /frozen profile/);
});
