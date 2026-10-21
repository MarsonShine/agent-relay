import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Handoff } from '../src/core/handoff.ts';
import type { Run, Task } from '../src/core/contracts.ts';
import { Runs } from '../src/storage/runs.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { LocalWorkflow } from '../src/workflow/local.ts';
import { WorkspaceAccess } from '../src/workspace/access.ts';
import { workspaceFixture, git } from './workspace-helpers.ts';

for (const mode of [
  'unchanged-without-finding',
  'cycle',
  'new-requirement',
  'dispute-approve',
  'dispute-repeat',
])
  test(`progress and independent evidence: ${mode}`, async (t) => {
    const reviseRequirement = mode === 'new-requirement';
    const f = workspaceFixture(t),
      original = f.tasks.get(f.task.id);
    f.db.transaction(() =>
      f.tasks.save(original, {
        ...original,
        kind: 'development',
        config: {
          ...original.config,
          budget: { ...original.config.budget, maxRuns: 10 },
          allowedFiles: ['value.txt'],
          profiles: {
            ...original.config.profiles,
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
                id: 'fixture-value',
                version: 1,
                executable: process.execPath,
                args: [
                  '-e',
                  "if(!require('node:fs').readFileSync('value.txt','utf8').trim())throw Error('empty')",
                ],
                cwd: '.',
                timeoutMs: 5000,
              },
            ],
          },
        },
      }),
    );
    const runs = new Runs(f.tasks),
      evidence = new Evidence(f.tasks, join(f.directory, 'evidence')),
      workflow = new LocalWorkflow(f.manager, evidence);
    const settle = async (
      make: (task: Task, run: Run) => Handoff | Promise<Handoff>,
    ) => {
      const task = f.tasks.get(f.task.id),
        run = runs.claim(task.id, 'fixture', Date.now(), workflow.role(task))!;
      const result = await make(task, run),
        artifact = evidence.put(
          run,
          'result',
          JSON.stringify(result),
          task.config.maxArtifactBytes,
        );
      try {
        const advance = await workflow.complete(task, run, artifact.id);
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
      } catch (error) {
        runs.finish(run, {
          status: 'blocked',
          diagnostic: String(error),
          question: null,
          continuation: null,
        });
        throw error;
      }
    };
    const triage = (): Handoff => ({
      stage: 'triage',
      kind: 'change',
      goal: 'fixture value',
      nonGoals: [],
      acceptance: [{ id: 'A1', description: 'required value' }],
      scope: ['value.txt'],
      simpleReason: 'single file',
    });
    const implement =
      (value: string) =>
      async (task: Task, run: Run): Promise<Handoff> => {
        const lease = await new WorkspaceAccess(f.manager).acquire(
          run,
          'implementation',
        );
        writeFileSync(join(lease.workspace.path, 'value.txt'), value);
        git(lease.workspace.path, 'add', 'value.txt');
        git(lease.workspace.path, 'commit', '-qm', 'fixture candidate');
        return {
          stage: 'implement',
          baseRevision: task.codeRevision!,
          resultRevision: git(lease.workspace.path, 'rev-parse', 'HEAD'),
          changedFiles: ['value.txt'],
          summary: 'candidate',
          unresolved: [],
          responses:
            reviseRequirement || value !== 'baseline\n'
              ? []
              : [
                  {
                    findingId: 'F1',
                    disposition: 'addressed',
                    proof: 'restored fixture value',
                  },
                ],
        };
      };
    await settle(triage);
    if (mode === 'unchanged-without-finding') {
      await assert.rejects(
        settle(async (task, run) => {
          await new WorkspaceAccess(f.manager).acquire(run, 'implementation');
          return {
            stage: 'implement',
            baseRevision: task.codeRevision!,
            resultRevision: task.codeRevision!,
            changedFiles: [],
            summary: 'no change',
            unresolved: [],
            responses: [],
          };
        }),
        /new clean committed result/,
      );
      return;
    }
    await settle(implement('changed\n'));
    if (mode.startsWith('dispute')) {
      const review =
        (approve: boolean) =>
        (task: Task): Handoff => ({
          stage: 'code_review',
          subjectRunId: workflow
            .history(task)
            .findLast((h) => h.result.stage === 'implement')!.runId,
          verdict: approve ? 'approve' : 'revise',
          coverage: [{ criterionId: 'A1', proof: 'verified fixture bytes' }],
          resolutions: approve
            ? [
                {
                  findingId: 'F1',
                  verification:
                    'independent byte check confirms finding was false',
                },
              ]
            : [],
          findings: approve
            ? []
            : [
                {
                  id: 'F1',
                  severity: 'blocking',
                  origin: 'implementation',
                  location: 'value.txt',
                  trigger: 'fixture claim',
                  proof: 'synthetic review finding',
                  impact: 'fixture gate',
                },
              ],
        });
      await settle(review(false));
      const revision = f.tasks.get(f.task.id).codeRevision;
      const dispute = async (task: Task, run: Run): Promise<Handoff> => {
        await new WorkspaceAccess(f.manager).acquire(run, 'implementation');
        return {
          stage: 'implement',
          baseRevision: task.codeRevision!,
          resultRevision: task.codeRevision!,
          changedFiles: [],
          summary: 'No code change; dispute finding',
          unresolved: [],
          responses: [
            {
              findingId: 'F1',
              disposition: 'disputed',
              proof: 'actual byte check contradicts the finding',
            },
          ],
        };
      };
      const candidate = await settle(dispute);
      assert.equal(candidate.stage, 'code_review');
      assert.equal(candidate.codeRevision, revision);
      assert.equal(workflow.verifier.reports(candidate).length, 2);
      if (mode === 'dispute-approve') {
        assert.equal((await settle(review(true))).status, 'succeeded');
      } else {
        await settle(review(false));
        await assert.rejects(settle(dispute), /new clean committed result/);
        assert.equal(f.tasks.get(f.task.id).status, 'blocked');
      }
      return;
    }
    if (reviseRequirement) {
      const task = f.tasks.get(f.task.id);
      f.tasks.command(task.id, {
        action: 'revise',
        expectedVersion: task.version,
        requirementVersion: 1,
        input: 'Explicitly restore baseline value',
      });
      await settle(triage);
      const result = await settle(implement('baseline\n'));
      assert.equal(result.stage, 'code_review');
      assert.equal(result.requirementVersion, 2);
      assert.equal(workflow.verifier.accepted(result), true);
    } else {
      await settle((task) => ({
        stage: 'code_review',
        subjectRunId: workflow.history(task).at(-1)!.runId,
        verdict: 'revise',
        coverage: [],
        resolutions: [],
        findings: [
          {
            id: 'F1',
            severity: 'blocking',
            origin: 'implementation',
            location: 'value.txt',
            trigger: 'fixture check',
            proof: 'deterministic repair fixture',
            impact: 'fixture requirement unmet',
          },
        ],
      }));
      await assert.rejects(
        settle(implement('baseline\n')),
        /earlier code tree/,
      );
      assert.equal(f.tasks.get(f.task.id).status, 'blocked');
    }
  });
