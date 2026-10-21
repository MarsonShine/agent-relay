import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './helpers.ts';
import {
  controllerTool,
  resolveControllerTool,
} from '../src/runtime/controller-tools.ts';
import { GitWorktrees } from '../src/workspace/git.ts';

test('controller Git ignores benign target-cwd executable shadow on Windows and Linux', async (t) => {
  const { directory } = fixture(t),
    target = join(directory, 'target');
  mkdirSync(target);
  if (process.platform === 'win32')
    copyFileSync(
      join(process.env.SYSTEMROOT!, 'System32', 'cmd.exe'),
      join(target, 'git.exe'),
    );
  else {
    writeFileSync(
      join(target, 'git'),
      '#!/bin/sh\necho controlled-shadow-selected\n',
    );
    chmodSync(join(target, 'git'), 0o755);
  }
  const git = controllerTool('git', [target]);
  assert.ok(isAbsolute(git));
  assert.match(
    execFileSync(git, ['--version'], {
      cwd: target,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    }),
    /^git version /,
  );
  assert.match(
    await new GitWorktrees().command(target, ['--version']),
    /^git version /,
  );
  const path = process.env.PATH ?? process.env.Path ?? '';
  assert.equal(
    resolveControllerTool('git', `.${delimiter}${target}${delimiter}${path}`, [
      target,
    ]),
    git,
  );
  assert.throws(
    () => resolveControllerTool('git', `.${delimiter}${target}`, [target]),
    /trusted absolute/,
  );
});
test('credential tool resolution rejects cwd and relative PATH without executing any credential operation', (t) => {
  const { directory } = fixture(t),
    trusted = join(directory, 'trusted'),
    target = join(directory, 'target');
  mkdirSync(trusted);
  mkdirSync(target);
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  copyFileSync(process.execPath, join(trusted, name));
  copyFileSync(process.execPath, join(target, name));
  assert.equal(
    resolveControllerTool(
      'gh',
      `.${delimiter}${target}${delimiter}${trusted}`,
      [target],
    ),
    join(trusted, name),
  );
  assert.throws(
    () =>
      resolveControllerTool('gh', `relative${delimiter}${target}`, [target]),
    /trusted absolute/,
  );
});
