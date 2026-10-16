import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { agentEventSchema, resultSchema } from '../core/execution.ts';
import type {
  AgentEvent,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '../core/execution.ts';
import type { Run } from '../core/contracts.ts';
import { RelayError } from '../core/errors.ts';

type ProcessState = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  stopped: boolean;
  cancelled: boolean;
};
export class FakeExecutor implements Executor {
  readonly id = 'fake';
  readonly version = 'fake-v1';
  readonly capabilities = {
    continuation: false,
    cancellation: true,
    permissions: ['read-only'],
    structuredOutput: true,
    usage: false,
  };
  private readonly processes = new Map<string, ProcessState>();
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (this.processes.has(request.run.id))
      throw new RelayError('conflict', 'run already started in this executor');
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(`fake-child.${extension}`, import.meta.url))],
      {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    // The fixture is a known single leaf process; production tree cancellation belongs to its adapter.
    const events = new PassThrough({ objectMode: true });
    const decoder = new StringDecoder('utf8');
    let pending = '',
      bytes = 0,
      terminal: ExecutionResult | null = null;
    let protocolError: string | null = null;
    let timedOut = false;
    let resolveClosed!: () => void;
    const state: ProcessState = {
      child,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      stopped: false,
      cancelled: false,
    };
    this.processes.set(request.run.id, state);
    const stopForError = (message: string) => {
      protocolError ??= message;
      child.kill();
    };
    const limit = Math.min(
      request.run.profile.timeoutMs,
      Math.max(1, request.task.deadlineAt - Date.now()),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limit);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 524_288) {
        stopForError('executor output limit exceeded');
        return;
      }
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'result' in parsed
          ) {
            if (terminal) throw new Error('multiple terminal results');
            terminal = resultSchema.parse(parsed.result);
          } else {
            events.write(agentEventSchema.parse(parsed));
          }
        } catch {
          stopForError('invalid executor protocol');
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 524_288) stopForError('executor output limit exceeded');
      else
        protocolError ??=
          'fake process wrote stderr; inspect the installed runtime';
    });
    child.on('error', () => {
      protocolError = 'fake process could not start';
    });
    child.stdin.on('error', () => {
      protocolError ??= 'fake process input failed';
    });
    const result = new Promise<ExecutionResult>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timer);
        state.stopped = true;
        resolveClosed();
        events.end();
        pending += decoder.end();
        const fallback: ExecutionResult = {
          schemaVersion: 1,
          status: 'unknown',
          stopped: true,
          evidence: request.run.evidence,
          output: null,
          question: null,
          continuation: null,
          diagnostic: 'missing terminal result',
          usage: null,
        };
        if (state.cancelled)
          resolve({
            ...fallback,
            status: 'cancelled',
            diagnostic: 'execution cancelled',
          });
        else if (timedOut)
          resolve({
            ...fallback,
            status: 'failed',
            diagnostic: 'execution timeout',
          });
        else if (protocolError || pending.trim())
          resolve({
            ...fallback,
            status: 'failed',
            diagnostic: protocolError ?? 'truncated executor output',
          });
        else if (code !== 0)
          resolve({
            ...fallback,
            status: 'failed',
            diagnostic: 'fake process exited unsuccessfully',
          });
        else resolve(terminal ? { ...terminal, stopped: true } : fallback);
      });
    });
    child.stdin.end(
      JSON.stringify({
        native: request.run.profile.native,
        evidence: request.run.evidence,
        answered: request.decisions.some(
          (decision) =>
            decision.requirementVersion === request.task.requirementVersion,
        ),
      }),
    );
    return { events: events as AsyncIterable<AgentEvent>, result };
  }
  async continue(
    _request: ExecutionRequest,
    _reference: string,
  ): Promise<ExecutionHandle> {
    throw new RelayError(
      'invalid',
      'fake executor does not support native continuation',
    );
  }
  async cancel(run: Run): Promise<'stopped' | 'unknown'> {
    const state = this.processes.get(run.id);
    if (!state) return 'unknown';
    if (state.stopped) return 'stopped';
    state.cancelled = true;
    state.child.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      state.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
    clearTimeout(timer);
    return state.stopped ? 'stopped' : 'unknown';
  }
  async reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'> {
    const state = this.processes.get(run.id);
    return state ? (state.stopped ? 'stopped' : 'active') : 'unknown';
  }
}
