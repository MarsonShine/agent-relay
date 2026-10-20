import { runtimeSchema } from './development.ts';
import type { DevelopmentRuntime } from './development.ts';
import { CodexExecutor } from '../adapters/codex/executor.ts';
import { WorkspaceExecutor } from '../workspace/executor.ts';
import { Workspaces } from '../workspace/manager.ts';
import {
  GitWorktrees,
  destination,
  inside,
  pathKey,
} from '../workspace/git.ts';
import { LocalWorkflow } from '../workflow/local.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { configSchema, defaultConfig } from '../core/config.ts';
import type { Config } from '../core/config.ts';
import { commandSchema, idSchema } from '../core/contracts.ts';
import { RelayError } from '../core/errors.ts';
import { Database } from '../storage/database.ts';
import { Tasks } from '../storage/tasks.ts';
import { Evidence } from '../storage/evidence.ts';
import { FakeExecutor } from '../adapters/fake.ts';
import { Controller } from '../workflow/controller.ts';
import {
  authorize,
  connection,
  ensureToken,
  jsonBody,
  privateDirectory,
} from './local.ts';

const createSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestKey: z.string().min(1).max(128),
  repo: z.string().min(1).max(4096),
  input: z.string().min(1).max(32768),
});
const mutationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  command: commandSchema,
});
const executeFile = promisify(execFile);
async function revision(repo: string): Promise<string | null> {
  try {
    const { stdout } = await executeFile(
      'git',
      ['rev-parse', '--verify', 'HEAD'],
      { cwd: repo, windowsHide: true, timeout: 5_000, maxBuffer: 4096 },
    );
    return /^[a-f0-9]{40,64}$/.test(stdout.trim()) ? stdout.trim() : null;
  } catch {
    return null;
  }
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify({ schemaVersion: 1, ...(body as object) }));
}
export async function startService(options: {
  directory: string;
  port?: number;
  config?: Config;
  autoSchedule?: boolean;
  development?: DevelopmentRuntime;
}) {
  const config = configSchema.parse(options.config ?? defaultConfig());
  const directory = await destination(options.directory);
  const runtime = options.development
    ? runtimeSchema.parse(options.development)
    : undefined;
  if (runtime && process.platform !== 'win32')
    throw new RelayError(
      'invalid',
      'development runtime is validated only on Windows',
    );
  let registeredRepo: string | undefined;
  if (runtime) {
    registeredRepo = (await new GitWorktrees().identity(runtime.repo)).repo;
    const root = await destination(runtime.workspaces);
    if (
      inside(registeredRepo, directory) ||
      inside(root, directory) ||
      inside(directory, root)
    )
      throw new RelayError(
        'invalid',
        'controller data and workspace roots must be separate from each other and the target checkout',
      );
    if (
      !config.verification ||
      !config.allowedFiles ||
      Object.values(config.profiles).some((p) => p.executor !== 'codex-cli') ||
      config.profiles.implement.permission !== 'workspace-write'
    )
      throw new RelayError(
        'invalid',
        'development requires Codex profiles, trusted allowedFiles and verification commands',
      );
    await new GitWorktrees().preflight(
      registeredRepo,
      await new GitWorktrees().head(registeredRepo),
      config.allowedFiles,
    );
  }
  privateDirectory(directory);
  const backend = runtime
    ? new CodexExecutor({
        command: {
          executable: runtime.command.executable,
          prefixArgs: runtime.command.prefixArgs ?? [],
        },
        directory: join(directory, 'executions'),
        protectedPaths: [directory],
      })
    : new FakeExecutor();
  if (backend instanceof CodexExecutor) await backend.doctor();
  const token = ensureToken(directory);
  const previous = connection(directory);
  const port = options.port ?? previous?.port ?? 4318;
  if (previous && port !== previous.port)
    throw new RelayError(
      'conflict',
      'this data directory is registered to another port; reuse its saved port',
    );
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new RelayError('invalid', 'invalid port');
  const db = new Database(join(directory, 'state.db'));
  const tasks = new Tasks(db, [token]);
  const evidence = new Evidence(tasks, join(directory, 'evidence'), [token]);
  const workspaces = runtime
    ? new Workspaces(tasks, runtime.workspaces)
    : undefined;
  const workflow = workspaces
    ? new LocalWorkflow(workspaces, evidence)
    : undefined;
  if (
    registeredRepo &&
    tasks
      .list()
      .some(
        (t) =>
          !['succeeded', 'failed', 'cancelled'].includes(t.status) &&
          pathKey(t.repo) !== pathKey(registeredRepo!),
      )
  ) {
    db.close();
    throw new RelayError(
      'conflict',
      'data directory contains another registered repository',
    );
  }
  const controller = new Controller(
    tasks,
    evidence,
    workspaces ? new WorkspaceExecutor(backend, workspaces) : backend,
    workflow,
  );
  let listeningPort = 0;
  let schedulerError: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | null = null;
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      authorize(request, listeningPort, token);
      const url = new URL(
        request.url ?? '/',
        `http://127.0.0.1:${listeningPort}`,
      );
      const method = request.method;
      if (url.pathname === '/v1/health' && method === 'GET') {
        send(response, 200, {
          backend: runtime ? 'codex-cli' : 'simulation',
          schedulerError,
          outstandingRuns: controller.runs.outstanding().length,
        });
        return;
      }
      if (url.pathname === '/v1/tasks' && method === 'POST') {
        const input = createSchema.parse(await jsonBody(request));
        let repo: string;
        try {
          repo = realpathSync(input.repo);
          if (!statSync(repo).isDirectory()) throw new Error();
        } catch {
          throw new RelayError(
            'invalid',
            'repository directory is unavailable',
          );
        }
        if (registeredRepo && pathKey(repo) !== pathKey(registeredRepo))
          throw new RelayError(
            'invalid',
            'repository is not registered in trusted runtime configuration',
          );
        const task = tasks.create({
          ...(runtime ? { kind: 'development' as const } : {}),
          ...input,
          repo,
          config,
          codeRevision: await revision(repo),
        });
        send(response, 200, { task });
        return;
      }
      const route = /^\/v1\/tasks\/([^/]+)(?:\/(events|commands))?$/.exec(
        url.pathname,
      );
      if (route) {
        const id = idSchema.parse(route[1]);
        if (!route[2] && method === 'GET') {
          const task = tasks.get(id);
          const issues = evidence.diagnose(id);
          const artifacts = evidence.list(id);
          if (
            task.status === 'succeeded' &&
            !artifacts.some(
              (artifact) =>
                artifact.kind === 'result' &&
                artifact.evidence.requirementVersion ===
                  task.requirementVersion &&
                artifact.evidence.codeRevision === task.codeRevision,
            )
          ) {
            issues.push('completed task is missing matching result metadata');
          }
          if (
            task.kind === 'development' &&
            task.stage === 'deliver' &&
            task.status === 'succeeded'
          ) {
            if (!workflow?.verifier.accepted(task))
              issues.push('current candidate lacks intact trusted validation');
            try {
              const w = workspaces
                ?.list(task.id)
                .find((w) => w.kind === 'implementation');
              if (
                !w ||
                (await workspaces!.git.verify(w, true)) !== task.codeRevision
              )
                issues.push('delivered workspace changed');
            } catch {
              issues.push('delivered workspace cannot be verified');
            }
          }
          send(response, 200, {
            task,
            ...(workflow
              ? {
                  handoffs: workflow.history(task),
                  validations: workflow.verifier.reports(task),
                  workspaces: workspaces!.list(task.id),
                }
              : {}),
            artifacts,
            evidenceIssues: issues,
            accepted: task.status === 'succeeded' && issues.length === 0,
            runs: controller.runs.forTask(id).map((run) => ({
              id: run.id,
              attempt: run.attempt,
              status: run.status,
              evidence: run.evidence,
              outcome: run.outcome,
            })),
          });
          return;
        }
        if (route[2] === 'events' && method === 'GET') {
          if (
            [...url.searchParams.keys()].some(
              (key) => !['after', 'limit'].includes(key),
            )
          )
            throw new RelayError('invalid', 'unknown event query parameter');
          const events = tasks.events(
            id,
            Number(url.searchParams.get('after') ?? 0),
            Number(url.searchParams.get('limit') ?? 100),
          );
          send(response, 200, {
            events,
            nextCursor:
              events.at(-1)?.sequence ??
              Number(url.searchParams.get('after') ?? 0),
          });
          return;
        }
        if (route[2] === 'commands' && method === 'POST') {
          const input = mutationSchema.parse(await jsonBody(request));
          send(response, 200, { task: tasks.command(id, input.command) });
          return;
        }
      }
      const artifactRoute = /^\/v1\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (artifactRoute && method === 'GET') {
        send(response, 200, {
          content: evidence.read(idSchema.parse(artifactRoute[1])),
        });
        return;
      }
      throw new RelayError('not_found', 'unknown local endpoint');
    } catch (error) {
      const code =
        error instanceof RelayError
          ? error.code
          : error instanceof z.ZodError
            ? 'invalid'
            : 'storage';
      const status = {
        invalid: 400,
        unauthorized: 401,
        not_found: 404,
        conflict: 409,
        storage: 500,
      }[code];
      const message =
        error instanceof RelayError
          ? error.message
          : code === 'invalid'
            ? 'request does not match the versioned schema'
            : 'internal storage or execution failure';
      if (!response.destroyed)
        send(response, status, { error: { code, message } });
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new RelayError('storage', 'unexpected listener address');
    listeningPort = address.port;
    if (!previous)
      writeFileSync(
        join(directory, 'connection.json'),
        JSON.stringify({ schemaVersion: 1, port: listeningPort }),
        { flag: 'wx', mode: 0o600 },
      );
  } catch (error) {
    server.close();
    db.close();
    throw error;
  }
  const pump = async () => {
    try {
      await controller.tick();
    } catch {
      schedulerError =
        'scheduler halted; inspect database and outstanding runs before restarting';
      clearInterval(timer);
    }
  };
  if (options.autoSchedule !== false) {
    timer = setInterval(() => {
      void pump();
    }, 100);
    await pump();
  }
  return {
    port: listeningPort,
    tasks,
    controller,
    evidence,
    close(): Promise<void> {
      closing ??= (async () => {
        clearInterval(timer);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
        await controller.close();
        db.close();
      })();
      return closing;
    },
  };
}
