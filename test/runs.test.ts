import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Runs } from '../src/storage/runs.ts';
import { fixture, request } from './helpers.ts';
const completed = {
  status: 'succeeded' as const,
  diagnostic: null,
  question: null,
  continuation: null,
};

test('independent connections cannot claim the same or another task concurrently', (t) => {
  const { tasks, path } = fixture(t);
  const first = tasks.create(request());
  const second = tasks.create(request());
  const runs = new Runs(tasks);
  const db2 = new Database(path);
  try {
    const competitor = new Runs(new Tasks(db2));
    const run = runs.claim(first.id, 'fake-v1')!;
    assert.equal(competitor.claim(first.id, 'fake-v1'), null);
    assert.equal(competitor.claim(second.id, 'fake-v1'), null);
    assert.throws(() => runs.renew({ ...run, owner: randomUUID() }), /stale/);
    runs.finish(run, completed);
    assert.ok(competitor.claim(second.id, 'fake-v1'));
  } finally {
    db2.close();
  }
});

test('expired lease survives restart and cannot be reused before stop confirmation', (t) => {
  const { tasks, path } = fixture(t);
  const task = tasks.create(request(), 100);
  const run = new Runs(tasks).claim(task.id, 'fake-v1', 101)!;
  const db2 = new Database(path);
  try {
    const reopenedTasks = new Tasks(db2);
    const reopenedRuns = new Runs(reopenedTasks);
    reopenedRuns.expire(run.leaseUntil);
    assert.equal(reopenedTasks.get(task.id).status, 'recovering');
    assert.equal(reopenedRuns.claim(task.id, 'fake-v1'), null);
    assert.throws(() => reopenedRuns.finish(run, completed), /stale/);
    const recovering = reopenedTasks.get(task.id);
    reopenedTasks.command(task.id, {
      action: 'pause',
      expectedVersion: recovering.version,
    });
    const paused = reopenedRuns.confirmStopped(run.id);
    assert.equal(paused.status, 'paused');
    const resumed = reopenedTasks.command(task.id, {
      action: 'resume',
      expectedVersion: paused.version,
    });
    assert.equal(resumed.runsUsed, 1);
    assert.equal(resumed.deadlineAt, task.deadlineAt);
    assert.equal(reopenedRuns.claim(task.id, 'fake-v1', task.deadlineAt), null);
    assert.equal(reopenedTasks.get(task.id).status, 'blocked');
  } finally {
    db2.close();
  }
});

test('cancel intent wins a late success and duplicate events are idempotent', (t) => {
  const { tasks } = fixture(t);
  const task = tasks.create(request());
  const runs = new Runs(tasks);
  const run = runs.claim(task.id, 'fake-v1')!;
  const event = {
    schemaVersion: 1 as const,
    key: 'one',
    type: 'progress' as const,
    message: 'working',
  };
  runs.record(run, event);
  runs.record(run, event);
  assert.equal(
    tasks.events(task.id).filter((e) => e.type === 'progress').length,
    1,
  );
  assert.throws(
    () => runs.record(run, { ...event, message: 'changed' }),
    /different content/,
  );
  tasks.command(task.id, {
    action: 'cancel',
    expectedVersion: tasks.get(task.id).version,
  });
  assert.equal(runs.finish(run, completed).status, 'cancelled');
  assert.equal(runs.outstanding().length, 0);
});

test('run budget cannot reset across a pause or new connection', (t) => {
  const { tasks } = fixture(t);
  const input = request();
  input.config.budget.maxRuns = 1;
  const task = tasks.create(input);
  const runs = new Runs(tasks);
  const run = runs.claim(task.id, 'fake-v1')!;
  tasks.command(task.id, {
    action: 'pause',
    expectedVersion: tasks.get(task.id).version,
  });
  const paused = runs.finish(run, completed);
  tasks.command(task.id, { action: 'resume', expectedVersion: paused.version });
  assert.equal(runs.claim(task.id, 'fake-v1'), null);
  assert.equal(tasks.get(task.id).status, 'blocked');
});

test('retry categories, backoff and total deadline survive reopen and requirement replacement', (t) => {
  const { tasks, path } = fixture(t);
  const input = request();
  input.config.budget.maxRuns = 10;
  input.config.budget.maxInfrastructureRetries = 1;
  input.config.budget.retryBaseMs = 100;
  const initial = tasks.create(input, 1000),
    runs = new Runs(tasks);
  const first = runs.claim(initial.id, 'fixture', 1001)!;
  const queued = runs.finish(
    first,
    { ...completed, status: 'failed', retry: 'infrastructure' },
    1002,
  );
  assert.equal(queued.infrastructureRetriesUsed, 1);
  assert.equal(queued.iterationsUsed, 0);
  assert.equal(queued.retryAt, 1102);
  assert.equal(runs.claim(initial.id, 'fixture', 1101), null);
  const other = new Database(path);
  try {
    const reopened = new Tasks(other),
      restarted = new Runs(reopened);
    assert.equal(reopened.get(initial.id).retryAt, 1102);
    const revised = reopened.command(initial.id, {
      action: 'revise',
      expectedVersion: queued.version,
      requirementVersion: 1,
      input: 'New requirement',
    });
    assert.equal(revised.infrastructureRetriesUsed, 1);
    assert.equal(revised.retryAt, 1102);
    assert.equal(revised.deadlineAt, initial.deadlineAt);
    const second = restarted.claim(initial.id, 'fixture', 1103)!;
    const semantic = restarted.finish(
      second,
      { ...completed, status: 'blocked', retry: 'semantic' },
      1104,
    );
    assert.equal(semantic.iterationsUsed, 1);
    assert.equal(semantic.infrastructureRetriesUsed, 1);
    const third = restarted.claim(initial.id, 'fixture', semantic.retryAt)!;
    const exhausted = restarted.finish(
      third,
      { ...completed, status: 'failed', retry: 'infrastructure' },
      semantic.retryAt + 1,
    );
    assert.equal(exhausted.status, 'blocked');
    assert.equal(exhausted.infrastructureRetriesUsed, 1);
    assert.equal(exhausted.runsUsed, 3);
  } finally {
    other.close();
  }
});

test('cancel overrides retry and exhausted absolute deadline cannot schedule another attempt', (t) => {
  const { tasks } = fixture(t),
    runs = new Runs(tasks);
  const initial = tasks.create(request(), 1000),
    first = runs.claim(initial.id, 'fixture', 1001)!;
  const running = tasks.get(initial.id);
  tasks.command(initial.id, {
    action: 'cancel',
    expectedVersion: running.version,
  });
  const cancelled = runs.finish(
    first,
    { ...completed, status: 'failed', retry: 'infrastructure' },
    1002,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.infrastructureRetriesUsed, 0);
  const second = tasks.create(request(), 1000);
  const run = runs.claim(second.id, 'fixture', second.deadlineAt - 10)!;
  const result = runs.finish(
    run,
    { ...completed, status: 'failed', retry: 'semantic' },
    second.deadlineAt - 5,
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.iterationsUsed, 0);
});
