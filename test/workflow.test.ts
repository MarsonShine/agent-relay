import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { FakeExecutor } from '../src/adapters/fake.ts';
import type {
  ExecutionRequest,
  ExecutionHandle,
} from '../src/core/execution.ts';
import type { Handoff } from '../src/core/handoff.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { LocalWorkflow } from '../src/workflow/local.ts';
import { Controller } from '../src/workflow/controller.ts';
import { workspaceFixture } from './workspace-helpers.ts';

export class StageFixture extends FakeExecutor {
  calls: ExecutionRequest[] = [];
  output: (r: ExecutionRequest) => Handoff = () => {
    throw Error('unconfigured fixture');
  };
  override async start(r: ExecutionRequest): Promise<ExecutionHandle> {
    this.calls.push(r);
    const output = JSON.stringify(this.output(r));
    return {
      events: (async function* () {
        yield {
          schemaVersion: 1 as const,
          key: 'done',
          type: 'completed' as const,
          message: 'role complete',
        };
      })(),
      result: Promise.resolve({
        schemaVersion: 1,
        status: 'completed',
        stopped: true,
        evidence: r.run.evidence,
        output,
        question: null,
        continuation: null,
        diagnostic: null,
        usage: null,
      }),
    };
  }
  override async cancel() {
    return 'stopped' as const;
  }
}
export function setup(t: TestContext) {
  const f = workspaceFixture(t),
    task = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(task, {
      ...task,
      kind: 'development',
      config: {
        ...task.config,
        budget: { ...task.config.budget, maxRuns: 20 },
        profiles: Object.fromEntries(
          Object.entries(task.config.profiles).map(([k, v]) => [
            k,
            { ...v, timeoutMs: 60000 },
          ]),
        ) as typeof task.config.profiles,
      },
    }),
  );
  const evidence = new Evidence(f.tasks, join(f.directory, 'evidence'));
  const workflow = new LocalWorkflow(f.manager, evidence),
    backend = new StageFixture();
  const controller = new Controller(f.tasks, evidence, backend, workflow);
  return {
    ...f,
    evidence,
    workflow,
    backend,
    controller,
    step: async () => {
      await controller.tick();
      await controller.wait();
      return f.tasks.get(task.id);
    },
  };
}
export const triage: Handoff = {
  stage: 'triage',
  kind: 'consultation',
  goal: 'explain the fixture',
  nonGoals: ['no modifications'],
  acceptance: [{ id: 'A1', description: 'cite value.txt' }],
  scope: [],
  simpleReason: null,
};
const answer: Handoff = {
  stage: 'answer',
  conclusion: 'baseline value',
  sources: [{ path: 'value.txt', line: 1, excerpt: 'baseline' }],
  limitations: [],
};

test('consultation hands actual artifact contents to a new run and accepts matching source evidence', async (t) => {
  const f = setup(t);
  f.backend.output = (r) => (r.task.stage === 'triage' ? triage : answer);
  assert.equal((await f.step()).status, 'queued');
  assert.equal(f.tasks.get(f.task.id).stage, 'answer');
  assert.equal((await f.step()).status, 'succeeded');
  assert.equal(f.backend.calls.length, 2);
  assert.deepEqual(f.backend.calls[1]!.handoff!.history[0]!.result, triage);
  assert.notEqual(f.backend.calls[0]!.run.id, f.backend.calls[1]!.run.id);
  assert.equal(f.manager.list(f.task.id).length, 0);
});
test('wrong stage and fabricated source cannot become accepted role results', async (t) => {
  const f = setup(t);
  f.backend.output = () => answer;
  assert.equal((await f.step()).status, 'blocked');
  assert.equal(f.workflow.history(f.tasks.get(f.task.id)).length, 0);
  const g = setup(t);
  g.backend.output = (r) =>
    r.task.stage === 'triage'
      ? triage
      : ({
          ...answer,
          sources: [{ path: 'value.txt', line: 1, excerpt: 'invented' }],
        } as Handoff);
  await g.step();
  assert.equal((await g.step()).status, 'blocked');
});
test('design approval must bind the candidate and cover every criterion before implementation', async (t) => {
  const f = setup(t);
  f.backend.output = (r) => {
    if (r.task.stage === 'triage')
      return { ...triage, kind: 'change', scope: ['value.txt'] };
    if (r.task.stage === 'design')
      return {
        stage: 'design',
        summary: 'change value',
        evidence: [{ path: 'value.txt', line: 1, excerpt: 'baseline' }],
        rootCause: 'fixture behavior',
        invariant: 'explicit value',
        fixLayer: 'value.txt',
        steps: ['update value'],
        validationPlan: ['check value'],
      };
    return {
      stage: 'design_review',
      subjectRunId: r.handoff!.history.at(-1)!.runId,
      verdict: 'approve',
      coverage: [],
      findings: [],
    };
  };
  await f.step();
  await f.step();
  assert.equal((await f.step()).status, 'blocked');
  assert.equal(f.backend.calls[2]!.run.profile.role, 'review');
  assert.equal(f.tasks.get(f.task.id).stage, 'design_review');
});
