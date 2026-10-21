import { roleSchema } from '../core/config.ts';
import type { Profile } from '../core/config.ts';
import type { Advance } from '../core/handoff.ts';
import { randomUUID } from 'node:crypto';
import { runSchema } from '../core/contracts.ts';
import type { Run, Task } from '../core/contracts.ts';
import type { AgentEvent } from '../core/execution.ts';
import { RelayError } from '../core/errors.ts';
import type { Tasks } from './tasks.ts';

export class Runs {
  readonly tasks: Tasks;
  constructor(tasks: Tasks) {
    this.tasks = tasks;
  }
  get(id: string): Run {
    const row = this.tasks.db.sql
      .prepare('SELECT document FROM runs WHERE id=?')
      .get(id);
    if (!row) throw new RelayError('not_found', 'run does not exist');
    return runSchema.parse(JSON.parse(String(row.document)));
  }
  outstanding(): Run[] {
    return this.tasks.db.sql
      .prepare("SELECT document FROM runs WHERE status!='stopped'")
      .all()
      .map((row) => runSchema.parse(JSON.parse(String(row.document))));
  }
  forTask(taskId: string): Run[] {
    return this.tasks.db.sql
      .prepare('SELECT document FROM runs WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => runSchema.parse(JSON.parse(String(row.document))));
  }
  claim(
    taskId: string,
    executorVersion: string,
    now = Date.now(),
    role: Profile['role'] = 'design',
  ): Run | null {
    roleSchema.parse(role);
    return this.tasks.db.transaction(() => {
      const task = this.tasks.get(taskId);
      if (task.status !== 'queued' || this.outstanding().length > 0)
        return null;
      if (
        task.runsUsed >= task.config.budget.maxRuns ||
        now >= task.deadlineAt
      ) {
        const blocked = this.tasks.save(task, {
          ...task,
          status: 'blocked',
          diagnostic: 'task budget exhausted',
        });
        this.tasks.append(
          taskId,
          null,
          `budget:${blocked.version}`,
          'task.blocked',
          'task budget exhausted',
          now,
        );
        return null;
      }
      const run = runSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        taskId,
        attempt: task.runsUsed + 1,
        profile: task.config.profiles[role],
        executorVersion,
        evidence: {
          requirementVersion: task.requirementVersion,
          codeRevision: task.codeRevision,
        },
        status: 'active',
        owner: randomUUID(),
        leaseUntil: now + task.config.leaseMs,
        startedAt: now,
        continuation: null,
        outcome: null,
      });
      this.tasks.db.sql
        .prepare('INSERT INTO runs(id,task_id,document) VALUES(?,?,?)')
        .run(run.id, taskId, JSON.stringify(run));
      this.tasks.save(task, {
        ...task,
        status: 'running',
        runsUsed: task.runsUsed + 1,
        diagnostic: null,
      });
      this.tasks.append(
        taskId,
        run.id,
        `claim:${run.id}`,
        'run.claimed',
        'execution claimed',
        now,
      );
      return run;
    });
  }
  private update(run: Run): Run {
    const checked = runSchema.parse(run);
    this.tasks.db.sql
      .prepare('UPDATE runs SET document=? WHERE id=?')
      .run(JSON.stringify(checked), run.id);
    return checked;
  }
  private owned(run: Run, now: number): Run {
    const current = this.get(run.id);
    if (
      current.owner !== run.owner ||
      current.status !== 'active' ||
      current.leaseUntil <= now
    ) {
      throw new RelayError(
        'conflict',
        'run lease is stale or no longer active',
      );
    }
    return current;
  }
  renew(run: Run, now = Date.now()): Run {
    return this.tasks.db.transaction(() => {
      const current = this.owned(run, now);
      return this.update({
        ...current,
        leaseUntil: now + this.tasks.get(run.taskId).config.leaseMs,
      });
    });
  }
  record(run: Run, event: AgentEvent, now = Date.now()): void {
    this.tasks.db.transaction(() => {
      this.owned(run, now);
      this.tasks.append(
        run.taskId,
        run.id,
        `${run.id}:${event.key}`,
        event.type,
        event.message,
        now,
      );
    });
  }
  finish(
    run: Run,
    outcome: {
      status: 'succeeded' | 'failed' | 'waiting_user' | 'blocked' | 'queued';
      diagnostic: string | null;
      question: Task['question'];
      continuation: string | null;
    },
    now = Date.now(),
    advance?: Advance,
  ): Task {
    return this.tasks.db.transaction(() => {
      const current = this.owned(run, now);
      const task = this.tasks.get(run.taskId);
      const status =
        task.control === 'cancel'
          ? 'cancelled'
          : task.control === 'pause'
            ? 'paused'
            : outcome.status;
      this.update({
        ...current,
        status: 'stopped',
        continuation: outcome.continuation,
        outcome: status,
      });
      if (!task.control) advance?.persist();
      this.releaseWorkspace(current);
      const saved = this.tasks.save(task, {
        ...task,
        status,
        ...(!task.control && advance
          ? {
              stage: advance.stage,
              codeRevision: advance.codeRevision,
              iterationsUsed: advance.iterationsUsed,
            }
          : {}),
        control: null,
        diagnostic: outcome.diagnostic,
        question: status === 'waiting_user' ? outcome.question : null,
      });
      this.tasks.append(
        task.id,
        run.id,
        `finish:${run.id}`,
        'run.finished',
        status,
        now,
      );
      return saved;
    });
  }
  private releaseWorkspace(run: Run): void {
    this.tasks.db.sql
      .prepare('DELETE FROM workspace_access WHERE run_id=? AND owner=?')
      .run(run.id, run.owner);
  }
  quarantine(run: Run, diagnostic: string): void {
    this.tasks.db.transaction(() => {
      const current = this.get(run.id);
      if (current.owner !== run.owner || current.status === 'stopped') return;
      this.quarantineInside(current, diagnostic);
    });
  }
  private quarantineInside(run: Run, diagnostic: string): void {
    this.update({ ...run, status: 'unknown', outcome: 'needs_reconciliation' });
    const task = this.tasks.get(run.taskId);
    const saved = this.tasks.save(task, {
      ...task,
      status: 'recovering',
      diagnostic,
    });
    this.tasks.append(
      task.id,
      run.id,
      `recover:${run.id}:${saved.version}`,
      'run.recovering',
      diagnostic,
    );
  }
  expire(now = Date.now()): void {
    this.tasks.db.transaction(() => {
      for (const run of this.outstanding()) {
        if (run.status === 'active' && run.leaseUntil <= now)
          this.quarantineInside(run, 'lease expired; stop must be reconciled');
      }
    });
  }
  confirmStopped(runId: string): Task {
    return this.tasks.db.transaction(() => {
      const run = this.get(runId);
      if (run.status !== 'unknown')
        throw new RelayError(
          'conflict',
          'only quarantined runs can be reconciled',
        );
      const task = this.tasks.get(run.taskId);
      const status =
        task.control === 'cancel'
          ? 'cancelled'
          : task.control === 'pause'
            ? 'paused'
            : 'blocked';
      this.update({ ...run, status: 'stopped', outcome: 'reconciled_stop' });
      this.releaseWorkspace(run);
      const saved = this.tasks.save(task, {
        ...task,
        status,
        control: null,
        diagnostic: 'execution stopped; previous result was not accepted',
      });
      this.tasks.append(
        task.id,
        run.id,
        `reconciled:${run.id}`,
        'run.reconciled',
        status,
      );
      return saved;
    });
  }
}
