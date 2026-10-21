import { ZodError } from 'zod';
import { existsSync, mkdirSync } from 'node:fs';
import { OwnedProcess, stopOwned } from '../../runtime/owned-process.ts';
import { platform } from 'node:os';
import { isolatedPermissions } from './isolation.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { executionRequestSchema } from '../../core/execution.ts';
import type {
  Executor,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  AgentEvent,
} from '../../core/execution.ts';
import type { Run } from '../../core/contracts.ts';
import { RelayError } from '../../core/errors.ts';
import { redact } from '../../storage/redaction.ts';
import { CodexEvents, testedCodexVersion } from './events.ts';
import { codexEnvironment, codexProfileSchema } from './config.ts';
import {
  bindReference,
  parseFinal,
  jsonSchemaFor,
  invocation,
  prompt,
  sessionFor,
} from './protocol.ts';
import type { Command } from './process.ts';

const execute = promisify(execFile);
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
  );
}
type OwnedRun = {
  owner: string;
  process: OwnedProcess | null;
  cancelled: boolean;
  settled: boolean;
};
export class CodexExecutor implements Executor {
  readonly id = 'codex-cli';
  readonly version = `codex-cli/${testedCodexVersion}`;
  readonly capabilities = {
    continuation: true,
    cancellation: true,
    permissions: ['read-only', 'workspace-write'],
    structuredOutput: true,
    usage: true,
  };
  private readonly command: Command;
  private readonly directory: string;
  private readonly protectedPaths: readonly string[] | undefined;
  private readonly runs = new Map<string, OwnedRun>();
  private verified: Promise<void> | null = null;
  constructor(options: {
    command: Command;
    directory: string;
    protectedPaths?: readonly string[];
  }) {
    if (
      !isAbsolute(options.command.executable) ||
      !isAbsolute(options.directory)
    )
      throw new RelayError('invalid', 'executor paths must be absolute');
    this.command = {
      executable: options.command.executable,
      prefixArgs: [...(options.command.prefixArgs ?? [])],
    };
    this.directory = options.directory;
    this.protectedPaths = options.protectedPaths;
  }
  async doctor(): Promise<void> {
    this.verified ??= (async () => {
      const { stdout } = await execute(
        this.command.executable,
        [...(this.command.prefixArgs ?? []), '--version'],
        {
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 4096,
          env: codexEnvironment(),
        },
      );
      if (stdout.trim() !== `codex-cli ${testedCodexVersion}`)
        throw new RelayError(
          'invalid',
          'Codex CLI version has not been verified',
        );
    })();
    return this.verified;
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
    value: ExecutionRequest,
    reference?: string,
  ): Promise<ExecutionHandle> {
    const request = executionRequestSchema.parse(value);
    const profile = codexProfileSchema.parse(request.run.profile);
    if (!request.workspace)
      throw new RelayError(
        'invalid',
        'Codex requires a controller-provided workspace',
      );
    if (request.run.executorVersion !== this.version)
      throw new RelayError(
        'invalid',
        'run executor version differs from adapter',
      );
    if (this.runs.has(request.run.id))
      throw new RelayError('conflict', 'run already started');
    if (
      request.run.status !== 'active' ||
      request.task.status !== 'running' ||
      request.task.control !== null ||
      Date.now() >= request.run.leaseUntil
    )
      throw new RelayError('conflict', 'run is not owned and active');
    if (Date.now() >= request.task.deadlineAt)
      throw new RelayError('conflict', 'task deadline exhausted');
    for (const [id, retained] of this.runs) {
      if (this.runs.size < 256) break;
      if (retained.settled && retained.process?.status() === 'stopped')
        this.runs.delete(id);
    }
    const state: OwnedRun = {
      owner: request.run.owner,
      process: null,
      cancelled: false,
      settled: false,
    };
    this.runs.set(request.run.id, state);
    try {
      const workspace = await realpath(request.workspace.path);
      const repo = await realpath(request.task.repo);
      if (!(await lstat(workspace)).isDirectory())
        throw new RelayError('invalid', 'workspace is not a directory');
      if (
        profile.permission === 'workspace-write' &&
        (request.workspace.kind !== 'worktree' || inside(repo, workspace))
      ) {
        throw new RelayError(
          'invalid',
          'writing requires an isolated worktree outside the original checkout',
        );
      }
      if (
        profile.permission === 'workspace-write' &&
        request.run.evidence.codeRevision === null
      )
        throw new RelayError(
          'invalid',
          'write run requires a baseline revision',
        );
      const directory = join(this.directory, request.run.id);
      if (inside(workspace, directory))
        throw new RelayError(
          'invalid',
          'execution evidence must be outside the agent workspace',
        );
      if (reference !== undefined) sessionFor(reference, request, workspace);
      await this.doctor();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink())
        throw new RelayError(
          'invalid',
          'executor directory must not be a symlink',
        );
      if (inside(workspace, await realpath(this.directory)))
        throw new RelayError(
          'invalid',
          'execution evidence must be outside the agent workspace',
        );
      await mkdir(directory, { mode: 0o700 }); // Never overwrite an earlier invocation's evidence.
      const schemaPath = join(directory, 'schema.json'),
        outputPath = join(directory, 'final.json');
      await writeFile(schemaPath, JSON.stringify(jsonSchemaFor(request)), {
        flag: 'wx',
        mode: 0o600,
      });
      if (Date.now() >= request.task.deadlineAt)
        throw new RelayError(
          'conflict',
          'task deadline exhausted during preflight',
        );
      if (state.cancelled)
        throw new RelayError(
          'conflict',
          'run was cancelled before process start',
        );
      let temporaryDirectory: string | undefined;
      const environment = codexEnvironment();
      environment.GIT_OPTIONAL_LOCKS = '0';
      if (this.protectedPaths && profile.permission === 'workspace-write') {
        const root = join(dirname(workspace), 'run-temp');
        await mkdir(root, { recursive: true, mode: 0o700 });
        if ((await lstat(root)).isSymbolicLink())
          throw new RelayError('invalid', 'temporary root must not be a link');
        temporaryDirectory = join(await realpath(root), request.run.id);
        await mkdir(temporaryDirectory, { mode: 0o700 });
        environment.TEMP = temporaryDirectory;
        environment.TMP = temporaryDirectory;
      }
      const isolation = this.protectedPaths
        ? await isolatedPermissions(
            request,
            this.protectedPaths,
            temporaryDirectory,
          )
        : undefined;
      if (state.cancelled)
        throw new RelayError(
          'conflict',
          'run cancelled during permission preflight',
        );
      const events = new PassThrough({ objectMode: true });
      const parser = new CodexEvents(testedCodexVersion);
      const stderr: Buffer[] = [];
      mkdirSync(join(this.directory, 'owned'), {
        recursive: true,
        mode: 0o700,
      });
      const process = new OwnedProcess(
        this.processDirectory(request.run),
        request.run.owner,
        this.command,
        invocation(
          request,
          workspace,
          schemaPath,
          outputPath,
          reference,
          platform(),
          isolation,
        ),
        {
          cwd: workspace,
          env: environment,
          input: prompt(request),
          timeoutMs: Math.max(
            1,
            Math.min(profile.timeoutMs, request.task.deadlineAt - Date.now()),
          ),
          maxBytes: Math.min(request.task.config.maxLogBytes, 2 * 1024 * 1024),
          stdout: (chunk) => {
            for (const event of parser.push(chunk)) events.write(event);
          },
          stderr: (chunk) => {
            stderr.push(chunk);
          },
        },
      );
      state.process = process;
      const result = process.done
        .then(async (exit) => {
          const turn = parser.finish(exit.code);
          const continuation = turn.continuation
            ? bindReference(turn.continuation, request, workspace)
            : null;
          const sameSession =
            reference === undefined ||
            (continuation !== null &&
              sessionFor(continuation, request, workspace) ===
                sessionFor(reference, request, workspace));
          const base: ExecutionResult = {
            schemaVersion: 1,
            status: 'unknown',
            stopped: exit.stopped,
            evidence: request.run.evidence,
            output: null,
            question: null,
            continuation: sameSession ? continuation : null,
            diagnostic: null,
            usage: turn.usage,
          };
          const log = redact(Buffer.concat(stderr).toString('utf8'), [
            workspace,
            directory,
          ]);
          try {
            await writeFile(join(directory, 'stderr.txt'), log, {
              flag: 'wx',
              mode: 0o600,
            });
            if (!exit.stopped)
              return {
                ...base,
                diagnostic: 'process stop is unknown; keep the lease',
              };
            if (state.cancelled)
              return {
                ...base,
                status: 'cancelled' as const,
                diagnostic: 'execution cancelled',
              };
            if (exit.reason || turn.outcome !== 'turn_completed')
              return {
                ...base,
                status:
                  turn.outcome === 'failed' || exit.reason
                    ? ('failed' as const)
                    : ('unknown' as const),
                ...(exit.transientFailure
                  ? { failureKind: 'infrastructure' as const }
                  : {}),
                diagnostic:
                  (exit.reason ?? turn.diagnostics.join('; ')) ||
                  'missing terminal result',
              };
            if (!sameSession)
              return { ...base, diagnostic: 'resumed different session' };
            const info = await lstat(outputPath);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.size >
                Math.min(request.task.config.maxArtifactBytes, 262_144)
            )
              throw new Error('invalid final file');
            const final = parseFinal(
              request,
              JSON.parse(await readFile(outputPath, 'utf8')),
            );
            if (
              final.evidence.requirementVersion !==
                request.run.evidence.requirementVersion ||
              final.evidence.codeRevision !== request.run.evidence.codeRevision
            )
              throw new Error('stale evidence');
            if (final.status === 'completed' && !final.output?.trim())
              throw new Error('missing output');
            if (final.status === 'input_required' && !final.question)
              throw new Error('missing question');

            return {
              ...base,
              status:
                final.status === 'blocked'
                  ? ('unknown' as const)
                  : final.status,
              output: final.output,
              question:
                final.status === 'input_required'
                  ? {
                      id: randomUUID(),
                      version: request.task.requirementVersion,
                      text: final.question!,
                    }
                  : null,
              diagnostic:
                final.diagnostic ??
                (final.status === 'blocked' ? 'agent reported blocked' : null),
            };
          } catch (error) {
            return {
              ...base,
              ...(error instanceof SyntaxError || error instanceof ZodError
                ? { failureKind: 'semantic' as const }
                : {}),
              diagnostic:
                'final output missing, invalid, oversized or bound to stale evidence',
            };
          }
        })
        .then((result) => {
          if (state.cancelled && result.stopped)
            result = {
              ...result,
              status: 'cancelled',
              output: null,
              question: null,
              diagnostic: 'execution cancelled',
            };
          if (result.status !== 'unknown')
            events.write({
              schemaVersion: 1,
              key: 'execution-terminal',
              type: result.status,
              message: result.diagnostic ?? `Codex role ${result.status}`,
            } satisfies AgentEvent);
          state.settled = true;
          events.end();
          return result;
        })
        .catch(() => {
          state.settled = true;
          events.end();
          return {
            schemaVersion: 1 as const,
            status: 'unknown' as const,
            stopped: process.status() === 'stopped',
            evidence: request.run.evidence,
            output: null,
            question: null,
            continuation: null,
            diagnostic: 'executor result processing failed',
            usage: null,
          };
        });
      return { events: events as AsyncIterable<AgentEvent>, result };
    } catch (error) {
      state.settled = true;
      throw error;
    }
  }
  private processDirectory(run: Run): string {
    return join(this.directory, 'owned', `${run.id}-${run.owner}`);
  }
  private async recover(run: Run): Promise<'stopped' | 'unknown'> {
    const directory = this.processDirectory(run);
    if (!run.recoveryVersion && !existsSync(directory)) return 'unknown';
    return stopOwned(directory, run.owner);
  }
  async cancel(run: Run): Promise<'stopped' | 'unknown'> {
    const state = this.runs.get(run.id);
    if (!state) return this.recover(run);
    if (state.owner !== run.owner) return 'unknown';
    state.cancelled = true;
    return state.process ? state.process.stop() : 'stopped';
  }
  async reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'> {
    const state = this.runs.get(run.id);
    if (!state) return this.recover(run);
    if (state.owner !== run.owner) return 'unknown';
    return state.process
      ? state.process.status()
      : state.settled || state.cancelled
        ? 'stopped'
        : 'active';
  }
}
