import { agentEventSchema, resultSchema } from '../core/execution.ts';
import type { ExecutionResult, Executor } from '../core/execution.ts';
import type { Run, Task } from '../core/contracts.ts';
import { RelayError } from '../core/errors.ts';
import { BoundedLog } from '../storage/evidence.ts';
import type { Evidence } from '../storage/evidence.ts';
import { Runs } from '../storage/runs.ts';
import type { Tasks } from '../storage/tasks.ts';

async function bounded<T>(
  action: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Active = { run: Run; done: Promise<void>; stop: (reason: string) => void };
export class Controller {
  readonly tasks: Tasks;
  readonly runs: Runs;
  readonly evidence: Evidence;
  readonly executor: Executor;
  private active: Active | null = null;
  private ticking = false;
  private closing = false;
  private failure: unknown = null;
  constructor(tasks: Tasks, evidence: Evidence, executor: Executor) {
    this.tasks = tasks;
    this.runs = new Runs(tasks);
    this.evidence = evidence;
    this.executor = executor;
  }
  async tick(): Promise<void> {
    if (this.failure !== null) throw this.failure;
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      this.runs.expire();
      if (this.active) {
        if (this.tasks.get(this.active.run.taskId).control)
          this.active.stop('user requested stop');
        return;
      }
      for (const run of this.runs.outstanding()) {
        if (
          run.status !== 'unknown' ||
          run.profile.executor !== this.executor.id ||
          run.executorVersion !== this.executor.version
        )
          continue;
        const state = await bounded(
          this.executor.reconcile(run),
          1_500,
          'unknown',
        );
        if (state === 'stopped') this.runs.confirmStopped(run.id);
      }
      const task = this.tasks.list('queued')[0];
      if (!task) return;
      const profile = task.config.profiles.design;
      if (
        profile.executor !== this.executor.id ||
        !this.executor.capabilities.permissions.includes(profile.permission) ||
        !this.executor.capabilities.structuredOutput ||
        !this.executor.capabilities.cancellation
      ) {
        this.tasks.db.transaction(() => {
          const current = this.tasks.get(task.id);
          if (current.status !== 'queued') return;
          const saved = this.tasks.save(current, {
            ...current,
            status: 'blocked',
            diagnostic: 'executor capabilities do not satisfy profile',
          });
          this.tasks.append(
            task.id,
            null,
            `capability:${saved.version}`,
            'task.blocked',
            saved.diagnostic!,
          );
        });
        return;
      }
      const run = this.runs.claim(task.id, this.executor.version);
      if (!run) return;
      let stop!: (reason: string) => void;
      const stopping = new Promise<string>((resolve) => {
        stop = resolve;
      });
      const done = this.execute(run, stopping)
        .catch((error) => {
          this.failure = error;
        })
        .finally(() => {
          this.active = null;
        });
      this.active = { run, done, stop };
    } finally {
      this.ticking = false;
    }
  }
  async wait(): Promise<void> {
    await this.active?.done;
    if (this.failure !== null) throw this.failure;
  }
  async close(): Promise<void> {
    this.closing = true;
    if (!this.active) return;
    const task = this.tasks.get(this.active.run.taskId);
    if (!task.control)
      this.tasks.command(task.id, {
        action: 'pause',
        expectedVersion: task.version,
      });
    this.active.stop('service shutdown');
    await this.active.done;
  }
  private async execute(run: Run, stopping: Promise<string>): Promise<void> {
    const task = this.tasks.get(run.taskId);
    const log = new BoundedLog(task.config.maxLogBytes);
    let detached = false;
    let requestStop!: (reason: string) => void;
    const deadline = new Promise<string>((resolve) => {
      requestStop = resolve;
    });
    const timeout = setTimeout(
      () => requestStop('execution deadline exceeded'),
      Math.max(
        1,
        Math.min(run.profile.timeoutMs, task.deadlineAt - Date.now()),
      ),
    );
    const heartbeat = setInterval(
      () => {
        try {
          this.runs.renew(run);
        } catch {
          requestStop('lease lost; reconciliation required');
        }
      },
      Math.floor(task.config.leaseMs / 3),
    );
    const terminalEvents = new Set<string>();
    const processResult = async (): Promise<ExecutionResult> => {
      const handle = await this.executor.start({ task, run });
      if (detached)
        throw new RelayError('conflict', 'execution start returned after stop');
      const consume = async () => {
        for await (const raw of handle.events) {
          if (detached) return;
          const event = agentEventSchema.parse(raw);
          log.append(`${event.type}: ${event.message}\n`);
          this.runs.record(run, event);
          if (
            ['completed', 'failed', 'cancelled', 'input_required'].includes(
              event.type,
            )
          )
            terminalEvents.add(event.type);
        }
      };
      const [, result] = await Promise.all([consume(), handle.result]);
      return resultSchema.parse(result);
    };
    try {
      const winner = await Promise.race([processResult(), stopping, deadline]);
      detached = true;
      if (typeof winner === 'string') {
        await this.stopAndSettle(run, winner, log);
        return;
      }
      if (!winner.stopped) {
        await this.stopAndSettle(
          run,
          'executor result did not confirm stop',
          log,
        );
        return;
      }
      this.evidence.put(run, 'log', log.text(), task.config.maxLogBytes);
      const outcome = this.accept(task, winner, terminalEvents);
      if (outcome.status === 'succeeded') {
        const artifact = this.evidence.put(
          run,
          'result',
          winner.output!,
          task.config.maxArtifactBytes,
        );
        this.evidence.read(artifact.id);
      }
      this.runs.finish(run, { ...outcome, continuation: winner.continuation });
    } catch (error) {
      detached = true;
      const diagnostic =
        error instanceof RelayError
          ? error.message
          : 'executor protocol or persistence failure';
      await this.stopAndSettle(run, diagnostic, log);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }
  private accept(
    task: Task,
    result: ExecutionResult,
    terminals: Set<string>,
  ): {
    status: 'succeeded' | 'failed' | 'waiting_user' | 'blocked';
    diagnostic: string | null;
    question: Task['question'];
  } {
    const blocked = (diagnostic: string) => ({
      status: 'blocked' as const,
      diagnostic,
      question: null,
    });
    if (
      result.evidence.requirementVersion !== task.requirementVersion ||
      result.evidence.codeRevision !== task.codeRevision
    )
      return blocked(
        'result evidence does not match requirement and code revision',
      );
    if (terminals.size > 1) return blocked('conflicting terminal events');
    if (result.status === 'completed') {
      if (!terminals.has('completed') || !result.output?.trim())
        return blocked(
          'completion requires a terminal event and nonempty artifact',
        );
      return { status: 'succeeded', diagnostic: null, question: null };
    }
    if (result.status === 'input_required') {
      if (
        !terminals.has('input_required') ||
        !result.question ||
        result.question.version !== task.requirementVersion
      )
        return blocked('missing or stale question evidence');
      return {
        status: 'waiting_user',
        diagnostic: null,
        question: result.question,
      };
    }
    if (result.status === 'failed')
      return {
        status: 'failed',
        diagnostic: result.diagnostic ?? 'execution failed',
        question: null,
      };
    return blocked(
      result.diagnostic ?? 'execution result requires reconciliation',
    );
  }
  private async stopAndSettle(
    run: Run,
    diagnostic: string,
    log: BoundedLog,
  ): Promise<void> {
    let stop: 'stopped' | 'unknown' = 'unknown';
    try {
      stop = await bounded(this.executor.cancel(run), 1_500, 'unknown');
    } catch {
      /* retain uncertain ownership */
    }
    try {
      const task = this.tasks.get(run.taskId);
      this.evidence.put(run, 'log', log.text(), task.config.maxLogBytes);
    } catch {
      diagnostic += '; log could not be persisted';
    }
    if (stop === 'unknown') {
      this.runs.quarantine(run, diagnostic);
      return;
    }
    const current = this.runs.get(run.id);
    if (current.status === 'stopped') return;
    if (current.status === 'unknown' || current.leaseUntil <= Date.now()) {
      this.runs.quarantine(run, diagnostic);
      this.runs.confirmStopped(run.id);
      return;
    }
    this.runs.finish(run, {
      status: 'blocked',
      diagnostic,
      question: null,
      continuation: null,
    });
  }
}
