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

test('M0 approval modes preserve explicit review and reject unrestricted settings', async () => {
  const { approvalConfig } = await import('./approval-config.mts');
  assert.deepEqual(approvalConfig(undefined).args, ['-c', 'approval_policy="never"']);
  assert.deepEqual(approvalConfig('auto-review').args, ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']);
  assert.throws(() => approvalConfig('always-allow'), /must be/);
});

test('external activity observer can cancel without waiting for another JSONL event', async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 400);
  try {
    const result = await probe(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), signal: abort.signal });
    assert.equal(result.stopReason, 'requested_cancel');
    assert.equal(result.outcome, 'stopped');
  } finally { clearTimeout(timer); }
});

test('strict read-only review permits rule review but cannot approve sandbox or permission expansion', async () => {
  const { approvalConfig } = await import('./approval-config.mts');
  const config = approvalConfig('read-only-review');
  assert.ok(config.args.includes('approval_policy={granular={sandbox_approval=false,rules=true,mcp_elicitations=false,request_permissions=false,skill_approval=false}}'));
  assert.ok(config.args.includes('approvals_reviewer="auto_review"'));
});

test('read-only acceptance requires actual attempts, denials and unchanged workspace contents', async () => {
  const { readOnlyAccepted, snapshotWorkspace } = await import('./readonly-evidence.mts');
  const accepted = { inspection: false, outcome: 'turn_completed', status: 'denied', schemaValid: true, unchanged: true, attemptObserved: true, denialObserved: true };
  assert.equal(readOnlyAccepted(accepted), true);
  for (const change of [{ unchanged: false }, { attemptObserved: false }, { denialObserved: false }, { status: 'completed' }]) assert.equal(readOnlyAccepted({ ...accepted, ...change }), false);
  assert.equal(readOnlyAccepted({ ...accepted, inspection: true, status: 'completed', denialObserved: false }), true);
  const dir = await mkdtemp(join(tmpdir(), 'relay-readonly-snapshot-'));
  const { writeFile, unlink } = await import('node:fs/promises');
  try {
    await writeFile(join(dir, 'sentinel'), 'before');
    const before = await snapshotWorkspace(dir);
    await writeFile(join(dir, 'sentinel'), 'after');
    assert.notDeepEqual(await snapshotWorkspace(dir), before);
    await unlink(join(dir, 'sentinel'));
    assert.notDeepEqual(await snapshotWorkspace(dir), before);
    await writeFile(join(dir, 'created'), 'new');
    assert.notDeepEqual(await snapshotWorkspace(dir), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ignoring user config does not omit the native Windows sandbox backend', async () => {
  const { nativeSandboxConfig } = await import('./approval-config.mts');
  assert.deepEqual(nativeSandboxConfig('win32'), ['-c', 'windows.sandbox="elevated"']);
  assert.deepEqual(nativeSandboxConfig('linux'), []);
});

test('malformed patch is not permission denial; sandbox EPERM is denial', async () => {
  const { permissionDenialObserved } = await import('./readonly-evidence.mts');
  assert.equal(permissionDenialObserved('apply_patch verification failed: invalid patch: multiple operations target sentinel', ''), false);
  assert.equal(permissionDenialObserved('patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings', ''), true);
  assert.equal(permissionDenialObserved('', "Error: EPERM: operation not permitted, open 'shell-denied.txt'"), true);
});

test('supplemental probe budget stays finite and retains the six-call default', async () => {
  const { probeCallLimit } = await import('./approval-config.mts');
  assert.equal(probeCallLimit(undefined), 6);
  assert.equal(probeCallLimit('8'), 8);
  for (const value of ['0','9','Infinity','NaN','6.5','']) assert.throws(() => probeCallLimit(value), /integer/);
});

test('independent permission cases each need their own denial evidence', async () => {
  const { permissionDenialObserved } = await import('./readonly-evidence.mts');
  assert.equal(permissionDenialObserved('unrelated transport EPERM', ''), false);
  assert.equal(permissionDenialObserved('apply_patch verification failed: invalid patch', 'EPERM', 'both'), false);
  assert.equal(permissionDenialObserved('patch rejected: writing is blocked by read-only sandbox', 'EPERM', 'both'), true);
});
