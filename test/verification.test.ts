import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Runs } from '../src/storage/runs.ts';
import { WorkspaceAccess } from '../src/workspace/access.ts';
import { Verifier } from '../src/verification/runner.ts';
import { workspaceFixture } from './workspace-helpers.ts';
async function setup(t: TestContext, code: string, timeoutMs = 5000) {
  const f = workspaceFixture(t),
    current = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(current, {
      ...current,
      config: {
        ...current.config,
        profiles: {
          ...current.config.profiles,
          implement: {
            role: 'implement',
            executor: 'codex-cli',
            provider: 'openai',
            model: 'gpt-6-luna',
            permission: 'workspace-write',
            native: { reasoningEffort: 'low' },
            timeoutMs: 60000,
          },
        },
        verification: {
          version: 1,
          maxLogBytes: 4096,
          commands: [
            {
              id: 'check',
              version: 1,
              executable: process.execPath,
              args: ['-e', code],
              cwd: '.',
              timeoutMs,
            },
          ],
        },
      },
    }),
  );
  const runs = new Runs(f.tasks),
    run = runs.claim(current.id, 'fixture', Date.now(), 'implement')!;
  const lease = await new WorkspaceAccess(f.manager).acquire(
    run,
    'implementation',
  );
  return {
    ...f,
    run,
    runs,
    workspace: lease.workspace,
    verifier: new Verifier(f.manager),
    task: f.tasks.get(current.id),
  };
}
test('trusted checks record candidate evidence and reject stale or corrupted reports', async (t) => {
  const f = await setup(t, "console.log('checked')");
  const report = await f.verifier.run(f.task, f.run, f.workspace, f.revision);
  assert.equal(report.status, 'passed');
  assert.equal(report.checks[0]!.exitCode, 0);
  assert.match(report.checks[0]!.log, /checked/);
  assert.equal(f.verifier.accepted(f.task), true);
  assert.equal(
    f.verifier.accepted({ ...f.task, requirementVersion: 2 }),
    false,
  );
  f.db.sql.prepare('UPDATE validations SET document=? WHERE run_id=?').run(
    JSON.stringify({
      ...report,
      checks: [{ ...report.checks[0], log: 'tampered' }],
    }),
    f.run.id,
  );
  assert.equal(f.verifier.accepted(f.task), false);
});
for (const [name, code, limit] of [
  ['failure', 'process.exit(7)', 5000],
  ['timeout', 'setInterval(()=>{},1000)', 200],
  [
    'output limit',
    "console.log('x'.repeat(8192));setInterval(()=>{},1000)",
    5000,
  ],
] as const)
  test(`trusted ${name} cannot pass verification`, async (t) => {
    const f = await setup(t, code, limit);
    const report = await f.verifier.run(f.task, f.run, f.workspace, f.revision);
    assert.notEqual(report.status, 'passed');
    assert.equal(f.verifier.accepted(f.task), false);
    assert.ok(report.checks.length);
  });
test('cancel before verification fences a late launch and survives verifier replacement', async (t) => {
  const f = await setup(
    t,
    "require('node:fs').writeFileSync('late.txt','bad')",
  );
  assert.equal(await f.verifier.cancel(f.run), 'stopped');
  await assert.rejects(
    f.verifier.run(f.task, f.run, f.workspace, f.revision),
    /already reserved/,
  );
  assert.equal(await new Verifier(f.manager).reconcile(f.run), 'stopped');
});

test('restarted verifier stops an in-flight trusted process before releasing ownership', async (t) => {
  const f = await setup(
    t,
    "setInterval(()=>require('node:fs').appendFileSync('value.txt','x'),25)",
    15000,
  );
  const pending = f.verifier.run(f.task, f.run, f.workspace, f.revision).then(
    (r) => r,
    (e) => e,
  );
  const path = join(f.workspace.path, 'value.txt');
  for (
    let i = 0;
    i < 200 && (!existsSync(path) || !readFileSync(path, 'utf8').includes('x'));
    i++
  )
    await delay(25);
  assert.match(readFileSync(path, 'utf8'), /x/);
  assert.equal(await new Verifier(f.manager).reconcile(f.run), 'stopped');
  const before = readFileSync(path, 'utf8');
  await delay(150);
  assert.equal(readFileSync(path, 'utf8'), before);
  const result = await pending;
  assert.ok(result instanceof Error || result.status !== 'passed');
  assert.equal(f.verifier.accepted(f.task), false);
  assert.equal(f.runs.outstanding().length, 1);
});
