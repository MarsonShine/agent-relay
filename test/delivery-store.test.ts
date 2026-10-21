import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFixture } from './github-helpers.ts';
import { Deliveries } from '../src/github/delivery-store.ts';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';

test('delivery intents bind source/version/SHA and claim each external side effect once across reopen', async (t) => {
  const f = await deliveryFixture(t),
    intent = f.deliveries.prepare(f.task, 'a'.repeat(40));
  assert.equal(f.deliveries.prepare(f.task, 'a'.repeat(40)).key, intent.key);
  assert.equal(intent.expectedRemote, null);
  assert.equal(f.deliveries.claim(intent.key, 'push')?.push, 'dispatched');
  const db = new Database(f.path);
  try {
    const reopened = new Deliveries(new Tasks(db), f.transport);
    assert.equal(reopened.claim(intent.key, 'push'), null);
    assert.equal(
      reopened.intent(intent.key).sourceVersion,
      f.deliveries.sources.get(f.task.id)?.sourceVersion,
    );
  } finally {
    db.close();
  }
});
test('superseded requirement, cancellation and missing publish authority fence dispatch', async (t) => {
  const f = await deliveryFixture(t),
    intent = f.deliveries.prepare(f.task, 'a'.repeat(40));
  f.db.sql
    .prepare(
      "UPDATE tasks SET document=json_set(document,'$.requirementVersion',2) WHERE id=?",
    )
    .run(f.task.id);
  assert.throws(() => f.deliveries.claim(intent.key, 'push'), /no longer owns/);
  f.db.sql
    .prepare(
      "UPDATE tasks SET document=json_set(document,'$.requirementVersion',1) WHERE id=?",
    )
    .run(f.task.id);
  f.deliveries.save({ ...f.deliveries.get(f.task.id)!, status: 'cancelled' });
  assert.throws(() => f.deliveries.claim(intent.key, 'push'), /no longer owns/);
  f.db.sql
    .prepare(
      "UPDATE github_sources SET document=json_set(document,'$.policy.publish',json('false')) WHERE task_id=?",
    )
    .run(f.task.id);
  assert.throws(
    () => f.deliveries.prepare(f.task, 'a'.repeat(40)),
    /publish permission/,
  );
});
