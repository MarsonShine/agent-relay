import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from './process-probe.mts';

test('partial chunks, unknown events and UTF-8 preserve the completed stream', async () => {
  const code = `const b=Buffer.from('{"type":"future.event","text":"中文"}\\n{"type":"turn.completed","usage":{}}\\n');process.stdout.write(b.subarray(0,31));setTimeout(()=>process.stdout.write(b.subarray(31)),50)`;
  const result = await probe(process.execPath, ['-e', code], { cwd: process.cwd() });
  assert.equal(result.outcome, 'turn_completed');
  assert.equal(result.events[0].text, '中文');
});

test('zero exit without terminal and truncated output require reconciliation', async () => {
  for (const code of ['', 'process.stdout.write(\'{"type":"turn.completed"}\')']) {
    const result = await probe(process.execPath, ['-e', code], { cwd: process.cwd() });
    assert.equal(result.outcome, 'needs_reconciliation');
  }
});

test('nonzero exit cannot be hidden by a completed event', async () => {
  const result = await probe(process.execPath, ['-e',
    'console.log(JSON.stringify({type:"turn.completed"}));process.exitCode=2'],
    { cwd: process.cwd() });
  assert.equal(result.outcome, 'failed');
});

test('silent child times out and cannot be reported successful', async () => {
  const result = await probe(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { cwd: process.cwd(), timeoutMs: 500 });
  assert.equal(result.stopReason, 'timeout');
  assert.equal(result.outcome, 'stopped');
});

test('cancellation stops the owned process tree and descendant writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-relay-m0-'));
  const file = join(dir, 'heartbeat');
  try {
    const leaf = `require('node:fs').appendFileSync(process.argv[1],'x');setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),50)`;
    const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)},process.argv[1]],{stdio:'ignore',windowsHide:true});setTimeout(()=>console.log(JSON.stringify({type:'child.ready',pid:c.pid})),300);setInterval(()=>{},1000)`;
    const result = await probe(process.execPath, ['-e', parent, file], {
      cwd: dir, timeoutMs: 5000, cancelWhen: e => e.type === 'child.ready',
    });
    assert.equal(result.outcome, 'stopped');
    const before = await readFile(file, 'utf8');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(await readFile(file, 'utf8'), before);
    const pid = result.events[0].pid;
    assert.throws(() => process.kill(pid, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('blocked or denied agent replies never satisfy task acceptance', async () => {
  const { fixtureAccepted } = await import('./process-probe.mts');
  for (const status of ['blocked', 'denied', 'failed', 'unknown']) {
    assert.equal(fixtureAccepted('turn_completed', status, true, 0), false);
  }
  assert.equal(fixtureAccepted('turn_completed', 'completed', true, 0), true);
  assert.equal(fixtureAccepted('turn_completed', 'completed', true, 1), false);
  assert.equal(fixtureAccepted('needs_reconciliation', 'completed', true, 0), false);
});

test('parent exit with a live descendant never implies successful completion', async () => {
  const code = 'const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},2000)"],{stdio:"inherit",windowsHide:true});c.unref()';
  const result = await probe(process.execPath, ['-e', code], { cwd: process.cwd(), timeoutMs: 700 });
  assert.ok(['needs_reconciliation', 'stop_unknown'].includes(result.outcome));
  assert.ok(result.durationMs < 1700);
  // The controlled orphan exits itself; no unrelated process is signalled.
  await new Promise(r => setTimeout(r, 2200));
});
