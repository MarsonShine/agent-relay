import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { fixture, request } from './helpers.ts';

test('idempotent create and optimistic commands survive reopening', (t) => {
  const { tasks, path } = fixture(t);
  const input = request();
  const task = tasks.create(input);
  const reopened = new Database(path);
  try {
    const other = new Tasks(reopened);
    assert.deepEqual(other.create(input), task);
    assert.throws(
      () => other.create({ ...input, input: 'changed' }),
      /different input/,
    );
    const paused = other.command(task.id, {
      action: 'pause',
      expectedVersion: 1,
    });
    assert.equal(paused.status, 'paused');
    assert.throws(
      () => tasks.command(task.id, { action: 'resume', expectedVersion: 1 }),
      /version changed/,
    );
    const resumed = tasks.command(task.id, {
      action: 'resume',
      expectedVersion: paused.version,
    });
    assert.equal(resumed.deadlineAt, task.deadlineAt);
    assert.equal(tasks.events(task.id).length, 3);
    assert.equal(tasks.events(task.id, 1).length, 2);
    assert.throws(
      () =>
        tasks.command(task.id, {
          action: 'resume',
          expectedVersion: resumed.version,
        }),
      /confirmed paused/,
    );
    const cancelled = tasks.command(task.id, {
      action: 'cancel',
      expectedVersion: resumed.version,
    });
    assert.throws(
      () =>
        tasks.command(task.id, {
          action: 'resume',
          expectedVersion: cancelled.version,
        }),
      /terminal/,
    );
  } finally {
    reopened.close();
  }
});

test('illegal transitions and partial transactions do not persist', (t) => {
  const { tasks, db } = fixture(t);
  const task = tasks.create(request());
  assert.throws(
    () =>
      db.transaction(() => tasks.save(task, { ...task, status: 'succeeded' })),
    /illegal task transition/,
  );
  assert.throws(
    () =>
      db.transaction(() => {
        tasks.save(task, { ...task, status: 'paused' });
        tasks.append(task.id, null, 'rollback', 'test', 'rolled back');
        throw new Error('injected failure');
      }),
    /injected/,
  );
  assert.deepEqual(tasks.get(task.id), task);
  assert.equal(tasks.events(task.id).length, 1);
});

test('answers bind the current question and invalidate previous requirement evidence', (t) => {
  const { tasks, db } = fixture(t);
  const task = tasks.create(request());
  const question = { id: randomUUID(), version: 1, text: 'Choose scope' };
  const waiting = db.transaction(() => {
    const running = tasks.save(task, { ...task, status: 'running' });
    return tasks.save(running, {
      ...running,
      status: 'waiting_user',
      question,
    });
  });
  const answer = {
    action: 'answer' as const,
    expectedVersion: waiting.version,
    questionId: question.id,
    questionVersion: 1,
    answer: 'A',
  };
  assert.throws(
    () => tasks.command(task.id, { ...answer, questionVersion: 2 }),
    /current pending question/,
  );
  const answered = tasks.command(task.id, answer);
  assert.equal(answered.requirementVersion, 2);
  assert.equal(answered.status, 'queued');
  assert.equal(tasks.decisions(task.id)[0]?.answer, 'A');
  assert.throws(() => tasks.command(task.id, answer), /version changed/);
});

test('migration refuses a future database without rewriting it', (t) => {
  const { path } = fixture(t);
  const sql = new DatabaseSync(path);
  try {
    sql.exec('PRAGMA user_version=999');
    assert.throws(() => new Database(path), /newer than/);
    assert.equal(sql.prepare('PRAGMA user_version').get()?.user_version, 999);
  } finally {
    sql.close();
  }
});

test('older task database migrates without losing task and event history', (t) => {
  const { tasks, db, path } = fixture(t);
  const task = tasks.create(request());
  db.sql.exec(
    'DROP TABLE validations; DROP TABLE handoffs; DROP TABLE workspace_access; DROP TABLE workspaces; DROP TABLE artifacts; DROP TABLE runs; PRAGMA user_version=1',
  );
  const migrated = new Database(path);
  try {
    assert.deepEqual(new Tasks(migrated).get(task.id), task);
    assert.equal(new Tasks(migrated).events(task.id).length, 1);
    assert.equal(
      migrated.sql.prepare('PRAGMA user_version').get()?.user_version,
      6,
    );
    assert.ok(
      migrated.sql
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='one_outstanding_run'",
        )
        .get(),
    );
  } finally {
    migrated.close();
  }
});
