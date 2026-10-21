import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Runs } from '../src/storage/runs.ts';
import { Intents } from '../src/storage/intents.ts';
import { fixture, request } from './helpers.ts';

test('claim and intent are atomic; reopening preserves identity and does not replay abandoned work', (t) => {
  const { tasks, db, path } = fixture(t),
    task = tasks.create(request()),
    runs = new Runs(tasks);
  db.sql.exec(
    "CREATE TRIGGER fail_intent BEFORE INSERT ON execution_intents BEGIN SELECT RAISE(FAIL,'intent failure'); END",
  );
  assert.throws(() => runs.claim(task.id, 'fixture'), /intent failure/);
  assert.equal(tasks.get(task.id).runsUsed, 0);
  assert.equal(runs.outstanding().length, 0);
  db.sql.exec('DROP TRIGGER fail_intent');
  const run = runs.claim(task.id, 'fixture')!,
    intents = new Intents(tasks);
  assert.equal(intents.list(task.id)[0]?.state, 'prepared');
  assert.deepEqual(intents.list(task.id)[0]?.evidence, run.evidence);
  intents.prepare(
    run,
    'result',
    'result',
    run.evidence,
    '{"status":"completed"}',
  );
  const other = new Database(path);
  try {
    const restarted = new Tasks(other),
      recovery = new Runs(restarted);
    assert.equal(new Intents(restarted).list(task.id).length, 2);
    recovery.quarantine(run, 'service died before settlement');
    assert.equal(recovery.claim(task.id, 'fixture'), null);
    recovery.confirmStopped(run.id);
    assert.ok(
      new Intents(restarted)
        .list(task.id)
        .every((i) => i.state === 'abandoned'),
    );
    assert.equal(restarted.get(task.id).status, 'blocked');
    assert.equal(restarted.get(task.id).runsUsed, 1);
    assert.throws(
      () => new Intents(restarted).prepare(run, 'verification', 'late'),
      /ownership/,
    );
  } finally {
    other.close();
  }
});
