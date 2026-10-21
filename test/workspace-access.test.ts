import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { Profile } from '../src/core/config.ts';
import type { Run } from '../src/core/contracts.ts';
import type {
  AgentEvent,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '../src/core/execution.ts';
import { executionRequestSchema } from '../src/core/execution.ts';
import { CodexExecutor } from '../src/adapters/codex/executor.ts';
import { FakeExecutor } from '../src/adapters/fake.ts';
import { Database } from '../src/storage/database.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { Runs } from '../src/storage/runs.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Controller } from '../src/workflow/controller.ts';
import { WorkspaceAccess } from '../src/workspace/access.ts';
import { WorkspaceExecutor } from '../src/workspace/executor.ts';
import { Workspaces } from '../src/workspace/manager.ts';
import { workspaceFixture, git } from './workspace-helpers.ts';

const completed = {
  status: 'succeeded' as const,
  diagnostic: null,
  question: null,
  continuation: null,
};
type Fixture = ReturnType<typeof workspaceFixture>;
function claim(
  f: Fixture,
  role: Profile['role'] = 'design',
  write = false,
  executorVersion = 'fake-v1',
): Run {
  const task = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(task, {
      ...task,
      config: {
        ...task.config,
        profiles: {
          ...task.config.profiles,
          [role]: write
            ? {
                role,
                executor: 'codex-cli',
                provider: 'openai',
                model: 'gpt-6-luna',
                permission: 'workspace-write',
                native: { reasoningEffort: 'low' },
                timeoutMs: 60000,
              }
            : { ...task.config.profiles[role], timeoutMs: 60000 },
        },
      },
    }),
  );
  return new Runs(f.tasks).claim(task.id, executorVersion, Date.now(), role)!;
}
function request(f: Fixture, run: Run): ExecutionRequest {
  return {
    schemaVersion: 1,
    task: f.tasks.get(run.taskId),
    run,
    artifacts: [],
    decisions: [],
  };
}
function occupied(f: Fixture): number {
  return Number(
    f.db.sql.prepare('SELECT count(*) AS n FROM workspace_access').get()!.n,
  );
}
class ProbeExecutor implements Executor {
  readonly id: string;
  readonly version = 'fake-v1';
  readonly capabilities = {
    continuation: true,
    cancellation: true,
    permissions: ['read-only', 'workspace-write'],
    structuredOutput: true,
    usage: false,
  };
  constructor(id = 'fake') {
    this.id = id;
  }
  async cancel(): Promise<'stopped' | 'unknown'> {
    return this.seen ? 'stopped' : 'unknown';
  }
  async reconcile(): Promise<'active' | 'stopped' | 'unknown'> {
    return this.seen ? 'stopped' : 'unknown';
  }
  seen: ExecutionRequest | null = null;
  reference: string | null = null;
  terminals: AgentEvent['type'][] = ['completed'];
  effect: (r: ExecutionRequest) => void = () => {};
  async start(r: ExecutionRequest): Promise<ExecutionHandle> {
    this.seen = r;
    this.effect(r);
    const events: AgentEvent[] = this.terminals.map((type, index) => ({
      schemaVersion: 1,
      key: `terminal-${index}`,
      type,
      message: 'fixture',
    }));
    const result: ExecutionResult = {
      schemaVersion: 1,
      status: 'completed',
      stopped: true,
      evidence: r.run.evidence,
      output: 'fixture output',
      question: null,
      continuation: null,
      diagnostic: null,
      usage: null,
    };
    return {
      events: (async function* () {
        yield* events;
      })(),
      result: Promise.resolve(result),
    };
  }
  async continue(
    r: ExecutionRequest,
    reference: string,
  ): Promise<ExecutionHandle> {
    this.reference = reference;
    return this.start(r);
  }
}
async function consume(handle: ExecutionHandle) {
  const events: AgentEvent[] = [];
  const [, result] = await Promise.all([
    (async () => {
      for await (const e of handle.events) events.push(e);
    })(),
    handle.result,
  ]);
  return { events, result };
}

test('writer ownership is exclusive across connections and survives expiry until confirmed stop', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f, 'implement', true);
  const access = new WorkspaceAccess(f.manager);
  const lease = await access.acquire(run, 'implementation');
  assert.equal(access.declaration(lease).access, 'workspace-write');
  const db2 = new Database(f.path);
  try {
    const tasks = new Tasks(db2),
      runs = new Runs(tasks);
    const competitor = new WorkspaceAccess(new Workspaces(tasks, f.root));
    await assert.rejects(
      competitor.acquire({ ...run, owner: randomUUID() }, 'implementation'),
      /active owner/,
    );
    await assert.rejects(competitor.acquire(run, 'implementation'), /UNIQUE/);
    assert.equal(occupied(f), 1);
    runs.expire(run.leaseUntil);
    await assert.rejects(
      competitor.acquire(run, 'implementation'),
      /active owner/,
    );
    await assert.rejects(access.validate(lease), /active owner/);
    assert.equal(f.manager.get(lease.workspace.id).state, 'ready');
    assert.equal(occupied(f), 1);
    runs.confirmStopped(run.id);
    assert.equal(occupied(f), 0);
    assert.equal(tasks.get(run.taskId).status, 'blocked');
  } finally {
    db2.close();
  }
});

test('review requires read-only permission and never grants access to stale evidence', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f, 'review');
  const access = new WorkspaceAccess(f.manager);
  await assert.rejects(access.acquire(run, 'implementation'), /permission/);
  await assert.rejects(
    access.acquire(
      { ...run, evidence: { ...run.evidence, requirementVersion: 2 } },
      'review',
    ),
    /active owner/,
  );
  const lease = await access.acquire(run, 'review');
  assert.equal(access.declaration(lease).access, 'read-only');
  assert.equal(
    git(lease.workspace.path, 'rev-parse', 'HEAD'),
    run.evidence.codeRevision,
  );
  assert.throws(() =>
    executionRequestSchema.parse({
      ...request(f, run),
      workspace: { ...access.declaration(lease), access: 'workspace-write' },
    }),
  );
  new Runs(f.tasks).finish(run, completed);
  assert.equal(occupied(f), 0);
  await assert.rejects(access.validate(lease), /active owner/);
});

test('execution uses registered paths, permits implementation commits, and retains ownership until settlement', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f, 'implement', true);
  const backend = new ProbeExecutor('codex-cli'),
    executor = new WorkspaceExecutor(backend, f.manager);
  backend.effect = (r) => {
    writeFileSync(join(r.workspace!.path, 'value.txt'), 'implemented\n');
    git(r.workspace!.path, 'add', 'value.txt');
    git(r.workspace!.path, 'commit', '-qm', 'implementation fixture');
  };
  const { result, events } = await consume(
    await executor.start({
      ...request(f, run),
      workspace: { path: f.repo, kind: 'worktree' },
    }),
  );
  assert.equal(result.status, 'completed');
  assert.equal(events.at(-1)!.type, 'completed');
  assert.notEqual(backend.seen!.workspace!.path, f.repo);
  assert.equal(backend.seen!.workspace!.revision, f.revision);
  assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'baseline\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.revision);
  assert.equal(occupied(f), 1);
  await assert.rejects(executor.start(request(f, run)), /already reserved/);
  new Runs(f.tasks).finish(run, completed);
  assert.equal(occupied(f), 0);
});

test('review tampering suppresses completion and quarantines the snapshot despite unchanged Git HEAD', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f, 'review');
  const backend = new ProbeExecutor(),
    executor = new WorkspaceExecutor(backend, f.manager);
  backend.effect = (r) =>
    writeFileSync(join(r.workspace!.path, 'value.txt'), 'tampered\n');
  const { result, events } = await consume(
    await executor.start(request(f, run)),
  );
  assert.equal(result.status, 'unknown');
  assert.equal(result.stopped, true);
  assert.equal(result.output, null);
  assert.equal(
    events.some((e) => e.type === 'completed'),
    false,
  );
  assert.equal(f.manager.list(run.taskId)[0]!.state, 'tainted');
  assert.equal(occupied(f), 1);
  const runs = new Runs(f.tasks);
  runs.quarantine(run, 'fixture snapshot changed');
  runs.confirmStopped(run.id);
  assert.equal(occupied(f), 0);
  await assert.rejects(
    f.manager.prepare(run.taskId, 'review'),
    /reconciliation/,
  );
});

test('cancel during asynchronous workspace preparation prevents any late backend launch', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f);
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.manager.prepare.bind(f.manager);
  f.manager.prepare = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  const backend = new ProbeExecutor(),
    executor = new WorkspaceExecutor(backend, f.manager);
  const pending = executor.start(request(f, run));
  const rejected = assert.rejects(pending, /active owner|cancelled/);
  await entry;
  assert.equal(
    await executor.cancel({ ...run, owner: randomUUID() }),
    'unknown',
  );
  assert.equal(await executor.cancel(run), 'stopped');
  new Runs(f.tasks).finish(run, { ...completed, status: 'blocked' });
  release();
  await rejected;
  assert.equal(backend.seen, null);
  assert.equal(occupied(f), 0);
  assert.equal(await executor.reconcile(run), 'stopped');
  assert.equal(
    await new WorkspaceExecutor(backend, f.manager).reconcile(run),
    'unknown',
  );
});

test('continuation preserves workspace checks without synthesizing missing terminal evidence', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f, 'review');
  const backend = new ProbeExecutor(),
    executor = new WorkspaceExecutor(backend, f.manager);
  backend.terminals = [];
  const { result, events } = await consume(
    await executor.continue(request(f, run), 'fixture-reference'),
  );
  assert.equal(result.status, 'completed');
  assert.equal(events.length, 0);
  assert.equal(backend.reference, 'fixture-reference');
  assert.equal(backend.seen!.workspace!.access, 'read-only');
});

test('controller settles protected consultation and atomically releases access without making a branch', async (t) => {
  const f = workspaceFixture(t);
  const task = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(task, {
      ...task,
      config: {
        ...task.config,
        profiles: {
          ...task.config.profiles,
          design: { ...task.config.profiles.design, timeoutMs: 60000 },
        },
      },
    }),
  );
  const controller = new Controller(
    f.tasks,
    new Evidence(f.tasks, join(f.directory, 'evidence')),
    new WorkspaceExecutor(new FakeExecutor(), f.manager),
  );
  await controller.tick();
  await controller.wait();
  assert.equal(f.tasks.get(task.id).status, 'succeeded');
  assert.equal(occupied(f), 0);
  assert.equal(f.manager.list(task.id)[0]!.kind, 'repository');
  assert.equal((await f.manager.git.listed(f.repo)).length, 1);
});

test('early backend failure ignores late events and retains uncertain process ownership', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = new ProbeExecutor();
  backend.start = async () => ({
    events: (async function* (): AsyncGenerator<AgentEvent> {
      await gate;
      yield {
        schemaVersion: 1,
        key: 'late',
        type: 'completed',
        message: 'late result',
      };
    })(),
    result: Promise.reject(new Error('fixture early failure')),
  });
  backend.cancel = async () => 'unknown';
  const executor = new WorkspaceExecutor(backend, f.manager);
  const { result, events } = await consume(
    await executor.start(request(f, run)),
  );
  assert.equal(result.status, 'unknown');
  assert.equal(result.stopped, false);
  assert.equal(events.length, 0);
  const runs = new Runs(f.tasks);
  runs.quarantine(run, 'fixture stop unknown');
  assert.equal(occupied(f), 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await executor.reconcile(run), 'unknown');
  assert.equal(occupied(f), 1);
});

test('mismatched backend is rejected before reserving or creating a workspace', async (t) => {
  const f = workspaceFixture(t),
    run = claim(f, 'implement', true);
  const executor = new WorkspaceExecutor(new FakeExecutor(), f.manager);
  await assert.rejects(executor.start(request(f, run)), /frozen run profile/);
  assert.equal(occupied(f), 0);
  assert.equal(f.manager.list(run.taskId).length, 0);
});

test('registered implementation worktree reaches Codex adapter through a fake CLI process', async (t) => {
  const f = workspaceFixture(t),
    directory = join(f.directory, 'executions');
  const backend = new CodexExecutor({
    directory,
    protectedPaths: [directory],
    command: {
      executable: process.execPath,
      prefixArgs: [resolve('test/fixtures/fake-codex.ts'), 'success'],
    },
  });
  const run = claim(f, 'implement', true, backend.version);
  const executor = new WorkspaceExecutor(backend, f.manager);
  const { events, result } = await consume(
    await executor.start(request(f, run)),
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.stopped, true);
  assert.equal(events.at(-1)!.type, 'completed');
  const invocation = JSON.parse(
    readFileSync(join(directory, run.id, 'invocation.json'), 'utf8'),
  );
  const args = invocation.args as string[];
  assert.ok(invocation.temporaryDirectory.includes('run-temp'));
  assert.ok(
    !invocation.temporaryDirectory.startsWith(
      f.manager.list(run.taskId)[0]!.path,
    ),
  );
  assert.ok(args.includes('features.multi_agent=false'));
  assert.ok(
    args.some(
      (a) =>
        a.startsWith('permissions.relay=') &&
        a.includes(JSON.stringify(invocation.temporaryDirectory)),
    ),
  );
  assert.equal(
    args[args.indexOf('-C') + 1],
    f.manager.list(run.taskId)[0]!.path,
  );
  assert.ok(args.includes('default_permissions="relay"'));
  assert.deepEqual(result.evidence, run.evidence);
  assert.equal(await executor.reconcile(run), 'stopped');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  new Runs(f.tasks).finish(run, completed);
  assert.equal(occupied(f), 0);
});

test('slow workspace preparation hands the backend the renewed lease, not the expired claim snapshot', async (t) => {
  const f = workspaceFixture(t),
    task = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(task, { ...task, config: { ...task.config, leaseMs: 1000 } }),
  );
  const run = claim(f),
    runs = new Runs(f.tasks),
    backend = new ProbeExecutor();
  const timer = setInterval(() => runs.renew(run), 200);
  try {
    backend.effect = (r) => {
      assert.ok(
        Date.now() > run.leaseUntil,
        'fixture preparation must cross initial expiry',
      );
      assert.ok(r.run.leaseUntil > Date.now());
      assert.equal(r.run.owner, run.owner);
      assert.deepEqual(r.run.evidence, run.evidence);
    };
    const executor = new WorkspaceExecutor(backend, f.manager);
    const prepare = f.manager.prepare.bind(f.manager);
    f.manager.prepare = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return prepare(...args);
    };
    const result = await consume(await executor.start(request(f, run)));
    assert.equal(result.result.status, 'completed');
    runs.finish(run, completed);
  } finally {
    clearInterval(timer);
  }
});
