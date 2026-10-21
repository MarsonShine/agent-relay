import { BoundedProcess } from '../src/runtime/process.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixture } from './helpers.ts';
import {
  OwnedProcess,
  stopOwned,
  receipt,
  publish,
} from '../src/runtime/owned-process.ts';

test('owned process preserves output and durable stop proof independently of its client', async (t) => {
  const f = fixture(t),
    path = join(f.directory, 'owned'),
    owner = randomUUID();
  const chunks: Buffer[] = [];
  const child = new OwnedProcess(
    path,
    owner,
    { executable: process.execPath },
    ['-e', 'console.log("proof")'],
    {
      cwd: f.directory,
      env: process.env,
      input: '',
      timeoutMs: 5000,
      maxBytes: 4096,
      stdout: (b) => chunks.push(b),
      stderr: () => {},
    },
  );
  assert.equal((await child.done).stopped, true);
  assert.equal(Buffer.concat(chunks).toString().trim(), 'proof');
  assert.equal(receipt(path, owner)?.stopped, true);
  assert.equal(receipt(path, randomUUID()), null);
  assert.equal(await stopOwned(path, owner), 'stopped');
  assert.throws(
    () =>
      new OwnedProcess(path, owner, { executable: process.execPath }, [], {
        cwd: f.directory,
        env: {},
        input: '',
        timeoutMs: 1000,
        maxBytes: 1,
        stdout: () => {},
        stderr: () => {},
      }),
    /EEXIST/,
  );
});

test('restart stop uses the guardian and arrests actual file side effects', async (t) => {
  const f = fixture(t),
    path = join(f.directory, 'owned'),
    owner = randomUUID(),
    heartbeat = join(f.directory, 'heartbeat');
  const child = new OwnedProcess(
    path,
    owner,
    { executable: process.execPath },
    [
      '-e',
      `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`,
    ],
    {
      cwd: f.directory,
      env: process.env,
      input: '',
      timeoutMs: 10000,
      maxBytes: 4096,
      stdout: () => {},
      stderr: () => {},
    },
  );
  for (let i = 0; i < 200 && !existsSync(heartbeat); i++) await delay(25);
  assert.ok(existsSync(heartbeat));
  assert.equal(await stopOwned(path, owner), 'stopped');
  assert.equal((await child.done).stopped, true);
  const before = readFileSync(heartbeat, 'utf8');
  await delay(150);
  assert.equal(readFileSync(heartbeat, 'utf8'), before);
});

test('launch fence prevents delayed launch; missing or malformed owner proof stays unknown', async (t) => {
  const f = fixture(t),
    path = join(f.directory, 'fenced'),
    owner = randomUUID();
  assert.equal(await stopOwned(path, owner), 'stopped');
  assert.equal(readFileSync(join(path, 'gate'), 'utf8'), 'cancelled');
  const unknown = join(f.directory, 'unknown');
  mkdirSync(unknown);
  writeFileSync(join(unknown, 'gate'), owner);
  publish(join(unknown, 'exit.json'), {
    owner: randomUUID(),
    stopped: true,
    code: 0,
    reason: null,
  });
  assert.equal(await stopOwned(unknown, owner), 'unknown');
});

test('guardian startup consumes the deadline and reports timeout without launching the command', async (t) => {
  const f = fixture(t),
    directory = join(f.directory, 'expired'),
    owner = randomUUID(),
    effect = join(f.directory, 'must-not-exist');
  const child = new OwnedProcess(
    directory,
    owner,
    { executable: process.execPath },
    [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(effect)},'unexpected')`,
    ],
    {
      cwd: f.directory,
      env: process.env,
      input: '',
      timeoutMs: 1,
      maxBytes: 4096,
      stdout: () => {},
      stderr: () => {},
    },
  );
  const exit = await child.done;
  assert.equal(exit.stopped, true);
  assert.match(exit.reason!, /timeout/);
  assert.equal(existsSync(effect), false);
});

for (const input of ['', 'required payload']) {
  test(`closed stdin ${input ? 'rejects required input delivery' : 'does not invalidate an input-free command'}`, async (t) => {
    const f = fixture(t);
    const child = new BoundedProcess(
      { executable: process.execPath },
      [
        '-e',
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
      ],
      {
        cwd: f.directory,
        env: process.env,
        input,
        timeoutMs: 5000,
        maxBytes: 4096,
        stdout: () => {},
        stderr: () => {},
      },
    );
    // Reproduce the fast-exit pipe error independently of OS scheduling.
    child.child.stdin.emit(
      'error',
      Object.assign(new Error('closed pipe'), { code: 'EPIPE' }),
    );
    const exit = await child.done;
    assert.equal(exit.stopped, true);
    assert.equal(exit.code, 0);
    assert.equal(exit.reason, input ? 'process input failed' : null);
  });
}
