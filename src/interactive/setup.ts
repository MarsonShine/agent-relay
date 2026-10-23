import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { configSchema, defaultConfig } from '../core/config.ts';
import { relativeFile } from '../core/handoff.ts';
import { RelayError } from '../core/errors.ts';
import { runtimeSchema } from '../service/development.ts';
import { testedCodexVersion } from '../adapters/codex/events.ts';

export interface ChatIO {
  ask(prompt: string): Promise<string | null>;
  write(message: string): void;
  signal: AbortSignal;
}
export const settingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().refine(isAbsolute),
  config: configSchema,
  runtime: runtimeSchema.optional(),
  lastTaskId: z.uuid().optional(),
});
export type ChatSettings = z.infer<typeof settingsSchema>;

export function loadSettings(directory: string): ChatSettings | null {
  const path = join(directory, 'chat.json');
  return existsSync(path)
    ? settingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : null;
}
export function saveSettings(directory: string, settings: ChatSettings): void {
  const path = join(directory, 'chat.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(settingsSchema.parse(settings)), {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
  renameSync(temporary, path);
}

async function input<T>(
  io: ChatIO,
  prompt: string,
  schema: z.ZodType<T>,
  fallback?: string,
): Promise<T> {
  while (!io.signal.aborted) {
    const value = await io.ask(
      `${prompt}${fallback ? ` [${fallback}]` : ''}：`,
    );
    if (value === null) throw new RelayError('invalid', '已取消设置');
    const result = schema.safeParse(value.trim() || fallback || '');
    if (result.success) return result.data;
    io.write('输入不符合要求，请重新输入；Ctrl+C 退出。');
  }
  throw new RelayError('invalid', '已取消设置');
}

export async function configure(
  io: ChatIO,
  directory: string,
  repo = process.cwd(),
): Promise<ChatSettings> {
  io.write('首次使用：保存项目设置后，以后启动即可直接输入需求。');
  const mode = await input(
    io,
    '模式：1 真实开发（Windows），2 模拟体验',
    z.enum(['1', '2']),
    '1',
  );
  const target = await input(
    io,
    '目标仓库目录',
    z
      .string()
      .min(1)
      .transform((s) => resolve(s)),
    repo,
  );
  if (mode === '2') {
    const config = defaultConfig();
    config.budget.maxTaskMs = 3600000;
    return { schemaVersion: 1, repo: target, config };
  }
  if (process.platform !== 'win32')
    throw new RelayError(
      'invalid',
      '真实开发当前仅支持 Windows；可用 chat --demo 体验交互。',
    );
  io.write('真实开发会调用模型并在独立工作树创建提交；不会自动推送或创建 PR。');
  const absolute = z.string().refine(isAbsolute, '需要绝对路径');
  const executable = await input(
    io,
    `已认证的 Codex 原生 .exe 绝对路径（${testedCodexVersion}，不是 .cmd/.ps1）`,
    absolute,
  );
  const workspaces = await input(
    io,
    '任务工作树根目录（与仓库、数据目录分开）',
    absolute,
    join(dirname(directory), `${basename(directory)}-worktrees`),
  );
  const allowedFiles = await input(
    io,
    '允许修改的仓库相对文件，用逗号分隔，使用 /，不使用通配符',
    z
      .string()
      .transform((s) => s.split(',').map((p) => p.trim()))
      .pipe(
        z
          .array(relativeFile.refine((p) => !/[?*]/.test(p)))
          .min(1)
          .max(100),
      ),
  );
  const checkExecutable = await input(
    io,
    '可信检查程序的绝对路径（例如 node.exe 或 dotnet.exe）',
    absolute,
  );
  const args = await input(
    io,
    '检查参数 JSON 数组（例如 ["--test"]，不经过 shell）',
    z
      .string()
      .transform((s, context) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          context.addIssue({ code: 'custom', message: 'invalid JSON' });
          return z.NEVER;
        }
      })
      .pipe(z.array(z.string().max(8192)).max(100)),
  );
  const maxRuns = await input(
    io,
    '每任务最多模型调用次数（1–100）',
    z.coerce.number().int().min(1).max(100),
    '8',
  );
  const seconds = await input(
    io,
    '每任务总期限秒数（180–86400，含人工等待）',
    z.coerce.number().int().min(180).max(86400),
    '3600',
  );
  const config = configSchema.parse({
    schemaVersion: 1,
    profiles: Object.fromEntries(
      ['design', 'implement', 'review'].map((role) => [
        role,
        {
          role,
          executor: 'codex-cli',
          provider: 'openai',
          model: 'gpt-6-luna',
          permission: role === 'implement' ? 'workspace-write' : 'read-only',
          native: { reasoningEffort: 'low' },
          timeoutMs: 180000,
        },
      ]),
    ),
    budget: { maxRuns, maxTaskMs: seconds * 1000, maxIterations: 3 },
    leaseMs: 60000,
    maxArtifactBytes: 262144,
    maxLogBytes: 1048576,
    allowedFiles,
    verification: {
      version: 1,
      maxLogBytes: 262144,
      commands: [
        {
          id: 'project-check',
          version: 1,
          executable: checkExecutable,
          args,
          cwd: '.',
          timeoutMs: 180000,
        },
      ],
    },
  });
  io.write(
    `仓库：${target}\n允许文件：${allowedFiles.join(', ')}\n检查：${checkExecutable} ${JSON.stringify(args)}\n每任务最多 ${maxRuns} 次调用、${seconds} 秒；单次 180 秒，最多 3 轮修复；金额未知。`,
  );
  const consent = await input(
    io,
    '保存并使用以上执行范围？输入 yes 确认，no 退出',
    z.enum(['yes', 'no']),
  );
  if (consent !== 'yes')
    throw new RelayError('invalid', '未保存设置，未启动任务');
  return {
    schemaVersion: 1,
    repo: target,
    config,
    runtime: { repo: target, workspaces, command: { executable } },
  };
}
