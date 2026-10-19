import { rm, realpath } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Workspaces } from '../src/workspace/manager.ts';
import { defaultConfig } from '../src/core/config.ts';
import { randomUUID } from 'node:crypto';

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}
export function workspaceFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-workspaces-'));
  const repo = join(directory, 'source 中文 space'),
    root = join(directory, 'managed');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Preserve the fixture contract.\n');
  writeFileSync(join(repo, 'value.txt'), 'baseline\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.tmp\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'baseline');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const path = join(directory, 'state.db'),
    db = new Database(path),
    tasks = new Tasks(db);
  const config = defaultConfig();
  config.leaseMs = 60000;
  config.budget.maxTaskMs = 180000;
  const task = tasks.create({
    schemaVersion: 1,
    requestKey: randomUUID(),
    repo,
    input: 'fixture task',
    codeRevision: revision,
    config,
  });
  const manager = new Workspaces(tasks, root);
  t.after(async () => {
    db.close();
    const target = await realpath(directory);
    if (
      dirname(target) !== (await realpath(tmpdir())) ||
      !basename(target).startsWith('relay-workspaces-')
    )
      throw new Error('invalid fixture cleanup path');
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  return { directory, repo, root, revision, path, db, tasks, task, manager };
}
