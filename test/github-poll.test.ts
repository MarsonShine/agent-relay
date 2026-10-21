import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryFixture, policy } from './github-helpers.ts';
import { classifyCI, Poller } from '../src/github/poll.ts';
import { GitHubApi } from '../src/github/api.ts';
import { Deliveries } from '../src/github/delivery-store.ts';
import type { Transport } from '../src/github/transport.ts';

const revision = 'b'.repeat(40);
const check = {
  id: 1,
  name: 'check',
  head_sha: revision,
  status: 'completed',
  conclusion: 'success',
  app: { id: 30 },
  check_suite: { id: 1 },
};
test('CI requires trusted current SHA and all latest suites; reruns never reuse stale success', () => {
  const classify = (checks: unknown[], statuses: unknown[] = []) =>
    classifyCI(checks, statuses, policy, revision).state;
  assert.equal(classify([check]), 'passed');
  assert.equal(classify([]), 'pending');
  assert.equal(classify([{ ...check, head_sha: 'a'.repeat(40) }]), 'pending');
  assert.equal(
    classify([check, { ...check, id: 2, status: 'queued', conclusion: null }]),
    'pending',
  );
  assert.equal(
    classify([
      { ...check, conclusion: 'failure' },
      { ...check, id: 2 },
    ]),
    'passed',
  );
  assert.equal(
    classify([
      check,
      { ...check, id: 2, conclusion: 'failure', check_suite: { id: 2 } },
    ]),
    'infrastructure',
  );
  assert.equal(
    classify([{ ...check, conclusion: 'cancelled' }]),
    'infrastructure',
  );
  assert.equal(
    classify([check], [{ context: 'check', state: 'pending' }]),
    'pending',
  );
});
test('page bounds and incomplete totals never return silently truncated evidence', async () => {
  const transport: Transport = {
    async request() {
      return {
        status: 200,
        body: [1],
        headers: { link: '<ignored>; rel="next"' },
      };
    },
  };
  await assert.rejects(
    new GitHubApi(transport, policy).pages('/items'),
    /pagination bound/,
  );
  transport.request = async () => ({
    status: 200,
    headers: {},
    body: { total_count: 2, check_runs: [check] },
  });
  await assert.rejects(
    new GitHubApi(transport, policy).pages('/items', 'check_runs'),
    /incomplete/,
  );
});
test('poll persists cursor/dedup edits, allows same actor, suppresses owned events and preserves counters', async (t) => {
  const f = await deliveryFixture(t);
  const intent = f.deliveries.prepare(f.task, 'a'.repeat(40));
  f.deliveries.saveIntent({
    ...intent,
    push: 'settled',
    pull: 'settled',
    pr: 3,
  });
  f.deliveries.save({ ...f.deliveries.get(f.task.id)!, status: 'watching' });
  f.db.sql
    .prepare('INSERT INTO github_own_events VALUES(?,?)')
    .run(f.task.id, 42);
  let body = `feedback quoting ${intent.marker}`,
    failPage = false;
  let holdStatus: (() => Promise<void>) | null = null;
  let failedCheck = false;
  const transport: Transport = {
    async request(path) {
      let value: unknown;
      if (path.endsWith('/pulls/3'))
        value = {
          number: 3,
          state: 'open',
          merged_at: null,
          body: intent.marker,
          head: {
            ref: intent.branch,
            sha: revision,
            repo: { id: 10, full_name: 'owner/project' },
          },
          base: {
            ref: 'main',
            sha: 'a'.repeat(40),
            repo: { id: 10, full_name: 'owner/project' },
          },
          html_url: 'https://github.com/owner/project/pull/3',
        };
      else if (path.includes('/git/ref/')) {
        const branch = decodeURIComponent(path.split('/heads/')[1]!);
        value = {
          ref: `refs/heads/${branch}`,
          object: {
            type: 'commit',
            sha: branch === 'main' ? 'a'.repeat(40) : revision,
          },
        };
      } else if (path.includes('/comments?')) {
        if (failPage) throw new Error('partial response');
        value = [
          {
            id: 41,
            updated_at: '2026-01-01',
            body,
            user: { id: 20, login: 'owner' },
          },
          {
            id: 42,
            updated_at: '2026-01-01',
            body: intent.marker,
            user: { id: 20, login: 'owner' },
          },
        ];
      } else if (path.includes('/check-runs?'))
        value = {
          total_count: 1,
          check_runs: [
            { ...check, conclusion: failedCheck ? 'failure' : 'success' },
          ],
        };
      else if (path.includes('/statuses?')) {
        const hold = holdStatus;
        holdStatus = null;
        await hold?.();
        value = [];
      } else value = { id: 10, full_name: 'owner/project', archived: false };
      return { status: 200, headers: { etag: 'fixture' }, body: value };
    },
  };
  const store = new Deliveries(f.tasks, transport),
    poll = new Poller(store);
  await poll.poll(f.task.id);
  assert.equal(poll.ci(f.task.id)?.state, 'passed');
  assert.deepEqual(
    poll.inbox(f.task.id).map((x) => x.disposition),
    ['pending', 'self'],
  );
  body = 'edited feedback';
  store.save({ ...store.get(f.task.id)!, nextPollAt: 0 });
  await new Poller(store).poll(f.task.id);
  assert.equal(poll.inbox(f.task.id).length, 3);
  assert.equal(poll.inbox(f.task.id)[0]?.disposition, 'superseded');
  assert.equal(store.get(f.task.id)?.polls, 2);
  failPage = true;
  store.save({ ...store.get(f.task.id)!, nextPollAt: 0 });
  await poll.poll(f.task.id);
  assert.equal(store.get(f.task.id)?.status, 'blocked');
  assert.equal(store.get(f.task.id)?.polls, 3);
  assert.equal(poll.inbox(f.task.id).length, 3);
  failPage = false;
  store.save({ ...store.get(f.task.id)!, status: 'watching', nextPollAt: 0 });
  let release!: () => void, arrived!: () => void;
  const waiting = new Promise<void>((r) => {
    arrived = r;
  });
  holdStatus = async () => {
    arrived();
    await new Promise<void>((r) => {
      release = r;
    });
  };
  const older = new Poller(store).poll(f.task.id);
  await waiting;
  failedCheck = true;
  store.save({ ...store.get(f.task.id)!, nextPollAt: 0 });
  await new Poller(store).poll(f.task.id);
  assert.equal(poll.ci(f.task.id)?.state, 'infrastructure');
  release();
  await older;
  assert.equal(
    poll.ci(f.task.id)?.state,
    'infrastructure',
    'older successful response cannot overwrite newer failed observation',
  );
});
