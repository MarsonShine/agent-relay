import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFixture } from './github-helpers.ts';
import { Publisher } from '../src/github/delivery.ts';
import { Deliveries } from '../src/github/delivery-store.ts';
import type { DeliveryIntent } from '../src/github/delivery-store.ts';
import type { Reply, Transport } from '../src/github/transport.ts';
import type { Push } from '../src/github/push.ts';

class Remote implements Transport, Push {
  head: string | null = null;
  pr: Record<string, unknown> | null = null;
  pushes = 0;
  creates = 0;
  losePush = false;
  losePR = false;
  intent!: DeliveryIntent;
  async request(path: string, method = 'GET', body?: unknown): Promise<Reply> {
    let data: unknown;
    if (path.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(path.split('/heads/')[1]!);
      const sha = branch === 'main' ? 'a'.repeat(40) : this.head;
      if (!sha) return { status: 404, headers: {}, body: {} };
      data = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
    } else if (method === 'POST') {
      this.creates++;
      const b = body as { body: string };
      this.pr = {
        number: 3,
        state: 'open',
        merged_at: null,
        body: b.body,
        head: {
          ref: this.intent.branch,
          sha: this.head,
          repo: { id: 10, full_name: 'owner/project' },
        },
        base: {
          ref: 'main',
          sha: 'a'.repeat(40),
          repo: { id: 10, full_name: 'owner/project' },
        },
        html_url: 'https://github.com/owner/project/pull/3',
      };
      if (this.losePR) throw new Error('receipt lost');
      data = this.pr;
    } else if (path.includes('/pulls?')) data = this.pr ? [this.pr] : [];
    else data = { id: 10, full_name: 'owner/project', archived: false };
    return { status: 200, headers: {}, body: data };
  }
  async send(intent: DeliveryIntent) {
    this.pushes++;
    this.head = intent.revision;
    if (this.losePush) throw new Error('receipt lost');
  }
  async stop(): Promise<'stopped'> {
    return 'stopped';
  }
}
for (const loss of ['none', 'push', 'pr'])
  test(`publication reconciles ${loss} receipt loss without duplicate effects`, async (t) => {
    const f = await deliveryFixture(t),
      remote = new Remote(),
      store = new Deliveries(f.tasks, remote);
    const publisher = new Publisher(store, remote, async () => 'fixture');
    remote.intent = await publisher.prepare(f.task);
    remote.losePush = loss === 'push';
    remote.losePR = loss === 'pr';
    await Promise.all([publisher.tick(), publisher.tick()]);
    assert.equal(store.get(f.task.id)?.status, 'watching');
    await publisher.tick();
    assert.equal(remote.pushes, 1);
    assert.equal(remote.creates, 1);
    assert.equal(
      store.intent(remote.intent.key).url,
      'https://github.com/owner/project/pull/3',
    );
  });
test('unknown push is reconciled without replay, and user remote changes block publication', async (t) => {
  const f = await deliveryFixture(t),
    remote = new Remote(),
    store = new Deliveries(f.tasks, remote);
  const publisher = new Publisher(store, remote, async () => 'fixture');
  remote.intent = await publisher.prepare(f.task);
  store.claim(remote.intent.key, 'push');
  await publisher.tick();
  assert.equal(store.get(f.task.id)?.status, 'blocked');
  assert.equal(remote.pushes, 0);
  assert.equal(remote.creates, 0);
  store.save({ ...store.get(f.task.id)!, status: 'pending' });
  remote.head = 'c'.repeat(40);
  await publisher.tick();
  assert.equal(store.get(f.task.id)?.status, 'blocked');
  assert.equal(remote.pushes, 0);
});
test('candidate acceptance failure prevents even preparing a publication intent', async (t) => {
  const f = await deliveryFixture(t),
    remote = new Remote(),
    store = new Deliveries(f.tasks, remote);
  const publisher = new Publisher(store, remote, async () => {
    throw new Error('dirty workspace');
  });
  await assert.rejects(publisher.prepare(f.task), /dirty workspace/);
  assert.equal(store.get(f.task.id), null);
});
test('update push settled remotely before crash reconciles the intended new PR head without replay', async (t) => {
  const f = await deliveryFixture(t),
    remote = new Remote(),
    store = new Deliveries(f.tasks, remote),
    publisher = new Publisher(store, remote, async () => 'fixture');
  remote.intent = await publisher.prepare(f.task);
  await publisher.tick();
  const task = f.db.transaction(() =>
    f.tasks.save(f.tasks.get(f.task.id), {
      ...f.tasks.get(f.task.id),
      codeRevision: 'c'.repeat(40),
    }),
  );
  store.save({ ...store.get(task.id)!, status: 'waiting_local' });
  remote.intent = await publisher.prepare(task);
  store.claim(remote.intent.key, 'push');
  remote.head = task.codeRevision;
  (remote.pr!.head as { sha: string }).sha = task.codeRevision!;
  await new Publisher(store, remote, async () => 'fixture').tick();
  assert.equal(store.get(task.id)?.status, 'watching');
  assert.equal(remote.pushes, 1);
  assert.equal(remote.creates, 1);
  assert.equal(store.intent(remote.intent.key).push, 'settled');
});
for (const change of ['closed', 'merged', 'deleted', 'foreign'])
  test(`existing ${change} remote state blocks an update`, async (t) => {
    const f = await deliveryFixture(t),
      remote = new Remote(),
      store = new Deliveries(f.tasks, remote),
      publisher = new Publisher(store, remote, async () => 'fixture');
    remote.intent = await publisher.prepare(f.task);
    await publisher.tick();
    const task = f.db.transaction(() =>
      f.tasks.save(f.tasks.get(f.task.id), {
        ...f.tasks.get(f.task.id),
        codeRevision: 'c'.repeat(40),
      }),
    );
    store.save({ ...store.get(task.id)!, status: 'waiting_local' });
    remote.intent = await publisher.prepare(task);
    if (change === 'closed') remote.pr!.state = 'closed';
    if (change === 'merged') remote.pr!.merged_at = '2026-01-01';
    if (change === 'deleted') remote.head = null;
    if (change === 'foreign') remote.head = 'd'.repeat(40);
    await publisher.tick();
    assert.equal(store.get(task.id)?.status, 'blocked');
    assert.equal(remote.pushes, 1);
    assert.equal(remote.creates, 1);
  });
test('cancellation during PR creation retains the receipt and forbids further publication', async (t) => {
  const f = await deliveryFixture(t),
    remote = new Remote(),
    store = new Deliveries(f.tasks, remote),
    publisher = new Publisher(store, remote, async () => 'fixture');
  remote.intent = await publisher.prepare(f.task);
  const original = remote.request.bind(remote);
  remote.request = async (path, method, body) => {
    const reply = await original(path, method, body);
    if (method === 'POST')
      store.save({ ...store.get(f.task.id)!, status: 'cancelled' });
    return reply;
  };
  await publisher.tick();
  assert.equal(store.get(f.task.id)?.status, 'cancelled');
  assert.equal(store.intent(remote.intent.key).pr, 3);
  await publisher.tick();
  assert.equal(remote.creates, 1);
});
test('unknown original push ownership never settles or starts a PR', async (t) => {
  const f = await deliveryFixture(t),
    remote = new Remote(),
    store = new Deliveries(f.tasks, remote);
  const publisher = new Publisher(
    store,
    { send: (i) => remote.send(i), stop: async () => 'unknown' },
    async () => 'fixture',
  );
  remote.intent = await publisher.prepare(f.task);
  store.claim(remote.intent.key, 'push');
  remote.head = remote.intent.revision;
  await publisher.tick();
  assert.equal(store.get(f.task.id)?.status, 'blocked');
  assert.equal(store.intent(remote.intent.key).push, 'dispatched');
  assert.equal(remote.creates, 0);
});
test('crash before PR receipt settlement recovers existing PR after reopening without another POST', async (t) => {
  const f = await deliveryFixture(t),
    remote = new Remote(),
    store = new Deliveries(f.tasks, remote),
    publisher = new Publisher(store, remote, async () => 'fixture');
  remote.intent = await publisher.prepare(f.task);
  const save = store.saveIntent.bind(store);
  let crash = true;
  store.saveIntent = (intent) => {
    if (crash && intent.pr) {
      crash = false;
      throw Error('simulated storage loss before settlement');
    }
    save(intent);
  };
  await publisher.tick();
  assert.equal(store.intent(remote.intent.key).pull, 'dispatched');
  assert.equal(remote.creates, 1);
  store.save({ ...store.get(f.task.id)!, status: 'pending' });
  const reopened = new Deliveries(f.tasks, remote);
  await new Publisher(reopened, remote, async () => 'fixture').tick();
  assert.equal(reopened.get(f.task.id)?.status, 'watching');
  assert.equal(remote.creates, 1);
});
