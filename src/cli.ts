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

const help = `Agent Relay (simulation by default; explicit trusted development runtime required)
node dist/cli.js serve [--data-dir DIR] [--config FILE] [--runtime FILE] [--port PORT]
node dist/cli.js doctor [--data-dir DIR]
node dist/cli.js task create --repo DIR --input FILE --key KEY [--data-dir DIR]
node dist/cli.js task status ID [--data-dir DIR]
node dist/cli.js task events ID [--after N] [--limit N] [--data-dir DIR]
node dist/cli.js task answer ID --version N --question ID --question-version N --input FILE [--data-dir DIR]
node dist/cli.js task pause|resume|cancel ID --version N [--data-dir DIR]
All output is JSON. Mutations require the task version returned by status.
Development runtime permits bounded Codex calls in managed worktrees. No PR publication or automatic merge.`;
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
      'data-dir': { type: 'string' },
      config: { type: 'string' },
      runtime: { type: 'string' },
      port: { type: 'string' },
      repo: { type: 'string' },
      input: { type: 'string' },
      key: { type: 'string' },
      version: { type: 'string' },
      question: { type: 'string' },
      'question-version': { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const [group, action, id] = positionals;
  const directory = resolve(
    values['data-dir'] ?? join(homedir(), '.agent-relay'),
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
  if (action === 'create') {
    validateOptions(['repo', 'input', 'key'], 2);
    result = await callLocal(directory, '/v1/tasks', {
      schemaVersion: 1,
      repo: resolve(requireOption('repo')),
      input: readInput(requireOption('input')),
      requestKey: requireOption('key'),
    });
  } else {
    const taskId = idSchema.parse(id);
    if (action === 'status') {
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
      if (!['answer', 'pause', 'resume', 'cancel'].includes(action ?? ''))
        throw new RelayError('invalid', 'unknown task action');
      validateOptions(
        action === 'answer'
          ? ['version', 'question', 'question-version', 'input']
          : ['version'],
        3,
      );
      const command = commandSchema.parse({
        action,
        expectedVersion: Number(requireOption('version')),
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
