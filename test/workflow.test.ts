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
  const rejected = g.workflow.context(g.tasks.get(g.task.id));
  assert.equal(rejected.history.length, 1);
  assert.deepEqual(
    rejected.rejectedHandoffs?.map((h) => h.result),
    [
      {
        ...answer,
        sources: [{ path: 'value.txt', line: 1, excerpt: 'invented' }],
      },
    ],
  );
  const retry = await g.workflow.executionContext(g.tasks.get(g.task.id));
  assert.deepEqual(retry.rejectedDiagnostics?.[0]?.issues, [
    'value.txt:1: excerpt mismatch',
  ]);
  assert.ok(!JSON.stringify(retry.rejectedDiagnostics).includes('baseline'));
});

test('unavailable rejected sources remain actionable retry context without becoming accepted', async (t) => {
  const f = setup(t);
  f.backend.output = (r) =>
    r.task.stage === 'triage'
      ? triage
      : ({
          ...answer,
          sources: [{ path: 'missing.txt', line: 1, excerpt: 'missing' }],
        } as Handoff);
  await f.step();
  const task = await f.step();
  assert.equal(task.status, 'blocked');
  assert.match(task.diagnostic!, /missing.txt:1/);
  const context = await f.workflow.executionContext(task);
  assert.deepEqual(context.rejectedDiagnostics?.[0]?.issues, [
    'missing.txt:1: source unavailable',
  ]);
  assert.equal(context.history.length, 1);
});
test('design approval must bind the candidate and cover every criterion before implementation', async (t) => {
  const f = setup(t);
  f.backend.output = (r) => {
    if (r.task.stage === 'triage')
      return { ...triage, kind: 'change', scope: ['value.txt'] };
    if (r.task.stage === 'design')
      return {
        stage: 'design',
        responses: [],
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
      resolutions: [],
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
  assert.equal(
    f.backend.calls[2]!.handoff!.reviewSubjectRunId,
    f.backend.calls[1]!.run.id,
  );
  assert.notEqual(
    f.backend.calls[2]!.handoff!.reviewSubjectRunId,
    f.backend.calls[0]!.run.id,
  );
  assert.equal(f.tasks.get(f.task.id).stage, 'design_review');
});

test('design feedback shares an iteration budget and requires independent resolution evidence', async (t) => {
  const f = setup(t);
  let designs = 0,
    reviews = 0;
  f.backend.output = (r) => {
    if (r.task.stage === 'triage')
      return { ...triage, kind: 'change', scope: ['value.txt'] };
    if (r.task.stage === 'design') {
      designs++;
      return {
        stage: 'design',
        summary: `design ${designs}`,
        evidence: [{ path: 'value.txt', line: 1, excerpt: 'baseline' }],
        rootCause: 'fixture contract',
        invariant: 'empty values rejected',
        fixLayer: 'shared parser',
        steps: [
          designs === 1
            ? 'update value'
            : 'validate empty input before storing',
        ],
        validationPlan: ['check empty values'],
        responses:
          designs === 1
            ? []
            : [
                {
                  findingId: 'F1',
                  disposition: 'addressed',
                  proof: 'empty input validation added to shared parser plan',
                },
              ],
      };
    }
    reviews++;
    return {
      stage: 'design_review',
      subjectRunId: r.handoff!.history.findLast(
        (h) => h.result.stage === 'design',
      )!.runId,
      verdict: reviews === 1 ? 'revise' : 'approve',
      coverage: [{ criterionId: 'A1', proof: 'verified current plan' }],
      findings:
        reviews === 1
          ? [
              {
                id: 'F1',
                severity: 'blocking',
                origin: 'design',
                location: 'shared parser',
                trigger: 'empty input',
                proof: 'first plan has no validation step',
                impact: 'invalid value stored',
              },
            ]
          : [],
      resolutions:
        reviews === 1
          ? []
          : [
              {
                findingId: 'F1',
                verification:
                  'latest plan validates empty input before storage',
              },
            ],
    };
  };
  await f.step();
  await f.step();
  assert.equal((await f.step()).stage, 'design');
  assert.equal(f.tasks.get(f.task.id).iterationsUsed, 1);
  await f.step();
  assert.equal((await f.step()).stage, 'implement');
  const history = f.workflow.history(f.tasks.get(f.task.id));
  assert.equal(history.length, 5);
  assert.equal(history.at(-1)!.result.stage, 'design_review');
});
test('exhausted repair budget preserves feedback but does not schedule another model run', async (t) => {
  const f = setup(t),
    task = f.tasks.get(f.task.id);
  f.db.transaction(() =>
    f.tasks.save(task, {
      ...task,
      config: {
        ...task.config,
        budget: { ...task.config.budget, maxIterations: 0 },
      },
    }),
  );
  f.backend.output = (r) =>
    r.task.stage === 'triage'
      ? { ...triage, kind: 'change', scope: ['value.txt'] }
      : r.task.stage === 'design'
        ? {
            stage: 'design',
            responses: [],
            summary: 'design',
            evidence: [{ path: 'value.txt', line: 1, excerpt: 'baseline' }],
            rootCause: 'contract gap',
            invariant: 'validated data',
            fixLayer: 'parser',
            steps: ['fix parser'],
            validationPlan: ['test parser'],
          }
        : {
            stage: 'design_review',
            subjectRunId: r.handoff!.history.at(-1)!.runId,
            verdict: 'revise',
            coverage: [],
            resolutions: [],
            findings: [
              {
                id: 'F1',
                severity: 'blocking',
                origin: 'design',
                location: 'parser',
                trigger: 'invalid data',
                proof: 'missing validation',
                impact: 'invalid state',
              },
            ],
          };
  await f.step();
  await f.step();
  const blocked = await f.step();
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.diagnostic!, /budget exhausted/);
  await f.step();
  assert.equal(f.backend.calls.length, 3);
  assert.equal(f.workflow.history(blocked).length, 3);
});

test('design summaries and response claims do not manufacture progress after reopening', async (t) => {
  const f = setup(t);
  let designs = 0;
  f.backend.output = (r) => {
    if (r.task.stage === 'triage')
      return { ...triage, kind: 'change', scope: ['value.txt'] };
    if (r.task.stage === 'design')
      return {
        stage: 'design',
        summary: `new wording ${++designs}`,
        evidence: [{ path: 'value.txt', line: 1, excerpt: 'baseline' }],
        rootCause: 'missing validation',
        invariant: 'reject empty',
        fixLayer: 'parser',
        steps: ['store value'],
        validationPlan: ['check nonempty'],
        responses:
          designs === 1
            ? []
            : [
                {
                  findingId: 'F1',
                  disposition: 'addressed',
                  proof: 'claimed fixed',
                },
              ],
      };
    return {
      stage: 'design_review',
      subjectRunId: r.handoff!.history.at(-1)!.runId,
      verdict: 'revise',
      coverage: [],
      resolutions: [],
      findings: [
        {
          id: 'F1',
          severity: 'blocking',
          origin: 'design',
          location: 'parser',
          trigger: 'empty input',
          proof: 'no reject step',
          impact: 'invalid value stored',
        },
      ],
    };
  };
  await f.step();
  await f.step();
  await f.step();
  const restarted = new Controller(
    f.tasks,
    f.evidence,
    f.backend,
    new LocalWorkflow(f.manager, f.evidence),
  );
  await restarted.tick();
  await restarted.wait();
  const blocked = f.tasks.get(f.task.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.diagnostic!, /no progress/);
  assert.equal(blocked.iterationsUsed, 1);
  await restarted.tick();
  assert.equal(f.backend.calls.length, 4);
});

for (const reason of ['cancel', 'timeout'])
  test(`delayed source context cannot launch a backend after ${reason}`, async (t) => {
    const f = setup(t);
    if (reason === 'timeout') {
      const task = f.tasks.get(f.task.id);
      f.db.transaction(() =>
        f.tasks.save(task, {
          ...task,
          config: {
            ...task.config,
            profiles: {
              ...task.config.profiles,
              design: { ...task.config.profiles.design, timeoutMs: 30 },
            },
          },
        }),
      );
    }
    let release!: () => void, arrived!: () => void;
    const ready = new Promise<void>((r) => {
      arrived = r;
    });
    const context = f.workflow.executionContext.bind(f.workflow);
    f.workflow.executionContext = async (task) => {
      arrived();
      await new Promise<void>((r) => {
        release = r;
      });
      return context(task);
    };
    f.backend.output = () => triage;
    await f.controller.tick();
    await ready;
    if (reason === 'cancel') {
      f.tasks.command(f.task.id, {
        action: 'cancel',
        expectedVersion: f.tasks.get(f.task.id).version,
      });
      await f.controller.tick();
    }
    await f.controller.wait();
    assert.equal(
      f.tasks.get(f.task.id).status,
      reason === 'cancel' ? 'cancelled' : 'blocked',
    );
    release();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.backend.calls.length, 0);
    assert.ok(
      f.controller.runs.forTask(f.task.id).every((r) => r.status === 'stopped'),
    );
  });
