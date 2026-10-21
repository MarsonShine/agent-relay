import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request } from './helpers.ts';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Runs } from '../src/storage/runs.ts';
import { randomUUID } from 'node:crypto';
test('explicit run-budget amendment preserves counters, deadline, evidence and exact approval across reopen', (t) => {
  const f = fixture(t),
    created = f.tasks.create(request());
  const before = f.db.transaction(() =>
    f.tasks.save(created, {
      ...created,
      status: 'paused',
      runsUsed: 3,
      iterationsUsed: 2,
      infrastructureRetriesUsed: 1,
    }),
  );
  const approval = 'Explicit human approval: increase only maxRuns to 6.';
  const after = f.tasks.command(before.id, {
    action: 'budget',
    expectedVersion: before.version,
    maxRuns: 6,
    approval,
  });
  assert.deepEqual(
    { ...after, version: before.version, config: before.config },
    before,
  );
  assert.deepEqual(after.config, {
    ...before.config,
    budget: { ...before.config.budget, maxRuns: 6 },
  });
  const db = new Database(f.path);
  try {
    const tasks = new Tasks(db);
    assert.deepEqual(tasks.get(after.id), after);
    const audit = tasks.budgetChanges(after.id)[0]!;
    assert.equal(audit.approval, approval);
    assert.deepEqual(audit.previousBudget, before.config.budget);
    assert.equal(audit.runsUsed, 3);
    assert.equal(audit.deadlineAt, before.deadlineAt);
  } finally {
    db.close();
  }
  assert.throws(
    () =>
      f.tasks.command(after.id, {
        action: 'budget',
        expectedVersion: before.version,
        maxRuns: 7,
        approval,
      }),
    /version changed/,
  );
});
test('budget amendment cannot change deadlines, lower limits, or bypass active/unknown ownership', (t) => {
  const f = fixture(t),
    task = f.tasks.create(request());
  assert.throws(
    () =>
      f.tasks.command(task.id, {
        action: 'budget',
        expectedVersion: task.version,
        maxRuns: 4,
        approval: 'approval',
      }),
    /strictly higher/,
  );
  const runs = new Runs(f.tasks),
    run = runs.claim(task.id, 'fixture')!;
  assert.throws(
    () =>
      f.tasks.command(task.id, {
        action: 'budget',
        expectedVersion: f.tasks.get(task.id).version,
        maxRuns: 6,
        approval: 'approval',
      }),
    /stopped ownership/,
  );
  runs.expire(run.leaseUntil);
  assert.throws(
    () =>
      f.tasks.command(task.id, {
        action: 'budget',
        expectedVersion: f.tasks.get(task.id).version,
        maxRuns: 6,
        approval: 'approval',
      }),
    /stopped ownership/,
  );
  const expired = f.tasks.create(request(), Date.now() - 120000);
  assert.throws(
    () =>
      f.tasks.command(expired.id, {
        action: 'budget',
        expectedVersion: expired.version,
        maxRuns: 6,
        approval: 'approval',
      }),
    /original time/,
  );
  assert.equal(f.tasks.get(task.id).config.budget.maxRuns, 4);
});

test('typed private budget audit keeps exact approval while sanitized display remains parseable', (t) => {
  const f = fixture(t),
    task = f.tasks.create(request()),
    secret = `fixture-${randomUUID()}`;
  const approval = `Approve "six" runs; password="${secret}"; preserve deadline.\nQuoted: "unchanged".`;
  const after = f.tasks.command(task.id, {
    action: 'budget',
    expectedVersion: task.version,
    maxRuns: 6,
    approval,
  });
  const raw = JSON.parse(
    String(
      f.db.sql
        .prepare('SELECT document FROM budget_amendments WHERE task_id=?')
        .get(task.id)!.document,
    ),
  );
  assert.equal(raw.approval, approval);
  const displayed = JSON.parse(
    JSON.stringify(f.tasks.budgetChanges(task.id)),
  )[0];
  assert.ok(!JSON.stringify(displayed).includes(secret));
  assert.equal(displayed.previousBudget.maxRuns, 4);
  assert.equal(displayed.budget.maxRuns, 6);
  assert.equal(displayed.runsUsed, 0);
  assert.equal(displayed.deadlineAt, task.deadlineAt);
  assert.equal(displayed.taskVersion, after.version);
  assert.ok(!f.tasks.events(task.id).some((e) => e.payload.includes(secret)));
});
