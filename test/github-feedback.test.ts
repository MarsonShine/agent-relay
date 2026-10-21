import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryFixture } from './github-helpers.ts';
import { Feedback } from '../src/github/feedback.ts';
import type { TestContext } from 'node:test';
async function setup(t: TestContext) {
  const f = await deliveryFixture(t);
  f.db.sql
    .prepare(
      "UPDATE tasks SET document=json_set(document,'$.config.allowedFiles',json('[\"value.txt\"]')) WHERE id=?",
    )
    .run(f.task.id);
  const intent = f.deliveries.prepare(f.tasks.get(f.task.id), 'a'.repeat(40));
  f.deliveries.saveIntent({
    ...intent,
    push: 'settled',
    pull: 'settled',
    pr: 3,
  });
  f.deliveries.save({
    ...f.deliveries.get(f.task.id)!,
    status: 'watching',
    polls: 2,
  });
  const add = (id: number, data: Record<string, unknown>, actor = 20) => {
    f.db.sql.prepare('INSERT INTO github_inbox VALUES(?,?,?,?)').run(
      f.task.id,
      String(id),
      JSON.stringify({
        id,
        updated_at: '2026-01-01',
        body:
          '/relay ' +
          JSON.stringify({
            kind: 'requirement',
            requirementVersion: 1,
            revision: f.task.codeRevision,
            files: ['value.txt'],
            text: 'Add a documented empty-input example',
            ...data,
          }),
        user: { id: actor, login: 'owner' },
      }),
      'pending',
    );
  };
  return { ...f, intent, add, feedback: new Feedback(f.deliveries) };
}
test('authorized requirement feedback versions the goal and preserves all cumulative limits', async (t) => {
  const f = await setup(t);
  f.add(1, {});
  f.feedback.consume(f.task.id);
  const task = f.tasks.get(f.task.id);
  assert.equal(task.requirementVersion, 2);
  assert.equal(task.stage, 'triage');
  assert.equal(task.status, 'queued');
  assert.equal(task.deadlineAt, f.task.deadlineAt);
  assert.equal(task.runsUsed, f.task.runsUsed);
  assert.equal(task.iterationsUsed, 1);
  assert.equal(f.deliveries.get(task.id)?.polls, 2);
  assert.equal(f.tasks.requirements(task.id).length, 2);
  assert.equal(f.feedback.poller.inbox(task.id)[0]?.disposition, 'applied');
  f.feedback.consume(task.id);
  assert.equal(f.tasks.decisions(task.id).length, 1);
});
test('untrusted, stale, out-of-scope and executable fields cannot authorize repair', async (t) => {
  const f = await setup(t);
  f.add(1, {}, 21);
  f.add(2, { revision: 'c'.repeat(40) });
  f.add(3, { files: ['secret.txt'] });
  f.add(4, { command: 'anything' });
  f.feedback.consume(f.task.id);
  assert.deepEqual(
    f.feedback.poller.inbox(f.task.id).map((x) => x.disposition),
    ['untrusted', 'stale', 'out-of-scope', 'invalid'],
  );
  assert.equal(f.tasks.get(f.task.id).status, 'succeeded');
});
for (const kind of ['implementation', 'design'])
  test(`${kind} repair stays on current requirement and consumes shared iteration budget`, async (t) => {
    const f = await setup(t);
    f.add(1, { kind });
    f.feedback.consume(f.task.id);
    const task = f.tasks.get(f.task.id);
    assert.equal(task.stage, kind === 'design' ? 'design' : 'implement');
    assert.equal(task.requirementVersion, 1);
    assert.equal(task.iterationsUsed, 1);
  });
test('exhausted repair budget rolls back inbox application and never resets counters', async (t) => {
  const f = await setup(t);
  f.add(1, {});
  f.db.sql
    .prepare(
      "UPDATE tasks SET document=json_set(document,'$.iterationsUsed',3) WHERE id=?",
    )
    .run(f.task.id);
  assert.throws(() => f.feedback.consume(f.task.id), /original budgets/);
  assert.equal(f.tasks.decisions(f.task.id).length, 0);
  assert.equal(f.feedback.poller.inbox(f.task.id)[0]?.disposition, 'pending');
});
test('reopening after polling an edited comment consumes its latest pending version, preserving history', async (t) => {
  const f = await setup(t);
  f.add(1, { text: 'old request' });
  const row = f.db.sql
    .prepare('SELECT document FROM github_inbox WHERE task_id=?')
    .get(f.task.id)!;
  const comment = JSON.parse(String(row.document));
  comment.updated_at = '2026-01-02';
  const data = JSON.parse(comment.body.slice(7));
  data.text = `latest request quoting ${f.intent.marker}`;
  comment.body = '/relay ' + JSON.stringify(data);
  f.db.sql
    .prepare('INSERT INTO github_inbox VALUES(?,?,?,?)')
    .run(f.task.id, 'edited', JSON.stringify(comment), 'pending');
  new Feedback(f.deliveries).consume(f.task.id);
  assert.match(
    f.tasks.decisions(f.task.id)[0]!.answer,
    /latest request quoting/,
  );
  assert.deepEqual(
    f.feedback.poller.inbox(f.task.id).map((e) => e.disposition),
    ['superseded', 'applied'],
  );
});
