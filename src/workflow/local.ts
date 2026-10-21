import { z } from 'zod';
import { Runs } from '../storage/runs.ts';
import { digest, Verifier } from '../verification/runner.ts';
import type { Profile } from '../core/config.ts';
import type { Run, Task } from '../core/contracts.ts';
import {
  handoffSchema,
  handoffRecordSchema,
  stageHandoffSchema,
} from '../core/handoff.ts';
import type { Handoff, HandoffRecord } from '../core/handoff.ts';
import type { ExecutionRequest } from '../core/execution.ts';
import { RelayError } from '../core/errors.ts';
import type { Evidence } from '../storage/evidence.ts';
import type { Workspaces } from '../workspace/manager.ts';

import type { Advance } from '../core/handoff.ts';

// Summaries and repair claims cannot establish changed design content.
export function designProgress(
  result: Extract<Handoff, { stage: 'design' }>,
): string {
  return digest({
    evidence: result.evidence,
    rootCause: result.rootCause,
    invariant: result.invariant,
    fixLayer: result.fixLayer,
    steps: result.steps,
    validationPlan: result.validationPlan,
  });
}

export class LocalWorkflow {
  readonly workspaces: Workspaces;
  readonly evidence: Evidence;
  readonly verifier: Verifier;
  constructor(workspaces: Workspaces, evidence: Evidence) {
    this.workspaces = workspaces;
    this.evidence = evidence;
    this.verifier = new Verifier(workspaces);
  }
  role(task: Task): Profile['role'] {
    return task.stage === 'implement'
      ? 'implement'
      : ['design_review', 'code_review'].includes(task.stage)
        ? 'review'
        : 'design';
  }
  async acceptance(task: Task): Promise<string[]> {
    const issues = this.evidence.diagnose(task.id);
    if (task.status !== 'succeeded')
      issues.push('local workflow has not succeeded');
    if (task.stage !== 'deliver') issues.push('task is not a code delivery');
    if (
      new Runs(this.workspaces.tasks)
        .forTask(task.id)
        .some((r) => r.status !== 'stopped') ||
      this.workspaces.tasks.db.sql
        .prepare('SELECT 1 FROM workspace_access WHERE task_id=?')
        .get(task.id)
    )
      issues.push('execution ownership is not released');
    try {
      const history = this.history(task),
        review = history.at(-1)?.result;
      if (
        review?.stage !== 'code_review' ||
        review.verdict !== 'approve' ||
        this.pending(task, history).length ||
        !this.verifier.accepted(task)
      )
        issues.push(
          'current candidate lacks complete independent review and trusted validation',
        );
      const workspace = this.workspaces
        .list(task.id)
        .find((w) => w.kind === 'implementation');
      if (
        !workspace ||
        (await this.workspaces.git.verify(workspace, true)) !==
          task.codeRevision
      )
        issues.push('delivered workspace changed');
    } catch {
      issues.push('local delivery evidence cannot be verified');
    }
    return issues;
  }
  history(task: Task): HandoffRecord[] {
    return this.workspaces.tasks.db.sql
      .prepare('SELECT document FROM handoffs WHERE task_id=? ORDER BY rowid')
      .all(task.id)
      .map((row) => handoffRecordSchema.parse(JSON.parse(String(row.document))))
      .filter(
        (row) => row.evidence.requirementVersion === task.requirementVersion,
      )
      .map((row) => {
        const artifact = this.evidence
          .list(task.id)
          .find((a) => a.id === row.artifactId);
        if (
          !artifact ||
          artifact.runId !== row.runId ||
          JSON.stringify(artifact.evidence) !== JSON.stringify(row.evidence) ||
          JSON.stringify(
            handoffSchema.parse(JSON.parse(this.evidence.read(row.artifactId))),
          ) !== JSON.stringify(row.result)
        )
          throw new RelayError(
            'storage',
            'handoff source artifact differs from recorded evidence',
          );
        return row;
      });
  }
  private pending(task: Task, history: HandoffRecord[], excludeRunId?: string) {
    const pending = new Map<
      string,
      {
        id: string;
        origin: 'design' | 'implementation';
        description: string;
        runId: string | null;
        sourceKey?: string;
      }
    >();
    const accepted = new Set(history.map((h) => h.runId)),
      runs = new Runs(this.workspaces.tasks);
    for (const decision of this.workspaces.tasks.decisions(task.id)) {
      if (
        decision.requirementVersion === task.requirementVersion &&
        decision.obligation
      )
        pending.set(decision.obligation.id, {
          id: decision.obligation.id,
          origin: decision.obligation.origin,
          description: decision.answer,
          runId: null,
          sourceKey: decision.obligation.sourceKey,
        });
    }
    for (const artifact of this.evidence.list(task.id)) {
      if (
        artifact.kind !== 'result' ||
        artifact.runId === excludeRunId ||
        accepted.has(artifact.runId) ||
        artifact.evidence.requirementVersion !== task.requirementVersion ||
        runs.get(artifact.runId).status !== 'stopped'
      )
        continue;
      const content = this.evidence.read(artifact.id);
      let parsed;
      try {
        parsed = handoffSchema.safeParse(JSON.parse(content));
      } catch {
        continue;
      }
      if (!parsed.success || parsed.data.stage !== 'implement') continue;
      parsed.data.unresolved.forEach((description, index) => {
        const id = `U-${artifact.runId}-${index}`;
        pending.set(id, {
          id,
          origin: 'implementation',
          description,
          runId: artifact.runId,
        });
      });
    }
    for (const { runId, result } of history) {
      if (result.stage !== 'design_review' && result.stage !== 'code_review')
        continue;
      for (const r of result.resolutions) pending.delete(r.findingId);
      for (const f of result.findings)
        if (f.severity === 'blocking')
          pending.set(f.id, {
            id: f.id,
            origin: f.origin,
            description: f.proof,
            runId,
          });
    }
    return [...pending.values()];
  }
  private implementationBase(task: Task): string | undefined {
    const candidate = this.workspaces
      .list(task.id)
      .find((w) => w.kind === 'implementation')?.confirmedCandidate;
    return candidate?.revision === task.codeRevision
      ? candidate.fromRevision
      : (task.codeRevision ?? undefined);
  }
  context(task: Task): NonNullable<ExecutionRequest['handoff']> {
    const result = {
      contractVersion: 'M2-handoff-v1' as const,
      ...(this.implementationBase(task)
        ? { implementationBaseRevision: this.implementationBase(task)! }
        : {}),
      ...(task.config.allowedFiles
        ? { allowedFiles: task.config.allowedFiles }
        : {}),
      resultSchema: z.toJSONSchema(
        stageHandoffSchema(task.stage, this.implementationBase(task)),
        {
          target: 'draft-7',
        },
      ),
      history: this.history(task),
      pendingFindings: this.pending(task, this.history(task)),
      validations: this.verifier
        .reports(task)
        .filter(
          (v) => v.evidence.requirementVersion === task.requirementVersion,
        )
        .map((v) => ({
          evidence: v.evidence,
          status: v.status,
          checks: v.checks.map((c) => ({
            id: c.id,
            exitCode: c.exitCode,
            reason: c.reason,
            log: c.log,
          })),
        })),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw new RelayError('invalid', 'handoff context limit exceeded');
    return result;
  }
  async complete(task: Task, run: Run, artifactId: string): Promise<Advance> {
    const result = handoffSchema.parse(
      JSON.parse(this.evidence.read(artifactId)),
    );
    if (result.stage !== task.stage)
      throw new RelayError('conflict', 'role result is for a different stage');
    const history = this.history(task);
    const latest = (stage: Handoff['stage']) =>
      history.findLast((h) => h.result.stage === stage);
    let stage: Task['stage'] = task.stage,
      codeRevision = task.codeRevision;
    let status: Advance['status'] = 'queued';
    let iterationsUsed = task.iterationsUsed,
      diagnostic: string | null = null;
    const retry = (target: Task['stage'], reason: string) => {
      diagnostic = reason;
      if (iterationsUsed >= task.config.budget.maxIterations) {
        status = 'blocked';
        diagnostic += '; iteration budget exhausted';
      } else {
        iterationsUsed++;
        stage = target;
      }
    };
    const unresolved = new Map(
      this.pending(task, history, run.id).map((f) => [f.id, f.origin]),
    );
    let newDispute = false;
    if (result.stage === 'implement' || result.stage === 'design') {
      const relevant = [...unresolved]
        .filter(
          ([, origin]) => result.stage === 'implement' || origin === 'design',
        )
        .map(([id]) => id);
      if (
        relevant.some((id) => !result.responses.some((r) => r.findingId === id))
      )
        throw new RelayError(
          'conflict',
          'repair must address or dispute every outstanding finding with evidence',
        );
      const previous = latest(result.stage)?.result;
      const previousResponses =
        previous &&
        (previous.stage === 'implement' || previous.stage === 'design')
          ? previous.responses
          : [];
      newDispute =
        relevant.length > 0 &&
        result.responses.length === relevant.length &&
        relevant.every((id) =>
          result.responses.some(
            (r) => r.findingId === id && r.disposition === 'disputed',
          ),
        ) &&
        relevant.some(
          (id) =>
            !previousResponses.some(
              (r) => r.findingId === id && r.disposition === 'disputed',
            ),
        );
      if (
        !newDispute &&
        result.stage === 'design' &&
        history.some(
          (h) =>
            h.result.stage === 'design' &&
            designProgress(h.result) === designProgress(result),
        )
      )
        throw new RelayError('conflict', 'design feedback made no progress');
    }
    const triage = latest('triage')?.result;
    if (result.stage !== 'triage' && triage?.stage !== 'triage')
      throw new RelayError('conflict', 'current requirement has no triage');
    if (result.stage === 'triage') {
      if (
        new Set(result.acceptance.map((c) => c.id)).size !==
          result.acceptance.length ||
        (result.kind === 'change' && result.scope.length === 0)
      )
        throw new RelayError(
          'invalid',
          'triage requires unique criteria and bounded change scope',
        );
      if (
        task.config.allowedFiles &&
        result.scope.some((p) => !task.config.allowedFiles!.includes(p))
      )
        throw new RelayError(
          'conflict',
          'triage scope exceeds trusted allowed files',
        );
      stage =
        result.kind === 'consultation'
          ? 'answer'
          : result.simpleReason
            ? 'implement'
            : 'design';
    } else if (result.stage === 'answer' || result.stage === 'design') {
      for (const source of result.stage === 'answer'
        ? result.sources
        : result.evidence) {
        const content = await this.workspaces.git.command(task.repo, [
          'show',
          `${task.codeRevision}:${source.path}`,
        ]);
        const lines = content.split(/\r?\n/);
        if (!lines[source.line - 1]?.includes(source.excerpt))
          throw new RelayError(
            'invalid',
            'source excerpt does not match the recorded revision',
          );
      }
      stage = result.stage === 'answer' ? 'answer' : 'design_review';
      if (result.stage === 'answer') status = 'succeeded';
    } else if (result.stage === 'implement') {
      const workspace = this.workspaces
        .list(task.id)
        .find((w) => w.kind === 'implementation');
      const previousImplementation = latest('implement')?.result;
      const unchangedCandidate =
        result.resultRevision === this.implementationBase(task);
      if (
        !workspace ||
        result.baseRevision !== this.implementationBase(task) ||
        result.unresolved.length ||
        (await this.workspaces.git.verify(workspace, true)) !==
          result.resultRevision ||
        (unchangedCandidate &&
          (!newDispute ||
            previousImplementation?.stage !== 'implement' ||
            previousImplementation.resultRevision !== result.resultRevision))
      )
        throw new RelayError(
          'conflict',
          'implementation requires a new clean committed result or a new evidence-backed dispute of the current candidate',
        );
      const files = (
        await this.workspaces.git.command(workspace.path, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--name-only',
          '-z',
          this.implementationBase(task)!,
          result.resultRevision,
        ])
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      const expected = [...new Set(result.changedFiles)].sort();
      if (
        JSON.stringify(files) !== JSON.stringify(expected) ||
        triage?.stage !== 'triage' ||
        files.some((p) => !triage.scope.includes(p))
      )
        throw new RelayError(
          'conflict',
          'implementation changed files outside the approved triage scope or omitted changes',
        );
      const tree = async (revision: string) =>
        (
          await this.workspaces.git.command(workspace.path, [
            'rev-parse',
            `${revision}^{tree}`,
          ])
        ).trim();
      const candidateTree = await tree(result.resultRevision);
      const priorRevisions = [
        this.implementationBase(task)!,
        ...history.flatMap((h) =>
          h.result.stage === 'implement'
            ? [h.result.baseRevision, h.result.resultRevision]
            : [],
        ),
      ];
      for (const revision of unchangedCandidate && newDispute
        ? []
        : new Set(priorRevisions)) {
        if (candidateTree === (await tree(revision)))
          throw new RelayError(
            'conflict',
            'implementation repeats an earlier code tree; no progress',
          );
      }
      const validation = await this.verifier.run(
        task,
        run,
        workspace,
        result.resultRevision,
      );
      if (!validation.stopped)
        throw new RelayError('conflict', 'verification stop is unknown');
      codeRevision = result.resultRevision;
      if (validation.status === 'passed') stage = 'code_review';
      else retry('implement', 'trusted verification failed');
    } else {
      const subject = latest(
        result.stage === 'design_review' ? 'design' : 'implement',
      );
      if (
        !subject ||
        subject.runId !== result.subjectRunId ||
        (result.stage === 'code_review' &&
          (subject.result.stage !== 'implement' ||
            subject.result.resultRevision !== task.codeRevision))
      )
        throw new RelayError(
          'conflict',
          'review is not bound to the latest candidate',
        );
      if (
        new Set(result.findings.map((f) => f.id)).size !==
        result.findings.length
      )
        throw new RelayError('invalid', 'duplicate finding identifiers');
      if (
        result.resolutions.some((r) => !unresolved.has(r.findingId)) ||
        new Set(result.resolutions.map((r) => r.findingId)).size !==
          result.resolutions.length
      )
        throw new RelayError(
          'conflict',
          'review resolutions require unique outstanding finding IDs',
        );
      for (const resolution of result.resolutions)
        unresolved.delete(resolution.findingId);
      for (const finding of result.findings)
        if (finding.severity === 'blocking')
          unresolved.set(finding.id, finding.origin);
      const needsRepair =
        result.verdict === 'revise' ||
        [...unresolved.values()].some(
          (origin) => result.stage === 'code_review' || origin === 'design',
        );
      if (
        result.verdict === 'revise' &&
        result.findings.length === 0 &&
        unresolved.size === 0
      )
        throw new RelayError(
          'invalid',
          'revision requires actionable findings',
        );
      const criteria =
        triage?.stage === 'triage'
          ? triage.acceptance.map((c) => c.id).sort()
          : [];
      if (
        !needsRepair &&
        JSON.stringify(result.coverage.map((c) => c.criterionId).sort()) !==
          JSON.stringify(criteria)
      )
        throw new RelayError(
          'conflict',
          'review must cover every acceptance criterion exactly once',
        );
      if (needsRepair) {
        retry(
          result.stage === 'design_review' ||
            [...unresolved.values()].includes('design')
            ? 'design'
            : 'implement',
          'review requires evidence-backed repair',
        );
      } else if (result.stage === 'code_review') {
        if (!this.verifier.accepted(task))
          throw new RelayError(
            'conflict',
            'trusted verification is required before local delivery',
          );
        const implementation = this.workspaces
          .list(task.id)
          .find((w) => w.kind === 'implementation');
        if (
          !implementation ||
          (await this.workspaces.git.verify(implementation, true)) !==
            task.codeRevision
        )
          throw new RelayError(
            'conflict',
            'implementation changed during review',
          );
        stage = 'deliver';
        status = 'succeeded';
      } else stage = 'implement';
    }
    const record = handoffRecordSchema.parse({
      runId: run.id,
      taskId: task.id,
      artifactId,
      evidence: run.evidence,
      result,
    });
    return {
      status,
      stage,
      codeRevision,
      iterationsUsed,
      diagnostic,
      persist: () => {
        const current = this.workspaces.tasks.get(task.id);
        if (
          current.stage !== task.stage ||
          current.requirementVersion !== task.requirementVersion ||
          current.codeRevision !== task.codeRevision
        )
          throw new RelayError(
            'conflict',
            'task changed before handoff settlement',
          );
        if (result.stage === 'implement') {
          const w = this.workspaces
            .list(task.id)
            .find((w) => w.kind === 'implementation')!;
          this.workspaces.tasks.db.sql
            .prepare('UPDATE workspaces SET document=? WHERE id=?')
            .run(JSON.stringify({ ...w, confirmedCandidate: null }), w.id);
        }
        this.workspaces.tasks.db.sql
          .prepare(
            'INSERT INTO handoffs(run_id,task_id,document) VALUES(?,?,?)',
          )
          .run(run.id, task.id, JSON.stringify(record));
      },
    };
  }
  async reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'> {
    const states = await Promise.all([
      this.verifier.reconcile(run),
      this.workspaces.stopPending(run.taskId),
    ]);
    return states.every((s) => s === 'stopped') ? 'stopped' : 'unknown';
  }
  async cancel(run: Run): Promise<'stopped' | 'unknown'> {
    const states = await Promise.all([
      this.verifier.cancel(run),
      this.workspaces.stopPending(run.taskId),
    ]);
    return states.every((s) => s === 'stopped') ? 'stopped' : 'unknown';
  }
}
