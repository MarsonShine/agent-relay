import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeExecutor } from '../src/adapters/fake.ts';
import { Runs } from '../src/storage/runs.ts';
import { fixture, request } from './helpers.ts';
import type { AgentEvent } from '../src/core/execution.ts';

for (const scenario of [
  'success',
  'failure',
  'missing-terminal',
  'duplicate',
  'input',
] as const) {
  test(`fake process exposes ${scenario} without a model call`, async (t) => {
    const { tasks } = fixture(t);
    const input = request();
    input.config.profiles.design.native.scenario = scenario;
    const task = tasks.create(input);
    const run = new Runs(tasks).claim(task.id, 'fake-v1')!;
    const executor = new FakeExecutor();
    const handle = await executor.start({
      schemaVersion: 1,
      task,
      run,
      artifacts: [],
      decisions: [],
    });
    const events: AgentEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.result;
    assert.equal(
      result.status,
      scenario === 'failure'
        ? 'failed'
        : scenario === 'missing-terminal'
          ? 'unknown'
          : scenario === 'input'
            ? 'input_required'
            : 'completed',
    );
    assert.equal(result.stopped, true);
    assert.equal(await executor.reconcile(run), 'stopped');
    if (scenario === 'duplicate')
      assert.equal(
        events.filter((event) => event.key === 'progress').length,
        2,
      );
    if (scenario === 'input') assert.ok(result.question);
  });
}

test('cancellation confirms fake process exit; a new adapter cannot guess its identity', async (t) => {
  const { tasks } = fixture(t);
  const input = request();
  input.config.profiles.design.native.scenario = 'slow';
  const task = tasks.create(input);
  const run = new Runs(tasks).claim(task.id, 'fake-v1')!;
  const executor = new FakeExecutor();
  const handle = await executor.start({
    schemaVersion: 1,
    task,
    run,
    artifacts: [],
    decisions: [],
  });
  for await (const event of handle.events) {
    if (event.type === 'started')
      assert.equal(await executor.cancel(run), 'stopped');
  }
  assert.equal((await handle.result).status, 'cancelled');
  assert.equal(await new FakeExecutor().reconcile(run), 'unknown');
  await assert.rejects(
    executor.continue(
      { schemaVersion: 1, task, run, artifacts: [], decisions: [] },
      'opaque',
    ),
    /does not support/,
  );
});

test('finite timeout stops a silent fake process', async (t) => {
  const { tasks } = fixture(t);
  const input = request();
  input.config.profiles.design.native.scenario = 'slow';
  input.config.profiles.design.timeoutMs = 500;
  const task = tasks.create(input);
  const run = new Runs(tasks).claim(task.id, 'fake-v1')!;
  const handle = await new FakeExecutor().start({
    schemaVersion: 1,
    task,
    run,
    artifacts: [],
    decisions: [],
  });
  for await (const _event of handle.events) {
    /* consume stream */
  }
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.stopped, true);
  assert.equal(result.diagnostic, 'execution timeout');
});
