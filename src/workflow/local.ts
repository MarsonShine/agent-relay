import { z } from 'zod';
import { digest, Verifier } from '../verification/runner.ts';
import type { Profile } from '../core/config.ts';
import type { Run, Task } from '../core/contracts.ts';
import { handoffSchema, handoffRecordSchema } from '../core/handoff.ts';
import type { Handoff, HandoffRecord } from '../core/handoff.ts';
import type { ExecutionRequest } from '../core/execution.ts';
import { RelayError } from '../core/errors.ts';
import type { Evidence } from '../storage/evidence.ts';
import type { Workspaces } from '../workspace/manager.ts';

import type { Advance } from '../core/handoff.ts';

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
  context(task: Task): NonNullable<ExecutionRequest['handoff']> {
    const result = {
      contractVersion: 'M2-handoff-v1' as const,
      resultSchema: z.toJSONSchema(handoffSchema, { target: 'draft-7' }),
      history: this.history(task),
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
    const unresolved = new Map<string, string>();
    for (const entry of history) {
      const review = entry.result;
      if (review.stage !== 'design_review' && review.stage !== 'code_review')
        continue;
      for (const resolution of review.resolutions)
        unresolved.delete(resolution.findingId);
      for (const finding of review.findings)
        if (finding.severity === 'blocking')
          unresolved.set(finding.id, finding.origin);
    }
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
      if (
        result.stage === 'design' &&
        latest('design') !== undefined &&
        digest(result) === digest(latest('design')?.result)
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
      if (
        !workspace ||
        result.baseRevision !== task.codeRevision ||
        result.unresolved.length ||
        (await this.workspaces.git.verify(workspace, true)) !==
          result.resultRevision ||
        result.resultRevision === task.codeRevision
      )
        throw new RelayError(
          'conflict',
          'implementation requires a new clean committed result with no unresolved work',
        );
      const files = (
        await this.workspaces.git.command(workspace.path, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--name-only',
          '-z',
          task.codeRevision!,
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
      const needsRepair = result.verdict === 'revise' || unresolved.size > 0;
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
        this.workspaces.tasks.db.sql
          .prepare(
            'INSERT INTO handoffs(run_id,task_id,document) VALUES(?,?,?)',
          )
          .run(run.id, task.id, JSON.stringify(record));
      },
    };
  }
  async reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'> {
    return this.verifier.reconcile(run);
  }
  async cancel(run: Run): Promise<'stopped' | 'unknown'> {
    return this.verifier.cancel(run);
  }
}
