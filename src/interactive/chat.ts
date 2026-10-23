import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { configSchema, defaultConfig } from '../core/config.ts';
import { RelayError } from '../core/errors.ts';
import { runtimeSchema } from '../service/development.ts';
import { connection, privateDirectory } from '../service/local.ts';
import { callLocal } from '../service/client.ts';
import { startService } from '../service/server.ts';
import {
  configure,
  loadSettings,
  saveSettings,
  settingsSchema,
} from './setup.ts';
import type { ChatIO, ChatSettings } from './setup.ts';
import { converse } from './session.ts';

function readJSON(path: string): unknown {
  if (!statSync(path).isFile() || statSync(path).size > 131072)
    throw new RelayError('invalid', '配置必须是至多 128 KiB 的 JSON 文件');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function terminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function terminalIO(): ChatIO & { close(): void } {
  const cancellation = new AbortController();
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  const stop = () => {
    cancellation.abort();
    lines.close();
  };
  lines.on('SIGINT', stop);
  lines.on('close', () => {
    if (process.stdin.isTTY) cancellation.abort();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: cancellation.signal,
    write: (message) => process.stdout.write(`${terminalText(message)}\n`),
    async ask(prompt) {
      if (cancellation.signal.aborted) return null;
      process.stdout.write(terminalText(prompt));
      const answer = await iterator.next();
      return answer.done || cancellation.signal.aborted ? null : answer.value;
    },
    close() {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      lines.close();
    },
  };
}

export async function chat(
  options: {
    directory: string;
    demo?: boolean;
    repo?: string;
    config?: string;
    runtime?: string;
    port?: number;
  },
  io: ChatIO,
): Promise<number> {
  const directory = privateDirectory(options.directory);
  const previous = loadSettings(directory);
  if (!previous && existsSync(join(directory, 'state.db')))
    throw new RelayError(
      'conflict',
      '此目录已有管理模式任务，不能自动接管；请为 chat 指定新的 --data-dir',
    );
  if (options.demo && options.runtime)
    throw new RelayError('invalid', '--demo 不能与 --runtime 同时使用');
  if (options.runtime && !options.config)
    throw new RelayError('invalid', '--runtime 需要配合 --config 使用');
  let settings: ChatSettings;
  if (options.demo || options.config || options.runtime) {
    const config = options.config
      ? configSchema.parse(readJSON(options.config))
      : defaultConfig();
    const runtime = options.runtime
      ? runtimeSchema.parse(readJSON(options.runtime))
      : undefined;
    if (
      !runtime &&
      Object.values(config.profiles).some((p) => p.executor !== 'fake')
    )
      throw new RelayError(
        'invalid',
        '真实配置需要 --runtime；不能作为模拟运行',
      );
    const repo = resolve(options.repo ?? runtime?.repo ?? process.cwd());
    if (
      previous &&
      (previous.repo !== repo || !!previous.runtime !== !!runtime)
    )
      throw new RelayError(
        'conflict',
        '此数据目录已登记其他项目或模式，请使用不同的 --data-dir',
      );
    settings = settingsSchema.parse({
      schemaVersion: 1,
      repo,
      config,
      ...(runtime ? { runtime } : {}),
      ...(previous?.lastTaskId ? { lastTaskId: previous.lastTaskId } : {}),
    });
  } else {
    if (previous && options.repo && previous.repo !== resolve(options.repo))
      throw new RelayError(
        'conflict',
        '此数据目录已登记其他项目，请使用不同的 --data-dir',
      );
    settings = previous ?? (await configure(io, directory, options.repo));
  }
  if (io.signal.aborted) return 130;
  io.write(
    `项目：${settings.repo}\n模式：${settings.runtime ? '真实 Codex 开发' : '模拟体验，不调用模型、不修改仓库'}\n数据目录：${directory}`,
  );
  io.write(
    `每任务最多 ${settings.config.budget.maxRuns} 次调用、${settings.config.budget.maxTaskMs / 1000} 秒；Ctrl+C 请求暂停并退出。`,
  );
  const service = await startService({
    directory,
    signal: io.signal,
    config: settings.config,
    ...(settings.runtime ? { development: settings.runtime } : {}),
    ...(options.port !== undefined
      ? { port: options.port }
      : connection(directory)
        ? {}
        : { port: 0 }),
  });
  try {
    saveSettings(directory, settings);
    if (io.signal.aborted) return 130;
    return await converse(
      (path, body) => callLocal(directory, path, body),
      io,
      settings,
      (id) => {
        settings = { ...settings, lastTaskId: id };
        saveSettings(directory, settings);
      },
    );
  } finally {
    await service.close();
  }
}
