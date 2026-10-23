import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { artifactSchema, taskSchema } from '../core/contracts.ts';
import { handoffSchema } from '../core/handoff.ts';
import type { ChatIO, ChatSettings } from './setup.ts';

export type ChatClient = (
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;
const snapshotSchema = z.object({
  task: taskSchema,
  accepted: z.boolean(),
  evidenceIssues: z.array(z.string()),
  artifacts: z.array(artifactSchema),
  workspaces: z
    .array(
      z.object({
        kind: z.string(),
        path: z.string(),
        branch: z.string().nullable(),
      }),
    )
    .optional(),
  handoffs: z.array(z.object({ result: handoffSchema })).optional(),
});
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const stages: Record<string, string> = {
  triage: '调查需求',
  design: '制定方案',
  design_review: '审查方案',
  implement: '实施修改',
  verify: '运行可信检查',
  code_review: '独立审查',
  deliver: '本地验收',
  answer: '整理答复',
};

export async function converse(
  client: ChatClient,
  io: ChatIO,
  settings: ChatSettings,
  remember: (id: string) => void,
  pollMs = 500,
): Promise<number> {
  let id = settings.lastTaskId;
  if (id) {
    const previous = snapshotSchema.parse(await client(`/v1/tasks/${id}`));
    if (terminal.has(previous.task.status)) id = undefined;
    else
      io.write(
        `继续上次任务：${id}（${previous.task.status}），预算和期限不重置。`,
      );
  }
  if (!id) {
    io.write('输入一项完整需求后回车。每次启动处理一项任务；输入 /exit 退出。');
    let prompt: string | null;
    do {
      prompt = await io.ask('需求 > ');
    } while (prompt !== null && !prompt.trim() && !io.signal.aborted);
    if (prompt === null || prompt.trim() === '/exit' || io.signal.aborted)
      return 0;
    const created = await client('/v1/tasks', {
      schemaVersion: 1,
      requestKey: randomUUID(),
      repo: settings.repo,
      input: prompt,
    });
    id = taskSchema.parse(created.task).id;
    io.write(`任务已保存：${id}`);
    remember(id);
  }
  let lastProgress = '',
    lastPrinted = 0;
  while (!io.signal.aborted) {
    const snapshot = snapshotSchema.parse(await client(`/v1/tasks/${id}`));
    const { task } = snapshot;
    const progress = `${stages[task.stage] ?? task.stage} · ${task.status} · 调用 ${task.runsUsed}/${task.config.budget.maxRuns}`;
    if (progress !== lastProgress || Date.now() - lastPrinted >= 15000) {
      io.write(progress);
      lastProgress = progress;
      lastPrinted = Date.now();
    }
    if (task.status === 'waiting_user' && task.question) {
      io.write(`需要你补充：${task.question.text}`);
      const answer = await io.ask('答复（/exit 保存并退出） > ');
      if (answer === null || answer.trim() === '/exit' || io.signal.aborted)
        return 0;
      if (!answer.trim()) continue;
      // Bind the response to the question the user actually saw; never retry a stale decision.
      await client(`/v1/tasks/${id}/commands`, {
        schemaVersion: 1,
        command: {
          action: 'answer',
          expectedVersion: task.version,
          questionId: task.question.id,
          questionVersion: task.question.version,
          answer,
        },
      });
      continue;
    }
    if (task.status === 'paused') {
      const resume = await io.ask(
        '任务已暂停，继续执行？输入 yes，其他输入退出 > ',
      );
      if (resume?.trim() !== 'yes' || io.signal.aborted) return 0;
      await client(`/v1/tasks/${id}/commands`, {
        schemaVersion: 1,
        command: { action: 'resume', expectedVersion: task.version },
      });
      continue;
    }
    if (
      task.status === 'recovering' ||
      task.status === 'blocked' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      io.write(
        `未完成：${task.diagnostic ?? task.status}\n任务记录已保留；停止未知时仍保持隔离，不自动重试或增加预算。`,
      );
      return 1;
    }
    if (task.status === 'succeeded') {
      if (!snapshot.accepted) {
        io.write(`结果未通过验收：${snapshot.evidenceIssues.join('；')}`);
        return 1;
      }
      io.write(
        task.kind === 'simulation'
          ? '模拟完成（未调用模型、未修改仓库）。'
          : '本地任务已通过验收。',
      );
      const answer = snapshot.handoffs
        ?.map((h) => h.result)
        .findLast((h) => h.stage === 'answer');
      const implementation = snapshot.handoffs
        ?.map((h) => h.result)
        .findLast(
          (h) =>
            h.stage === 'implement' && h.resultRevision === task.codeRevision,
        );
      if (answer?.stage === 'answer') {
        io.write(answer.conclusion);
        for (const source of answer.sources)
          io.write(`${source.path}:${source.line} — ${source.excerpt}`);
        for (const limitation of answer.limitations)
          io.write(`限制：${limitation}`);
      } else if (implementation?.stage === 'implement') {
        io.write(implementation.summary);
        io.write(
          `候选提交：${implementation.resultRevision}\n修改文件：${implementation.changedFiles.join(', ')}`,
        );
      } else {
        const artifact = snapshot.artifacts.findLast(
          (a) => a.kind === 'result',
        );
        if (artifact) {
          const result = await client(`/v1/artifacts/${artifact.id}`);
          io.write(z.string().parse(result.content));
        }
      }
      for (const workspace of snapshot.workspaces ?? [])
        if (workspace.kind === 'implementation')
          io.write(`成果工作树：${workspace.path}\n分支：${workspace.branch}`);
      if (task.kind === 'development')
        io.write(
          '未推送、未创建 PR、未合并。原仓库不自动应用候选；请检查成果。',
        );
      return 0;
    }
    const health = await client('/v1/health');
    if (health.schedulerError) {
      io.write(
        `调度已停止：${String(health.schedulerError)}；任务 ${id} 已保留。`,
      );
      return 1;
    }
    await delay(pollMs, undefined, { signal: io.signal }).catch(
      (error: unknown) => {
        if (!io.signal.aborted) throw error;
      },
    );
  }
  io.write('正在退出并核对活动执行；任务与预算记录保留。');
  return 130;
}
