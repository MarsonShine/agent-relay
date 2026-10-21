import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Executor,
  ExecutionHandle,
  ExecutionRequest,
} from '../src/core/execution.ts';
import type { Handoff } from '../src/core/handoff.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { Controller } from '../src/workflow/controller.ts';
import { LocalWorkflow } from '../src/workflow/local.ts';
import { WorkspaceExecutor } from '../src/workspace/executor.ts';
import { workspaceFixture, git } from './workspace-helpers.ts';

test('protected development performs review repair and accepts only the newly validated candidate', async (t) => {
  const f = workspaceFixture(t),
    initial = f.tasks.get(f.task.id);
  const profile = {
    executor: 'codex-cli' as const,
    provider: 'openai' as const,
    model: 'gpt-6-luna' as const,
    native: { reasoningEffort: 'low' as const },
    timeoutMs: 180000,
  };
  f.db.transaction(() =>
    f.tasks.save(initial, {
      ...initial,
      kind: 'development',
      deadlineAt: Date.now() + 600000,
      config: {
        ...initial.config,
        allowedFiles: ['value.txt'],
        profiles: {
          design: { ...profile, role: 'design', permission: 'read-only' },
          implement: {
            ...profile,
            role: 'implement',
            permission: 'workspace-write',
          },
          review: { ...profile, role: 'review', permission: 'read-only' },
        },
        budget: { maxRuns: 8, maxIterations: 2, maxTaskMs: 600000 },
        verification: {
          version: 1,
          maxLogBytes: 4096,
          commands: [
            {
              id: 'value',
              version: 1,
              executable: process.execPath,
              args: [
                '-e',
                "if(!require('node:fs').readFileSync('value.txt','utf8').startsWith('candidate'))process.exit(1)",
              ],
              cwd: '.',
              timeoutMs: 5000,
            },
          ],
        },
      },
    }),
  );
  let implementations = 0,
    reviews = 0;
  const requests: ExecutionRequest[] = [];
  const backend: Executor = {
    id: 'codex-cli',
    version: 'fixture',
    capabilities: {
      continuation: false,
      cancellation: true,
      permissions: ['read-only', 'workspace-write'],
      structuredOutput: true,
      usage: false,
    },
    async start(r): Promise<ExecutionHandle> {
      requests.push(r);
      let result: Handoff;
      if (r.task.stage === 'triage')
        result = {
          stage: 'triage',
          kind: 'change',
          goal: 'update fixture',
          nonGoals: [],
          acceptance: [{ id: 'A1', description: 'candidate2 content' }],
          scope: ['value.txt'],
          simpleReason: 'one file fixture',
        };
      else if (r.task.stage === 'implement') {
        implementations++;
        writeFileSync(
          join(r.workspace!.path, 'value.txt'),
          `candidate${implementations}\n`,
        );
        git(r.workspace!.path, 'add', 'value.txt');
        git(r.workspace!.path, 'commit', '-qm', 'fixture implementation');
        result = {
          stage: 'implement',
          baseRevision: r.task.codeRevision!,
          resultRevision: git(r.workspace!.path, 'rev-parse', 'HEAD'),
          changedFiles: ['value.txt'],
          summary: 'updated candidate',
          unresolved: [],
          responses:
            implementations === 1
              ? []
              : [
                  {
                    findingId: 'F1',
                    disposition: 'addressed',
                    proof: 'candidate2 content committed',
                  },
                ],
        };
      } else {
        reviews++;
        assert.equal(r.workspace!.access, 'read-only');
        result = {
          stage: 'code_review',
          subjectRunId: r.handoff!.history.findLast(
            (h) => h.result.stage === 'implement',
          )!.runId,
          verdict: reviews === 1 ? 'revise' : 'approve',
          coverage: [
            { criterionId: 'A1', proof: 'examined candidate content' },
          ],
          findings:
            reviews === 1
              ? [
                  {
                    id: 'F1',
                    severity: 'blocking',
                    origin: 'implementation',
                    location: 'value.txt:1',
                    trigger: 'read value',
                    proof: 'candidate1 instead of candidate2',
                    impact: 'wrong value',
                  },
                ]
              : [],
          resolutions:
            reviews === 1
              ? []
              : [
                  {
                    findingId: 'F1',
                    verification: 'fixed snapshot contains candidate2',
                  },
                ],
        };
      }
      return {
        events: (async function* () {
          yield {
            schemaVersion: 1 as const,
            key: 'done',
            type: 'completed' as const,
            message: 'role done',
          };
        })(),
        result: Promise.resolve({
          schemaVersion: 1,
          status: 'completed',
          stopped: true,
          evidence: r.run.evidence,
          output: JSON.stringify(result),
          question: null,
          continuation: null,
          diagnostic: null,
          usage: null,
        }),
      };
    },
    async continue() {
      throw Error('no continuation');
    },
    async cancel() {
      return 'stopped';
    },
    async reconcile() {
      return 'stopped';
    },
  };
  const evidence = new Evidence(f.tasks, join(f.directory, 'evidence')),
    workflow = new LocalWorkflow(f.manager, evidence);
  const controller = new Controller(
    f.tasks,
    evidence,
    new WorkspaceExecutor(backend, f.manager),
    workflow,
  );
  for (let i = 0; i < 5; i++) {
    await controller.tick();
    await controller.wait();
    assert.notEqual(
      f.tasks.get(f.task.id).status,
      'blocked',
      f.tasks.get(f.task.id).diagnostic ?? 'blocked',
    );
  }
  const task = f.tasks.get(f.task.id);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.stage, 'deliver');
  assert.equal(task.iterationsUsed, 1);
  assert.equal(workflow.verifier.accepted(task), true);
  assert.equal(workflow.verifier.reports(task).length, 2);
  assert.equal(implementations, 2);
  assert.equal(reviews, 2);
  assert.equal(new Set(requests.map((r) => r.run.id)).size, 5);
  assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'baseline\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.revision);
  assert.equal(
    Number(
      f.db.sql.prepare('SELECT count(*) AS n FROM workspace_access').get()!.n,
    ),
    0,
  );
});
