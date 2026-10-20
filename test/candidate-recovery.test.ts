import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Runs } from '../src/storage/runs.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { LocalWorkflow } from '../src/workflow/local.ts';
import { WorkspaceAccess } from '../src/workspace/access.ts';
import { workspaceFixture, git } from './workspace-helpers.ts';
test('confirmed committed candidate retains unresolved claims and requires fresh validation plus independent review', async (t) => {
  const f = workspaceFixture(t),
    initial = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(initial, {
      ...initial,
      kind: 'development',
      config: {
        ...initial.config,
        allowedFiles: ['value.txt'],
        profiles: {
          ...initial.config.profiles,
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
              args: ['-e', 'process.exit(0)'],
              cwd: '.',
              timeoutMs: 5000,
            },
          ],
        },
      },
    }),
  );
  const evidence = new Evidence(f.tasks, join(f.directory, 'evidence')),
    workflow = new LocalWorkflow(f.manager, evidence),
    runs = new Runs(f.tasks),
    access = new WorkspaceAccess(f.manager);
  const settle = async (run: ReturnType<Runs['get']>, output: unknown) => {
    const task = f.tasks.get(f.task.id),
      a = evidence.put(
        run,
        'result',
        JSON.stringify(output),
        task.config.maxArtifactBytes,
      );
    const advance = await workflow.complete(task, run, a.id);
    return runs.finish(
      run,
      {
        status: advance.status,
        diagnostic: advance.diagnostic,
        question: null,
        continuation: null,
      },
      Date.now(),
      advance,
    );
  };
  const triage = runs.claim(f.task.id, 'fixture')!;
  await settle(triage, {
    stage: 'triage',
    kind: 'change',
    goal: 'candidate',
    nonGoals: [],
    acceptance: [{ id: 'A1', description: 'candidate value' }],
    scope: ['value.txt'],
    simpleReason: 'single fixture',
  });
  const interrupted = runs.claim(
      f.task.id,
      'fixture',
      Date.now(),
      'implement',
    )!,
    lease = await access.acquire(interrupted, 'implementation');
  writeFileSync(join(lease.workspace.path, 'value.txt'), 'candidate\n');
  git(lease.workspace.path, 'add', 'value.txt');
  git(lease.workspace.path, 'commit', '-qm', 'candidate');
  const candidate = git(lease.workspace.path, 'rev-parse', 'HEAD');
  writeFileSync(
    join(lease.workspace.path, 'scratch.tmp'),
    'owned temporary file',
  );
  const output = {
    stage: 'implement',
    responses: [],
    summary: 'candidate committed',
    baseRevision: f.revision,
    resultRevision: candidate,
    changedFiles: ['value.txt'],
    unresolved: ['scratch.tmp must be removed'],
  };
  await assert.rejects(settle(interrupted, output));
  await assert.rejects(
    f.manager.confirmCandidate(
      f.task.id,
      f.tasks.get(f.task.id).version,
      candidate,
    ),
    /stopped/,
  );
  runs.finish(interrupted, {
    status: 'blocked',
    diagnostic: 'unresolved scratch',
    question: null,
    continuation: null,
  });
  await assert.rejects(
    f.manager.confirmCandidate(
      f.task.id,
      f.tasks.get(f.task.id).version,
      candidate,
    ),
    /dirty/,
  );
  unlinkSync(join(lease.workspace.path, 'scratch.tmp'));
  const before = f.tasks.get(f.task.id),
    confirmed = await f.manager.confirmCandidate(
      f.task.id,
      before.version,
      candidate,
    );
  assert.equal(confirmed.runsUsed, before.runsUsed);
  assert.equal(confirmed.deadlineAt, before.deadlineAt);
  assert.equal(confirmed.status, 'blocked');
  const paused = f.tasks.command(f.task.id, {
    action: 'pause',
    expectedVersion: confirmed.version,
  });
  f.tasks.command(f.task.id, {
    action: 'resume',
    expectedVersion: paused.version,
  });
  const resumed = runs.claim(f.task.id, 'fixture', Date.now(), 'implement')!;
  await access.acquire(resumed, 'implementation');
  const pending = workflow.context(f.tasks.get(f.task.id)).pendingFindings!;
  assert.equal(pending.length, 1);
  await settle(resumed, {
    ...output,
    unresolved: [],
    responses: [
      {
        findingId: pending[0]!.id,
        disposition: 'addressed',
        proof: 'owned scratch removed and clean status verified',
      },
    ],
  });
  assert.equal(f.tasks.get(f.task.id).stage, 'code_review');
  assert.equal(f.manager.get(lease.workspace.id).confirmedCandidate, null);
  assert.equal(
    workflow.context(f.tasks.get(f.task.id)).pendingFindings!.length,
    1,
  );
  assert.equal(workflow.verifier.accepted(f.tasks.get(f.task.id)), true);
  const review = runs.claim(f.task.id, 'fixture', Date.now(), 'review')!;
  const result = {
    stage: 'code_review',
    subjectRunId: resumed.id,
    verdict: 'approve',
    coverage: [{ criterionId: 'A1', proof: 'candidate verified' }],
    findings: [],
    resolutions: [],
  };
  const task = await settle(review, result);
  assert.notEqual(task.status, 'succeeded');
  assert.equal(task.stage, 'implement');
});
