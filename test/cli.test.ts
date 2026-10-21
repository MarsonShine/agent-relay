import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startService } from '../src/service/server.ts';
import { defaultConfig } from '../src/core/config.ts';
const execute = promisify(execFile);

test('CLI create/status/events/pause/resume/cancel use authenticated versioned requests', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-cli-'));
  const service = await startService({
    directory,
    port: 0,
    autoSchedule: false,
  });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input = join(directory, 'input.txt');
  writeFileSync(input, 'simulation');
  const cli = async (...args: string[]) => {
    const result = await execute(
      process.execPath,
      [resolve('src/cli.ts'), ...args, '--data-dir', directory],
      { windowsHide: true, timeout: 10_000 },
    );
    return JSON.parse(result.stdout);
  };
  const created = await cli(
    'task',
    'create',
    '--repo',
    directory,
    '--input',
    input,
    '--key',
    'stable-key',
  );
  const task = created.task;
  assert.equal(
    (
      await cli(
        'task',
        'create',
        '--repo',
        directory,
        '--input',
        input,
        '--key',
        'stable-key',
      )
    ).task.id,
    task.id,
  );
  assert.equal((await cli('doctor')).backend, 'simulation');
  assert.equal((await cli('task', 'status', task.id)).task.status, 'queued');
  const paused = await cli(
    'task',
    'pause',
    task.id,
    '--version',
    String(task.version),
  );
  assert.equal(paused.task.status, 'paused');
  await assert.rejects(
    cli('task', 'resume', task.id, '--version', String(task.version)),
    /version changed/,
  );
  const resumed = await cli(
    'task',
    'resume',
    task.id,
    '--version',
    String(paused.task.version),
  );
  const cancelled = await cli(
    'task',
    'cancel',
    task.id,
    '--version',
    String(resumed.task.version),
  );
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(
    (await cli('task', 'events', task.id, '--limit', '2')).events.length,
    2,
  );
  await assert.rejects(cli('task', 'status', task.id, '--extra', 'bad'));
});

test('CLI answers the current question and exposes persisted simulation evidence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-cli-answer-'));
  const config = defaultConfig();
  config.profiles.design.native.scenario = 'input';
  const service = await startService({
    directory,
    port: 0,
    config,
    autoSchedule: false,
  });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'answer.txt');
  writeFileSync(file, 'scope A');
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await execute(
          process.execPath,
          [resolve('src/cli.ts'), ...args, '--data-dir', directory],
          { windowsHide: true, timeout: 10_000 },
        )
      ).stdout,
    );
  const { task } = await cli(
    'task',
    'create',
    '--repo',
    directory,
    '--input',
    file,
    '--key',
    'answer-key',
  );
  await service.controller.tick();
  await service.controller.wait();
  const { task: waiting } = await cli('task', 'status', task.id);
  const answer = [
    'task',
    'answer',
    task.id,
    '--version',
    String(waiting.version),
    '--question',
    waiting.question.id,
    '--question-version',
    String(waiting.question.version),
    '--input',
    file,
  ];
  await cli(...answer);
  await assert.rejects(cli(...answer), /version changed/);
  await service.controller.tick();
  await service.controller.wait();
  const result = await cli('task', 'status', task.id);
  assert.equal(result.accepted, true);
  assert.equal(result.task.requirementVersion, 2);
});

test('CLI budget amendment is authenticated, versioned and preserves the original deadline', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-budget-cli-'));
  const service = await startService({
    directory,
    port: 0,
    autoSchedule: false,
  });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = service.tasks.create({
    schemaVersion: 1,
    requestKey: 'budget-cli',
    repo: directory,
    input: 'simulation',
    codeRevision: null,
    config: defaultConfig(),
  });
  const approval = join(directory, 'approval.txt');
  writeFileSync(approval, 'Explicit operator approval for maxRuns 6.');
  const args = [
    resolve('src/cli.ts'),
    'task',
    'budget',
    task.id,
    '--version',
    String(task.version),
    '--max-runs',
    '6',
    '--input',
    approval,
    '--data-dir',
    directory,
  ];
  const response = JSON.parse(
    (
      await execute(process.execPath, args, {
        windowsHide: true,
        timeout: 10000,
      })
    ).stdout,
  );
  assert.equal(response.task.config.budget.maxRuns, 6);
  assert.equal(response.task.deadlineAt, task.deadlineAt);
  assert.equal(response.task.runsUsed, 0);
  assert.equal(
    service.tasks.budgetChanges(task.id)[0]!.approval,
    'Explicit operator approval for maxRuns 6.',
  );
  await assert.rejects(
    execute(process.execPath, args, { windowsHide: true, timeout: 10000 }),
    /version changed/,
  );
});
