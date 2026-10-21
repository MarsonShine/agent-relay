import { PassThrough } from 'node:stream';
import type { Run } from '../core/contracts.ts';
import {
  agentEventSchema,
  executionRequestSchema,
  resultSchema,
} from '../core/execution.ts';
import type {
  AgentEvent,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '../core/execution.ts';
import { RelayError } from '../core/errors.ts';
import { WorkspaceAccess } from './access.ts';
import type { Workspaces } from './manager.ts';

type Launch = { owner: string; cancelled: boolean; invoked: boolean };
const terminal = new Set([
  'completed',
  'failed',
  'cancelled',
  'input_required',
]);

/** Supplies registered workspaces and withholds terminal evidence until verification. */
export class WorkspaceExecutor implements Executor {
  readonly backend: Executor;
  readonly access: WorkspaceAccess;
  private readonly launches = new Map<string, Launch>();
  constructor(backend: Executor, workspaces: Workspaces) {
    this.backend = backend;
    this.access = new WorkspaceAccess(workspaces);
  }
  get id() {
    return this.backend.id;
  }
  get version() {
    return this.backend.version;
  }
  get capabilities() {
    return this.backend.capabilities;
  }
  start(request: ExecutionRequest): Promise<ExecutionHandle> {
    return this.launch(request);
  }
  continue(
    request: ExecutionRequest,
    reference: string,
  ): Promise<ExecutionHandle> {
    return this.launch(request, reference);
  }
  private async launch(
    raw: ExecutionRequest,
    reference?: string,
  ): Promise<ExecutionHandle> {
    const request = executionRequestSchema.parse(raw);
    const run = request.run;
    if (
      run.profile.executor !== this.id ||
      run.executorVersion !== this.version ||
      !this.capabilities.permissions.includes(run.profile.permission) ||
      !this.capabilities.cancellation ||
      !this.capabilities.structuredOutput
    )
      throw new RelayError(
        'invalid',
        'backend does not satisfy the frozen run profile',
      );
    if (this.launches.has(run.id))
      throw new RelayError('conflict', 'run already reserved in this executor');
    const state: Launch = {
      owner: run.owner,
      cancelled: false,
      invoked: false,
    };
    this.launches.set(run.id, state);
    const mode =
      run.profile.permission === 'workspace-write'
        ? 'implementation'
        : run.profile.role === 'review' ||
            this.access.workspaces
              .list(run.taskId)
              .some((w) => w.kind === 'implementation')
          ? 'review'
          : 'repository';
    const lease = await this.access.acquire(run, mode);
    await this.access.validate(lease);
    if (state.cancelled)
      throw new RelayError('conflict', 'workspace preparation was cancelled');
    const handoff = executionRequestSchema.parse({
      ...request,
      workspace: this.access.declaration(lease),
    });
    state.invoked = true;
    const handle =
      reference === undefined
        ? await this.backend.start(handoff)
        : await this.backend.continue(handoff, reference);
    const events = new PassThrough({ objectMode: true });
    const result = (async (): Promise<ExecutionResult> => {
      let stopped = false;
      let detached = false;
      try {
        const terminals: AgentEvent[] = [];
        let bytes = 0;
        const consume = async () => {
          for await (const rawEvent of handle.events) {
            if (detached) return;
            const event = agentEventSchema.parse(rawEvent);
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (
              bytes > request.task.config.maxLogBytes ||
              terminals.length >= 16
            )
              throw new RelayError('invalid', 'workspace event limit exceeded');
            if (terminal.has(event.type)) terminals.push(event);
            else events.write(event);
          }
        };
        const [, rawResult] = await Promise.all([consume(), handle.result]);
        const value = resultSchema.parse(rawResult);
        stopped = value.stopped;
        if (!stopped)
          throw new RelayError('conflict', 'backend stop is unconfirmed');
        await this.access.validate(lease);
        if (state.cancelled)
          throw new RelayError('conflict', 'execution was cancelled');
        for (const event of terminals) events.write(event);
        return value;
      } catch {
        if (!stopped) {
          try {
            stopped = (await this.backend.cancel(run)) === 'stopped';
          } catch {
            /* retain occupancy */
          }
        }
        return {
          schemaVersion: 1,
          status: 'unknown',
          stopped,
          evidence: run.evidence,
          output: null,
          question: null,
          continuation: null,
          usage: null,
          diagnostic:
            'workspace or execution verification failed; result was not accepted',
        };
      } finally {
        detached = true;
        events.end();
      }
    })();
    return { events: events as AsyncIterable<AgentEvent>, result };
  }
  async cancel(run: Run): Promise<'stopped' | 'unknown'> {
    const state = this.launches.get(run.id);
    if (!state) return this.backend.cancel(run);
    if (state.owner !== run.owner) return 'unknown';
    state.cancelled = true;
    return state.invoked ? this.backend.cancel(run) : 'stopped';
  }
  async reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'> {
    const state = this.launches.get(run.id);
    if (!state) return this.backend.reconcile(run);
    if (state.owner !== run.owner) return 'unknown';
    return state.invoked
      ? this.backend.reconcile(run)
      : state.cancelled
        ? 'stopped'
        : 'active';
  }
}
