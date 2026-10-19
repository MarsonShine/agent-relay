import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Workspaces } from '../src/workspace/manager.ts';
import { GitWorktrees } from '../src/workspace/git.ts';
import type { Workspace } from '../src/workspace/contracts.ts';
import { git, workspaceFixture } from './workspace-helpers.ts';

test('implementation worktree preserves dirty source and pins the recorded baseline', async (t) => {
  const { repo, revision, task, manager } = workspaceFixture(t);
  writeFileSync(join(repo, 'value.txt'), 'user changes\n');
  writeFileSync(join(repo, 'untracked.txt'), 'user file\n');
  const before = git(repo, 'status', '--porcelain');
  const workspace = await manager.prepare(task.id, 'implementation');
  assert.equal(workspace.state, 'ready');
  assert.equal(workspace.baselineRevision, revision);
  assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), revision);
  assert.equal(
    readFileSync(join(workspace.path, 'value.txt'), 'utf8'),
    'baseline\n',
  );
  assert.equal(
    readFileSync(join(workspace.path, 'AGENTS.md'), 'utf8'),
    'Preserve the fixture contract.\n',
  );
  assert.equal(git(repo, 'status', '--porcelain'), before);
  assert.ok(workspace.branch?.startsWith('codex/'));
  assert.equal(
    (await manager.prepare(task.id, 'implementation')).id,
    workspace.id,
  );
});

test('review snapshot is detached and fixed while implementation advances', async (t) => {
  const { task, tasks, db, manager, repo, revision } = workspaceFixture(t);
  const implementation = await manager.prepare(task.id, 'implementation');
  writeFileSync(join(implementation.path, 'value.txt'), 'candidate\n');
  git(implementation.path, 'add', 'value.txt');
  git(implementation.path, 'commit', '-qm', 'candidate');
  const candidate = git(implementation.path, 'rev-parse', 'HEAD');
  db.transaction(() =>
    tasks.save(tasks.get(task.id), {
      ...tasks.get(task.id),
      codeRevision: candidate,
    }),
  );
  const review = await manager.prepare(task.id, 'review');
  assert.equal(review.revision, candidate);
  assert.equal(review.branch, null);
  assert.equal(git(review.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  writeFileSync(join(implementation.path, 'value.txt'), 'later\n');
  git(implementation.path, 'add', 'value.txt');
  git(implementation.path, 'commit', '-qm', 'later');
  assert.equal(
    readFileSync(join(review.path, 'value.txt'), 'utf8'),
    'candidate\n',
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), revision);
  git(review.path, 'update-index', '--assume-unchanged', 'value.txt');
  writeFileSync(join(review.path, 'value.txt'), 'tampered behind index flag\n');
  assert.equal(git(review.path, 'status', '--porcelain'), '');
  assert.equal((await manager.inspect(review.id)).consistent, false);
  writeFileSync(join(review.path, 'ignored.tmp'), 'tamper');
  assert.equal((await manager.inspect(review.id)).consistent, false);
});

test('consultation uses the clean repository without creating a branch or worktree', async (t) => {
  const { manager, task, repo } = workspaceFixture(t);
  const before = git(repo, 'worktree', 'list', '--porcelain');
  const workspace = await manager.prepare(task.id, 'repository');
  assert.equal(workspace.path, await realpath(repo));
  assert.equal(workspace.branch, null);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain'), before);
});

test('two connections cannot create duplicate implementation worktrees', async (t) => {
  const { manager, task, path, root, repo } = workspaceFixture(t);
  const otherDb = new Database(path);
  try {
    const results = await Promise.allSettled([
      manager.prepare(task.id, 'implementation'),
      new Workspaces(new Tasks(otherDb), root).prepare(
        task.id,
        'implementation',
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(manager.list(task.id).length, 1);
    assert.equal((await manager.git.listed(repo)).length, 2);
  } finally {
    otherDb.close();
  }
});

test('successful Git creation followed by failure remains pending and is never replayed', async (t) => {
  const { tasks, task, root, repo } = workspaceFixture(t);
  class InterruptedGit extends GitWorktrees {
    override async create(workspace: Workspace) {
      await super.create(workspace);
      throw new Error('injected interruption after Git');
    }
  }
  const interrupted = new Workspaces(tasks, root, new InterruptedGit());
  await assert.rejects(
    interrupted.prepare(task.id, 'implementation'),
    /injected/,
  );
  const workspace = interrupted.list(task.id)[0]!;
  assert.equal(workspace.state, 'creating');
  assert.equal((await interrupted.inspect(workspace.id)).consistent, true);
  await assert.rejects(
    new Workspaces(tasks, root).prepare(task.id, 'implementation'),
    /not be replayed/,
  );
  assert.equal((await interrupted.git.listed(repo)).length, 2);
});

test('cleanup refuses dirty files, requires terminal state and retains branch history', async (t) => {
  const { task, tasks, manager, repo } = workspaceFixture(t);
  const workspace = await manager.prepare(task.id, 'implementation');
  await assert.rejects(manager.remove(workspace.id), /terminal/);
  tasks.command(task.id, {
    action: 'cancel',
    expectedVersion: tasks.get(task.id).version,
  });
  writeFileSync(join(workspace.path, 'ignored.tmp'), 'preserve me');
  await assert.rejects(manager.remove(workspace.id), /preserved/);
  assert.ok(existsSync(workspace.path));
  assert.equal(manager.get(workspace.id).state, 'ready');
  // A separate clean task proves removal without deleting the dirty workspace.
  const another = tasks.create({
    schemaVersion: 1,
    requestKey: randomUUID(),
    repo,
    input: 'cleanup fixture',
    codeRevision: task.codeRevision,
    config: task.config,
  });
  const clean = await manager.prepare(another.id, 'implementation');
  tasks.command(another.id, {
    action: 'cancel',
    expectedVersion: another.version,
  });
  assert.equal((await manager.remove(clean.id)).state, 'removed');
  assert.equal(existsSync(clean.path), false);
  assert.equal(git(repo, 'rev-parse', clean.branch!), task.codeRevision);
});

test('path and policy preflights fail before touching the original checkout', async (t) => {
  const { repo, tasks, task, root, manager } = workspaceFixture(t);
  const unsafe = join(repo, 'not-created');
  await assert.rejects(
    new Workspaces(tasks, unsafe).prepare(task.id, 'implementation'),
    /separate/,
  );
  assert.equal(existsSync(unsafe), false);
  writeFileSync(join(repo, 'AGENTS.md'), 'uncommitted policy\n');
  await assert.rejects(
    manager.prepare(task.id, 'implementation'),
    /instructions/,
  );
  assert.equal(manager.list(task.id).length, 0);
  assert.equal(existsSync(root), false);
});

test('checkout hooks and filters are rejected without running them', async (t) => {
  const { repo, manager, task } = workspaceFixture(t);
  writeFileSync(
    join(repo, '.git', 'hooks', 'post-checkout'),
    '#!/bin/sh\necho unsafe\n',
  );
  await assert.rejects(
    manager.prepare(task.id, 'implementation'),
    /post-checkout/,
  );
  const separate = workspaceFixture(t);
  writeFileSync(join(separate.repo, '.gitattributes'), '*.txt filter=unsafe\n');
  git(separate.repo, 'add', '.gitattributes');
  git(separate.repo, 'commit', '-qm', 'filter');
  separate.db.transaction(() =>
    separate.tasks.save(separate.task, {
      ...separate.task,
      codeRevision: git(separate.repo, 'rev-parse', 'HEAD'),
    }),
  );
  await assert.rejects(
    separate.manager.prepare(separate.task.id, 'implementation'),
    /filters/,
  );
});

test('dirty filter attributes and pre-existing branches cannot bypass checkout admission', async (t) => {
  const first = workspaceFixture(t);
  writeFileSync(join(first.repo, '.gitattributes'), '*.txt filter=untrusted\n');
  await assert.rejects(
    first.manager.prepare(first.task.id, 'implementation'),
    /filters/,
  );
  assert.equal(first.manager.list(first.task.id).length, 0);
  const second = workspaceFixture(t);
  const branch = `codex/task-${second.task.id}`;
  git(second.repo, 'branch', branch);
  await assert.rejects(
    second.manager.prepare(second.task.id, 'implementation'),
    /Git worktree failed/,
  );
  assert.equal(git(second.repo, 'rev-parse', branch), second.revision);
  assert.equal((await second.manager.git.listed(second.repo)).length, 1);
});
