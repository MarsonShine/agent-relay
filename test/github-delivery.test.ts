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
