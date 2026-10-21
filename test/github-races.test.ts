import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubWorkflow } from '../src/github/workflow.ts';
import { deliveryFixture } from './github-helpers.ts';
import type { LocalWorkflow } from '../src/workflow/local.ts';
test('reconcile routes a newly accepted candidate from known-settled blocked delivery to preparation', async (t) => {
  const f = await deliveryFixture(t),
    intent = f.deliveries.prepare(f.task, 'a'.repeat(40));
  f.deliveries.saveIntent({
    ...intent,
    push: 'settled',
    pull: 'settled',
    pr: 3,
  });
  f.deliveries.save({ ...f.deliveries.get(f.task.id)!, status: 'blocked' });
  const task = f.db.transaction(() =>
    f.tasks.save(f.task, { ...f.task, codeRevision: 'c'.repeat(40) }),
  );
  const local = {
    async acceptance() {
      return [];
    },
    workspaces: {
      list() {
        return [{ kind: 'implementation', path: 'fixture' }];
      },
    },
  } as unknown as LocalWorkflow;
  const workflow = new GitHubWorkflow(
    f.deliveries,
    {
      async send() {
        throw Error('not dispatched');
      },
      async stop() {
        return 'stopped';
      },
    },
    local,
  );
  await workflow.command(task.id, {
    schemaVersion: 1,
    action: 'reconcile',
    expectedVersion: task.version,
  });
  assert.equal(f.deliveries.get(task.id)?.status, 'waiting_local');
  const next = f.deliveries.prepare(task, 'a'.repeat(40));
  assert.equal(next.expectedRemote, intent.revision);
  assert.equal(next.pr, 3);
});

for (const action of ['reconcile', 'waiting_local'])
  test(`cancellation fences delayed ${action} acceptance and no later side effects run`, async (t) => {
    const f = await deliveryFixture(t),
      intent = f.deliveries.prepare(f.task, 'a'.repeat(40));
    f.deliveries.save({
      ...f.deliveries.get(f.task.id)!,
      status: action === 'reconcile' ? 'blocked' : 'waiting_local',
    });
    let release!: () => void,
      arrived!: () => void,
      effects = 0;
    const ready = new Promise<void>((r) => {
      arrived = r;
    });
    const local = {
      async acceptance() {
        arrived();
        await new Promise<void>((r) => {
          release = r;
        });
        if (action === 'waiting_local') throw Error('cancelled while checking');
        return [];
      },
      workspaces: {
        list() {
          return [
            {
              kind: 'implementation',
              path: 'fixture',
              baselineRevision: 'a'.repeat(40),
            },
          ];
        },
      },
    } as unknown as LocalWorkflow;
    const workflow = new GitHubWorkflow(
      f.deliveries,
      {
        async send() {
          effects++;
        },
        async stop() {
          return 'stopped';
        },
      },
      local,
    );
    const pending =
      action === 'reconcile'
        ? workflow.command(f.task.id, {
            schemaVersion: 1,
            action: 'reconcile',
            expectedVersion: f.task.version,
          })
        : workflow.tick();
    await ready;
    await workflow.command(f.task.id, {
      schemaVersion: 1,
      action: 'cancel',
      expectedVersion: f.task.version,
    });
    release();
    if (action === 'reconcile')
      await assert.rejects(pending, /changed during reconciliation/);
    else await pending;
    await workflow.tick();
    assert.equal(f.deliveries.get(f.task.id)?.status, 'cancelled');
    assert.equal(effects, 0);
    assert.equal(f.deliveries.intent(intent.key).push, 'prepared');
  });
