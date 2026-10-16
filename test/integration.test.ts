import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fixture, request } from './helpers.ts';
import { defaultConfig } from '../src/core/config.ts';
import { taskSchema } from '../src/core/contracts.ts';
import { callLocal } from '../src/service/client.ts';

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.kill('SIGKILL');
  await closed;
}
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await delay(50);
  }
  throw new Error(
    'condition did not become true within the bounded test window',
  );
}
function subprocess(t: TestContext, args: string[]) {
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => stop(child));
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`test child exited ${code}: ${errors}`)),
    );
  });
  // Crash tests deliberately kill their service; retain the rejection for explicit callers.
  void done.catch(() => {});
  return { child, done, output: () => output, errors: () => errors };
}

test(
  'separate OS processes race for one durable claim',
  { timeout: 20_000 },
  async (t) => {
    const { tasks, path } = fixture(t);
    const task = tasks.create(request());
    const first = subprocess(t, [
      resolve('test/fixtures/claim-worker.ts'),
      path,
      task.id,
    ]);
    const second = subprocess(t, [
      resolve('test/fixtures/claim-worker.ts'),
      path,
      task.id,
    ]);
    await until(
      async () => [first.output(), second.output()],
      (outputs) => outputs.every((text) => text.startsWith('ready\n')),
    );
    first.child.stdin.end('go');
    second.child.stdin.end('go');
    await Promise.all([first.done, second.done]);
    const results = [first, second].map((worker) =>
      JSON.parse(worker.output().trim().split('\n')[1]!),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(tasks.get(task.id).runsUsed, 1);
  },
);

test(
  'built CLI service completes work and preserves idempotency across restart',
  { timeout: 20_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-built-'));
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) await stop(child);
      rmSync(directory, { recursive: true, force: true });
    });
    const start = async (first: boolean) => {
      const process = subprocess(t, [
        resolve('dist/cli.js'),
        'serve',
        '--data-dir',
        directory,
        ...(first ? ['--port', '0'] : []),
      ]);
      children.push(process.child);
      await until(
        async () => process.output(),
        (text) => text.includes('listening'),
      );
      return process;
    };
    const first = await start(true);
    const input = {
      schemaVersion: 1,
      requestKey: 'restart-key',
      repo: directory,
      input: 'simulate',
    };
    const created = taskSchema.parse(
      (await callLocal(directory, '/v1/tasks', input)).task,
    );
    const status = await until(
      () => callLocal(directory, `/v1/tasks/${created.id}`),
      (value) => value.accepted === true,
    );
    assert.equal(taskSchema.parse(status.task).runsUsed, 1);
    await stop(first.child);
    await start(false);
    const replay = taskSchema.parse(
      (await callLocal(directory, '/v1/tasks', input)).task,
    );
    assert.equal(replay.id, created.id);
    assert.equal(replay.runsUsed, 1);
    assert.equal(
      (await callLocal(directory, `/v1/tasks/${created.id}`)).accepted,
      true,
    );
  },
);

test(
  'service crash with active fake execution quarantines the lease after restart',
  { timeout: 20_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-crash-'));
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) await stop(child);
      await delay(2200);
      rmSync(directory, { recursive: true, force: true });
    });
    const config = defaultConfig();
    config.leaseMs = 1000;
    config.profiles.design.native.delayMs = 2000;
    const configFile = join(directory, 'config.json');
    writeFileSync(configFile, JSON.stringify(config));
    const start = async (first: boolean) => {
      const child = subprocess(t, [
        resolve('dist/cli.js'),
        'serve',
        '--data-dir',
        directory,
        '--config',
        configFile,
        ...(first ? ['--port', '0'] : []),
      ]);
      children.push(child.child);
      await until(
        async () => child.output(),
        (text) => text.includes('listening'),
      );
      return child;
    };
    const first = await start(true);
    const input = {
      schemaVersion: 1,
      requestKey: 'crash-key',
      repo: directory,
      input: 'simulate',
    };
    const task = taskSchema.parse(
      (await callLocal(directory, '/v1/tasks', input)).task,
    );
    await until(
      () => callLocal(directory, `/v1/tasks/${task.id}/events`),
      (value) =>
        (value.events as { type: string }[]).some(
          (event) => event.type === 'started',
        ),
    );
    await stop(first.child);
    await start(false);
    const recovered = await until(
      () => callLocal(directory, `/v1/tasks/${task.id}`),
      (value) => taskSchema.parse(value.task).status === 'recovering',
    );
    assert.equal(taskSchema.parse(recovered.task).runsUsed, 1);
    const second = taskSchema.parse(
      (
        await callLocal(directory, '/v1/tasks', {
          ...input,
          requestKey: 'next-key',
        })
      ).task,
    );
    await delay(300);
    assert.equal(
      taskSchema.parse(
        (await callLocal(directory, `/v1/tasks/${second.id}`)).task,
      ).runsUsed,
      0,
    );
    assert.equal((await callLocal(directory, '/v1/health')).outstandingRuns, 1);
  },
);
