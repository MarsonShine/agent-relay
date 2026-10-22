import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Runs } from '../src/storage/runs.ts';
import { Intents } from '../src/storage/intents.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { Controller } from '../src/workflow/controller.ts';
import { CodexExecutor } from '../src/adapters/codex/executor.ts';
import { testedCodexVersion } from '../src/adapters/codex/events.ts';
import { fixture, request } from './helpers.ts';

for (const point of [
  'before-spawn',
  'after-spawn',
  'after-change',
  'before-settle',
]) {
  test(
    `service SIGKILL ${point} retains ownership until recovery and never replays the run`,
    { timeout: 20000 },
    async (t) => {
      const f = fixture(t),
        repo = join(f.directory, 'repository');
      mkdirSync(repo);
      const input = request();
      const profile = {
        role: 'design' as const,
        executor: 'codex-cli' as const,
        provider: 'openai' as const,
        model: 'gpt-6-luna' as const,
        permission: 'read-only' as const,
        native: { reasoningEffort: 'low' as const },
        timeoutMs: 15000,
      };
      const task = f.tasks.create({
        ...input,
        repo,
        config: {
          ...input.config,
          leaseMs: 1000,
          profiles: {
            design: profile,
            implement: { ...profile, role: 'implement' },
            review: { ...profile, role: 'review' },
          },
        },
      });
      const child = spawn(
        process.execPath,
        [resolve('test/fixtures/crash-controller.ts'), f.directory, point],
        { stdio: 'pipe', windowsHide: true },
      );
      let errors = '';
      child.stderr.on('data', (b) => {
        errors += String(b);
      });
      const exited = new Promise<void>((resolveExit) =>
        child.once('exit', () => resolveExit()),
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await exited;
      });
      const runs = new Runs(f.tasks);
      const heartbeat = join(repo, 'heartbeat.json');
      let run;
      let ready = false;
      for (let i = 0; i < 300; i++) {
        run = runs.forTask(task.id)[0];
        ready = !!(point === 'after-change'
          ? existsSync(heartbeat)
          : point === 'after-spawn'
            ? run &&
              existsSync(
                join(
                  f.directory,
                  'executions',
                  'owned',
                  `${run.id}-${run.owner}`,
                  'gate',
                ),
              )
            : existsSync(join(f.directory, 'checkpoint')));
        if (ready) break;
        await delay(20);
      }
      assert.ok(run, errors);
      assert.ok(ready, errors);
      if (point === 'after-spawn') {
        // Force a final heartbeat after observation to exercise a stale snapshot.
        const renewed = runs.renew(run, runs.get(run.id).leaseUntil - 1);
        assert.ok(renewed.leaseUntil > run.leaseUntil);
      }
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
      const current = f.tasks.get(task.id);
      if (point !== 'before-settle')
        f.tasks.command(task.id, {
          action: point === 'after-change' ? 'pause' : 'cancel',
          expectedVersion: current.version,
        });
      assert.equal(runs.outstanding().length, 1);
      const other = f.tasks.create({
        ...input,
        requestKey: `competitor-${point}`,
      });
      assert.equal(runs.claim(other.id, 'fixture'), null);
      const reopened = new Database(f.path);
      try {
        const tasks = new Tasks(reopened),
          recoveryRuns = new Runs(tasks);
        const backend = new CodexExecutor({
          directory: join(f.directory, 'executions'),
          command: { executable: process.execPath },
        });
        const controller = new Controller(
          tasks,
          new Evidence(tasks, join(f.directory, 'evidence')),
          backend,
        );
        // The child can renew after our observation; only its exit fences renewals.
        recoveryRuns.expire(recoveryRuns.get(run.id).leaseUntil);
        await controller.tick();
        assert.equal(recoveryRuns.get(run.id).status, 'stopped');
        const recovered = tasks.get(task.id);
        assert.equal(
          recovered.status,
          point === 'before-settle'
            ? 'blocked'
            : point === 'after-change'
              ? 'paused'
              : 'cancelled',
        );
        assert.equal(recovered.runsUsed, 1);
        assert.equal(recovered.deadlineAt, task.deadlineAt);
        assert.ok(
          new Intents(tasks)
            .list(task.id)
            .every((i) => i.state === 'abandoned'),
        );
        if (point === 'before-settle') {
          assert.ok(
            new Intents(tasks).list(task.id).some((i) => i.kind === 'result'),
          );
          assert.ok(
            controller.evidence.list(task.id).some((a) => a.kind === 'result'),
          );
        }
        if (existsSync(heartbeat)) {
          const before = readFileSync(heartbeat, 'utf8');
          await delay(200);
          assert.equal(readFileSync(heartbeat, 'utf8'), before);
          assert.throws(() => process.kill(JSON.parse(before).pid, 0));
        }
        if (point === 'after-change') {
          const resumed = tasks.command(task.id, {
            action: 'resume',
            expectedVersion: recovered.version,
          });
          assert.equal(resumed.deadlineAt, task.deadlineAt);
          const next = recoveryRuns.claim(
            task.id,
            `codex-cli/${testedCodexVersion}`,
          )!;
          assert.ok(next);
          assert.equal(tasks.get(task.id).runsUsed, 2);
          recoveryRuns.finish(next, {
            status: 'blocked',
            diagnostic: 'test did not launch another process',
            question: null,
            continuation: null,
          });
        }
      } finally {
        reopened.close();
      }
    },
  );
}
