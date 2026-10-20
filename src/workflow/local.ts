import { z } from 'zod';
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
  constructor(workspaces: Workspaces, evidence: Evidence) {
    this.workspaces = workspaces;
    this.evidence = evidence;
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
    let stage = task.stage,
      codeRevision = task.codeRevision;
    let status: Advance['status'] = 'queued';
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
      codeRevision = result.resultRevision;
      stage = 'code_review';
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
        result.verdict !== 'approve' ||
        result.findings.some((f) => f.severity === 'blocking')
      )
        throw new RelayError(
          'conflict',
          'blocking feedback requires bounded repair',
        );
      const criteria =
        triage?.stage === 'triage'
          ? triage.acceptance.map((c) => c.id).sort()
          : [];
      if (
        JSON.stringify(result.coverage.map((c) => c.criterionId).sort()) !==
        JSON.stringify(criteria)
      )
        throw new RelayError(
          'conflict',
          'review must cover every acceptance criterion exactly once',
        );
      if (result.stage === 'code_review')
        throw new RelayError(
          'conflict',
          'trusted verification is required before local delivery',
        );
      stage = 'implement';
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
      iterationsUsed: task.iterationsUsed,
      diagnostic: null,
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
  async cancel(_run: Run): Promise<'stopped' | 'unknown'> {
    return 'stopped';
  }
}
