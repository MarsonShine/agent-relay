#!/usr/bin/env node
import { runtimeSchema } from './service/development.ts';
import { parseArgs } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { idSchema, commandSchema } from './core/contracts.ts';
import { configSchema, defaultConfig } from './core/config.ts';
import { RelayError } from './core/errors.ts';
import { callLocal } from './service/client.ts';
import { startService } from './service/server.ts';
import { chat, terminalIO } from './interactive/chat.ts';

const help = `Agent Relay (simulation by default; explicit trusted development runtime required)
node dist/cli.js                    Interactive setup and prompt (terminal only)
node dist/cli.js chat [--demo] [--repo DIR] [--data-dir DIR] [--config FILE] [--runtime FILE] [--port PORT]
node dist/cli.js serve [--data-dir DIR] [--config FILE] [--runtime FILE] [--port PORT]
node dist/cli.js doctor [--data-dir DIR]
node dist/cli.js task import --issue N --key KEY [--data-dir DIR]
node dist/cli.js task publish|reconcile-delivery|complete-delivery|cancel-delivery ID --version N [--data-dir DIR]
node dist/cli.js task feedback ID --version N --input JSON_FILE [--data-dir DIR]
node dist/cli.js task budget ID --version N --max-runs N --input APPROVAL_FILE [--data-dir DIR]
node dist/cli.js task create --repo DIR --input FILE --key KEY [--data-dir DIR]
node dist/cli.js task status ID [--data-dir DIR]
node dist/cli.js task events ID [--after N] [--limit N] [--data-dir DIR]
node dist/cli.js task answer ID --version N --question ID --question-version N --input FILE [--data-dir DIR]
node dist/cli.js task revise ID --version N --requirement-version N --input FILE [--data-dir DIR]
node dist/cli.js task pause|resume|cancel ID --version N [--data-dir DIR]
Management commands output JSON; chat presents prompts and results. Mutations require the task version returned by status.
Development runtime permits bounded Codex calls in managed worktrees. GitHub delivery requires a trusted policy and explicit publication; no automatic merge.`;
function readInput(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 131_072)
    throw new RelayError(
      'invalid',
      'input must be a regular file of at most 128 KiB',
    );
  return readFileSync(path, 'utf8');
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      demo: { type: 'boolean' },
      'data-dir': { type: 'string' },
      config: { type: 'string' },
      runtime: { type: 'string' },
      port: { type: 'string' },
      repo: { type: 'string' },
      input: { type: 'string' },
      key: { type: 'string' },
      issue: { type: 'string' },
      version: { type: 'string' },
      'max-runs': { type: 'string' },
      question: { type: 'string' },
      'question-version': { type: 'string' },
      'requirement-version': { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const [group, action, id] = positionals;
  const interactive = group === 'chat' || group === undefined;
  const directory = resolve(
    values['data-dir'] ??
      join(
        homedir(),
        interactive
          ? values.demo
            ? '.agent-relay-chat-demo'
            : '.agent-relay-chat'
          : '.agent-relay',
      ),
  );
  const requireOption = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value)
      throw new RelayError('invalid', `--${key} is required`);
    return value;
  };
  const validateOptions = (allowed: string[], count: number) => {
    if (
      positionals.length !== count ||
      Object.keys(values).some((key) => !['data-dir', ...allowed].includes(key))
    )
      throw new RelayError(
        'invalid',
        'unexpected command arguments; use --help',
      );
  };
  if (interactive) {
    validateOptions(
      ['demo', 'repo', 'config', 'runtime', 'port'],
      group ? 1 : 0,
    );
    if (!group && !process.stdin.isTTY) {
      console.log(help);
      return;
    }
    const io = terminalIO();
    try {
      process.exitCode = await chat(
        {
          directory,
          ...(values.demo ? { demo: true } : {}),
          ...(values.repo ? { repo: values.repo } : {}),
          ...(values.config ? { config: values.config } : {}),
          ...(values.runtime ? { runtime: values.runtime } : {}),
          ...(values.port !== undefined ? { port: Number(values.port) } : {}),
        },
        io,
      );
    } catch (error) {
      io.write(
        error instanceof RelayError
          ? `未继续执行：${error.message}`
          : '无法启动或继续。请检查配置、服务占用和文件权限；任务记录保留。',
      );
      process.exitCode = io.signal.aborted ? 130 : 1;
    } finally {
      io.close();
    }
    return;
  }
  if (group === 'serve') {
    validateOptions(['config', 'runtime', 'port'], 1);
    const config = values.config
      ? configSchema.parse(JSON.parse(readInput(values.config)))
      : defaultConfig();
    const service = await startService({
      directory,
      config,
      ...(values.runtime
        ? {
            development: runtimeSchema.parse(
              JSON.parse(readInput(values.runtime)),
            ),
          }
        : {}),
      ...(values.port === undefined ? {} : { port: Number(values.port) }),
    });
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        listening: `http://127.0.0.1:${service.port}`,
        backend: values.runtime ? 'codex-cli' : 'simulation',
      }),
    );
    const close = () => {
      void service.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (group === 'doctor') {
    validateOptions([], 1);
    console.log(JSON.stringify(await callLocal(directory, '/v1/health')));
    return;
  }
  if (group !== 'task')
    throw new RelayError('invalid', 'unknown command; use --help');
  let result: Record<string, unknown>;
  if (action === 'import') {
    validateOptions(['issue', 'key'], 2);
    result = await callLocal(directory, '/v1/github/import', {
      schemaVersion: 1,
      issue: Number(requireOption('issue')),
      requestKey: requireOption('key'),
    });
  } else if (action === 'create') {
    validateOptions(['repo', 'input', 'key'], 2);
    result = await callLocal(directory, '/v1/tasks', {
      schemaVersion: 1,
      repo: resolve(requireOption('repo')),
      input: readInput(requireOption('input')),
      requestKey: requireOption('key'),
    });
  } else {
    const taskId = idSchema.parse(id);
    if (
      [
        'publish',
        'reconcile-delivery',
        'complete-delivery',
        'cancel-delivery',
        'feedback',
      ].includes(action ?? '')
    ) {
      validateOptions(
        action === 'feedback' ? ['version', 'input'] : ['version'],
        3,
      );
      result = await callLocal(directory, `/v1/tasks/${taskId}/delivery`, {
        schemaVersion: 1,
        expectedVersion: Number(requireOption('version')),
        action: action!.replace('-delivery', ''),
        ...(action === 'feedback'
          ? { feedback: JSON.parse(readInput(requireOption('input'))) }
          : {}),
      });
    } else if (action === 'status') {
      validateOptions([], 3);
      result = await callLocal(directory, `/v1/tasks/${taskId}`);
    } else if (action === 'events') {
      validateOptions(['after', 'limit'], 3);
      const query = new URLSearchParams({
        after: values.after ?? '0',
        limit: values.limit ?? '100',
      });
      result = await callLocal(
        directory,
        `/v1/tasks/${taskId}/events?${query}`,
      );
    } else {
      if (
        !['answer', 'revise', 'pause', 'resume', 'cancel', 'budget'].includes(
          action ?? '',
        )
      )
        throw new RelayError('invalid', 'unknown task action');
      validateOptions(
        action === 'budget'
          ? ['version', 'max-runs', 'input']
          : action === 'answer'
            ? ['version', 'question', 'question-version', 'input']
            : action === 'revise'
              ? ['version', 'requirement-version', 'input']
              : ['version'],
        3,
      );
      const command = commandSchema.parse({
        action,
        expectedVersion: Number(requireOption('version')),
        ...(action === 'budget'
          ? {
              maxRuns: Number(requireOption('max-runs')),
              approval: readInput(requireOption('input')),
            }
          : {}),
        ...(action === 'revise'
          ? {
              requirementVersion: Number(requireOption('requirement-version')),
              input: readInput(requireOption('input')),
            }
          : {}),
        ...(action === 'answer'
          ? {
              questionId: requireOption('question'),
              questionVersion: Number(requireOption('question-version')),
              answer: readInput(requireOption('input')),
            }
          : {}),
      });
      result = await callLocal(directory, `/v1/tasks/${taskId}/commands`, {
        schemaVersion: 1,
        command,
      });
    }
  }
  console.log(JSON.stringify(result));
}
try {
  await main();
} catch (error) {
  const message =
    error instanceof RelayError
      ? error.message
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 'invalid input or schema version; use --help'
        : 'local operation failed; check service, paths and permissions';
  console.error(
    JSON.stringify({
      schemaVersion: 1,
      error: {
        code: error instanceof RelayError ? error.code : 'invalid',
        message,
      },
    }),
  );
  process.exitCode = 1;
}
