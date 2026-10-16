import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Controller } from '../src/workflow/controller.ts';
import { FakeExecutor } from '../src/adapters/fake.ts';
import { Evidence } from '../src/storage/evidence.ts';
import type {
  AgentEvent,
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '../src/core/execution.ts';
import { fixture, request } from './helpers.ts';

function setup(t: TestContext, executor: Executor = new FakeExecutor()) {
  const f = fixture(t);
  const evidence = new Evidence(f.tasks, join(f.directory, 'evidence'));
  return {
    ...f,
    evidence,
    controller: new Controller(f.tasks, evidence, executor),
  };
}
for (const scenario of [
  'success',
  'failure',
  'missing-terminal',
  'duplicate',
] as const) {
  test(`controller handles ${scenario} through the same executor contract`, async (t) => {
    const { tasks, evidence, controller } = setup(t);
    const input = request();
    input.config.profiles.design.native.scenario = scenario;
    const task = tasks.create(input);
    await controller.tick();
    await controller.wait();
    assert.equal(
      tasks.get(task.id).status,
      scenario === 'failure'
        ? 'failed'
        : scenario === 'missing-terminal'
          ? 'blocked'
          : 'succeeded',
    );
    if (scenario === 'duplicate')
      assert.equal(
        tasks.events(task.id).filter((e) => e.type === 'progress').length,
        1,
      );
    if (scenario === 'success')
      assert.ok(evidence.list(task.id).some((a) => a.kind === 'result'));
    assert.equal(controller.runs.outstanding().length, 0);
  });
}

test('waiting user consumes no further runs and answer starts a new evidence version', async (t) => {
  const { tasks, controller, evidence } = setup(t);
  const input = request();
  input.config.profiles.design.native.scenario = 'input';
  const task = tasks.create(input);
  await controller.tick();
  await controller.wait();
  const waiting = tasks.get(task.id);
  assert.equal(waiting.status, 'waiting_user');
  await controller.tick();
  assert.equal(tasks.get(task.id).runsUsed, 1);
  tasks.command(task.id, {
    action: 'answer',
    expectedVersion: waiting.version,
    questionId: waiting.question!.id,
    questionVersion: waiting.question!.version,
    answer: 'bounded scope',
  });
  await controller.tick();
  await controller.wait();
  assert.equal(tasks.get(task.id).status, 'succeeded');
  assert.deepEqual(
    evidence
      .list(task.id)
      .filter((a) => a.kind === 'result')
      .map((a) => a.evidence.requirementVersion),
    [2],
  );
});

test('active pause waits for exit and resume preserves consumed budget', async (t) => {
  const { tasks, controller } = setup(t);
  const input = request();
  input.config.profiles.design.native.scenario = 'slow';
  const task = tasks.create(input);
  await controller.tick();
  const running = tasks.get(task.id);
  const pending = tasks.command(task.id, {
    action: 'pause',
    expectedVersion: running.version,
  });
  assert.equal(pending.status, 'recovering');
  assert.throws(
    () =>
      tasks.command(task.id, {
        action: 'resume',
        expectedVersion: pending.version,
      }),
    /confirmed paused/,
  );
  await controller.tick();
  await controller.wait();
  const paused = tasks.get(task.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.runsUsed, 1);
  assert.equal(
    tasks.command(task.id, {
      action: 'resume',
      expectedVersion: paused.version,
    }).deadlineAt,
    task.deadlineAt,
  );
});

function replacement(
  change: (value: ExecutionResult) => ExecutionResult,
  options: { terminal?: boolean; unknownStop?: boolean } = {},
): Executor {
  return {
    id: 'fake',
    version: 'replacement-v1',
    capabilities: {
      continuation: false,
      cancellation: true,
      permissions: ['read-only'],
      structuredOutput: true,
      usage: false,
    },
    async start({ run }: ExecutionRequest) {
      const result: ExecutionResult = {
        schemaVersion: 1,
        status: 'completed',
        stopped: true,
        evidence: run.evidence,
        output: 'simulated evidence',
        question: null,
        continuation: null,
        diagnostic: null,
        usage: null,
      };
      return {
        events: (async function* () {
          if (options.terminal !== false)
            yield {
              schemaVersion: 1,
              key: 'done',
              type: 'completed',
              message: 'done',
            } satisfies AgentEvent;
        })(),
        result: Promise.resolve(change(result)),
      };
    },
    async continue() {
      throw new Error('unsupported');
    },
    async cancel() {
      return options.unknownStop ? 'unknown' : 'stopped';
    },
    async reconcile() {
      return 'unknown';
    },
  };
}

test('replacement executor cannot bypass terminal, artifact or evidence checks', async (t) => {
  const cases = [
    replacement((result) => result, { terminal: false }),
    replacement((result) => ({ ...result, output: '' })),
    replacement((result) => ({
      ...result,
      evidence: { ...result.evidence, requirementVersion: 99 },
    })),
    replacement((result) => ({
      ...result,
      evidence: { ...result.evidence, codeRevision: 'a'.repeat(40) },
    })),
  ];
  for (const executor of cases) {
    const { tasks, controller } = setup(t, executor);
    const task = tasks.create(request());
    await controller.tick();
    await controller.wait();
    assert.equal(tasks.get(task.id).status, 'blocked');
  }
});

test('unknown stop retains lease and prevents another task from being started', async (t) => {
  const executor = replacement((result) => ({ ...result, stopped: false }), {
    unknownStop: true,
  });
  const { tasks, controller } = setup(t, executor);
  const first = tasks.create(request());
  const second = tasks.create(request());
  await controller.tick();
  await controller.wait();
  await controller.tick();
  assert.equal(tasks.get(first.id).status, 'recovering');
  assert.equal(tasks.get(second.id).status, 'queued');
  assert.equal(tasks.get(second.id).runsUsed, 0);
});

test('persisted cancel wins when completion is already on its way', async (t) => {
  const { tasks, controller } = setup(
    t,
    replacement((result) => result),
  );
  const task = tasks.create(request());
  await controller.tick();
  tasks.command(task.id, {
    action: 'cancel',
    expectedVersion: tasks.get(task.id).version,
  });
  await controller.wait();
  assert.equal(tasks.get(task.id).status, 'cancelled');
});

test('artifact size failure cannot be reported as success', async (t) => {
  const { tasks, controller } = setup(
    t,
    replacement((result) => ({ ...result, output: 'x'.repeat(200) })),
  );
  const input = request();
  input.config.maxArtifactBytes = 100;
  const task = tasks.create(input);
  await controller.tick();
  await controller.wait();
  assert.equal(tasks.get(task.id).status, 'blocked');
  assert.match(tasks.get(task.id).diagnostic!, /size limit/);
});
