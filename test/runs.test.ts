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
