import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch, release } from 'node:os';
import { z } from 'zod';
import type { Run, Task } from '../core/contracts.ts';
import { evidenceSchema } from '../core/contracts.ts';
import { RelayError } from '../core/errors.ts';
import { mkdirSync, existsSync } from 'node:fs';
import { OwnedProcess, stopOwned } from '../runtime/owned-process.ts';
import { Runs } from '../storage/runs.ts';
import { redact } from '../storage/redaction.ts';
import { inside } from '../workspace/git.ts';
import type { Workspaces } from '../workspace/manager.ts';
import type { Workspace } from '../workspace/contracts.ts';
import { verificationPolicySchema } from './contracts.ts';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const validationSchema = z.strictObject({
  runId: z.uuid(),
  taskId: z.uuid(),
  evidence: evidenceSchema,
  policyHash: sha,
  status: z.enum(['passed', 'failed', 'unknown']),
  stopped: z.boolean(),
  environment: z.strictObject({
    platform: z.string(),
    arch: z.string(),
    os: z.string(),
    node: z.string(),
  }),
  checks: z.array(
    z.strictObject({
      id: z.string(),
      version: z.number(),
      definitionHash: sha,
      exitCode: z.number().int().nullable(),
      stopped: z.boolean(),
      reason: z.string().nullable(),
      log: z.string(),
      logHash: sha,
      startedAt: z.number(),
      completedAt: z.number(),
    }),
  ),
});
export type Validation = z.infer<typeof validationSchema>;
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Active = {
  owner: string;
  cancelled: boolean;
  process: OwnedProcess | null;
  stopped: boolean;
};
export class Verifier {
  readonly workspaces: Workspaces;
  private active = new Map<string, Active>();
  constructor(workspaces: Workspaces) {
    this.workspaces = workspaces;
  }
  private owned(run: Run): void {
    const current = new Runs(this.workspaces.tasks).get(run.id),
      task = this.workspaces.tasks.get(run.taskId);
    if (
      current.owner !== run.owner ||
      current.status !== 'active' ||
      current.leaseUntil <= Date.now() ||
      task.control ||
      task.requirementVersion !== run.evidence.requirementVersion ||
      task.codeRevision !== run.evidence.codeRevision
    )
      throw new RelayError(
        'conflict',
        'verification lost active run ownership',
      );
  }
  async run(
    task: Task,
    run: Run,
    workspace: Workspace,
    revision: string,
  ): Promise<Validation> {
    const policy = verificationPolicySchema.parse(task.config.verification);
    if (
      workspace.taskId !== task.id ||
      workspace.kind !== 'implementation' ||
      !this.workspaces.tasks.db.sql
        .prepare(
          'SELECT 1 FROM workspace_access WHERE workspace_id=? AND run_id=? AND owner=?',
        )
        .get(workspace.id, run.id, run.owner)
    )
      throw new RelayError(
        'conflict',
        'verification requires the owned implementation workspace',
      );
    if (this.active.has(run.id))
      throw new RelayError('conflict', 'verification already reserved');
    const state: Active = {
      owner: run.owner,
      cancelled: false,
      process: null,
      stopped: true,
    };
    this.active.set(run.id, state);
    const checks: Validation['checks'] = [];
    for (const [index, command] of policy.commands.entries()) {
      this.owned(run);
      if (state.cancelled)
        throw new RelayError('conflict', 'verification cancelled');
      if ((await this.workspaces.git.verify(workspace, true)) !== revision)
        throw new RelayError('conflict', 'verification revision changed');
      const cwd = await realpath(join(workspace.path, command.cwd));
      if (!inside(workspace.path, cwd))
        throw new RelayError('invalid', 'check cwd escapes workspace');
      this.owned(run);
      if (state.cancelled)
        throw new RelayError('conflict', 'verification cancelled');
      let raw = '';
      const out = new StringDecoder('utf8'),
        err = new StringDecoder('utf8');
      const startedAt = Date.now();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|CI)$/i.test(
            k,
          ),
        ),
      );
      state.stopped = false;
      this.owned(run);
      if (state.cancelled)
        throw new RelayError('conflict', 'verification cancelled');
      mkdirSync(this.processRoot(), { recursive: true, mode: 0o700 });
      state.process = new OwnedProcess(
        this.processDirectory(run, index),
        run.owner,
        { executable: command.executable },
        command.args,
        {
          cwd,
          env,
          input: '',
          timeoutMs: Math.max(
            1,
            Math.min(command.timeoutMs, task.deadlineAt - Date.now()),
          ),
          maxBytes: policy.maxLogBytes,
          stdout: (b) => {
            raw += out.write(b);
          },
          stderr: (b) => {
            raw += err.write(b);
          },
        },
      );
      const exit = await state.process.done;
      state.stopped = exit.stopped;
      raw += out.end() + err.end();
      const log = redact(raw, this.workspaces.tasks.secrets);
      checks.push({
        id: command.id,
        version: command.version,
        definitionHash: digest(command),
        exitCode: exit.code,
        stopped: exit.stopped,
        reason: exit.reason,
        log,
        logHash: digest(log),
        startedAt,
        completedAt: Date.now(),
      });
      if (!exit.stopped || exit.code !== 0 || exit.reason || state.cancelled)
        break;
    }
    let clean = false;
    if (state.stopped) {
      this.owned(run);
      clean = (await this.workspaces.git.verify(workspace, true)) === revision;
    }
    const report = validationSchema.parse({
      runId: run.id,
      taskId: task.id,
      evidence: {
        requirementVersion: task.requirementVersion,
        codeRevision: revision,
      },
      policyHash: digest(policy),
      status: !state.stopped
        ? 'unknown'
        : clean &&
            !state.cancelled &&
            checks.length === policy.commands.length &&
            checks.every(
              (c) => c.exitCode === 0 && c.reason === null && c.stopped,
            )
          ? 'passed'
          : 'failed',
      stopped: state.stopped,
      environment: {
        platform: platform(),
        arch: arch(),
        os: release(),
        node: process.version,
      },
      checks,
    });
    this.workspaces.tasks.db.transaction(() => {
      this.owned(run);
      this.workspaces.tasks.db.sql
        .prepare('INSERT INTO validations VALUES(?,?,?)')
        .run(run.id, task.id, JSON.stringify(report));
    });
    return report;
  }
  reports(task: Task): Validation[] {
    return this.workspaces.tasks.db.sql
      .prepare(
        'SELECT document FROM validations WHERE task_id=? ORDER BY rowid',
      )
      .all(task.id)
      .map((r) => validationSchema.parse(JSON.parse(String(r.document))));
  }
  accepted(task: Task): boolean {
    const report = this.reports(task).at(-1),
      policy = task.config.verification;
    return (
      !!report &&
      !!policy &&
      report.status === 'passed' &&
      report.stopped &&
      report.evidence.codeRevision === task.codeRevision &&
      report.evidence.requirementVersion === task.requirementVersion &&
      report.policyHash === digest(policy) &&
      report.checks.length === policy.commands.length &&
      report.checks.every(
        (c, i) =>
          c.id === policy.commands[i]!.id &&
          c.definitionHash === digest(policy.commands[i]) &&
          c.exitCode === 0 &&
          c.stopped &&
          c.reason === null &&
          c.logHash === digest(c.log),
      )
    );
  }
  private processRoot(): string {
    return this.workspaces.tasks.db.path + '.processes';
  }
  private processDirectory(run: Run, index: number): string {
    return join(this.processRoot(), `${run.id}-${run.owner}-${index}`);
  }
  private async recover(run: Run): Promise<'stopped' | 'unknown'> {
    const commands =
      this.workspaces.tasks.get(run.taskId).config.verification?.commands ?? [];
    if (
      !run.recoveryVersion &&
      !commands.some((_, i) => existsSync(this.processDirectory(run, i)))
    )
      return 'unknown';
    const states = await Promise.all(
      commands.map((_, index) =>
        stopOwned(this.processDirectory(run, index), run.owner),
      ),
    );
    return states.every((s) => s === 'stopped') ? 'stopped' : 'unknown';
  }
  async reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'> {
    const state = this.active.get(run.id);
    if (!state) return this.recover(run);
    if (state.owner !== run.owner) return 'unknown';
    return state.process
      ? state.process.status()
      : state.stopped
        ? 'stopped'
        : 'active';
  }
  async cancel(run: Run): Promise<'stopped' | 'unknown'> {
    const state = this.active.get(run.id);
    if (!state) {
      // A cancelled launch must stay cancelled even if role completion arrives later.
      this.active.set(run.id, {
        owner: run.owner,
        cancelled: true,
        process: null,
        stopped: true,
      });
      return this.recover(run);
    }
    if (state.owner !== run.owner) return 'unknown';
    state.cancelled = true;
    return state.process
      ? state.process.stop()
      : state.stopped
        ? 'stopped'
        : 'unknown';
  }
}
