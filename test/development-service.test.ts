import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { startService } from '../src/service/server.ts';
import { readToken } from '../src/service/local.ts';
import type { Config } from '../src/core/config.ts';
import { workspaceFixture, git } from './workspace-helpers.ts';
import { isolatedPermissions } from '../src/adapters/codex/isolation.ts';

test(
  process.platform === 'win32'
    ? 'explicit development service runs registered consultation through fake CLI and exposes handoff evidence'
    : 'unverified native development platform is rejected before model launch',
  async (t) => {
    const f = workspaceFixture(t),
      directory = join(f.directory, 'runtime');
    const profile = {
      executor: 'codex-cli' as const,
      provider: 'openai' as const,
      model: 'gpt-6-luna' as const,
      native: { reasoningEffort: 'low' as const },
      timeoutMs: 60000,
    };
    const config: Config = {
      ...f.task.config,
      allowedFiles: ['value.txt'],
      profiles: {
        design: { ...profile, role: 'design', permission: 'read-only' },
        review: { ...profile, role: 'review', permission: 'read-only' },
        implement: {
          ...profile,
          role: 'implement',
          permission: 'workspace-write',
        },
      },
      verification: {
        version: 1,
        maxLogBytes: 4096,
        commands: [
          {
            id: 'check',
            version: 1,
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: '.',
            timeoutMs: 1000,
          },
        ],
      },
    };
    const options = {
      directory,
      port: 0,
      autoSchedule: false,
      config,
      development: {
        repo: f.repo,
        workspaces: f.root,
        command: {
          executable: process.execPath,
          prefixArgs: [resolve('test/fixtures/fake-codex.ts'), 'workflow'],
        },
      },
    };
    if (process.platform !== 'win32') {
      await assert.rejects(startService(options), /validated only on Windows/);
      return;
    }
    const service = await startService(options);
    try {
      const call = (path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${service.port}${path}`, {
          headers: {
            authorization: `Bearer ${readToken(directory)}`,
            'content-type': 'application/json',
          },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        });
      assert.equal(
        (
          await call('/v1/tasks', {
            schemaVersion: 1,
            repo: directory,
            input: 'wrong repo',
            requestKey: 'bad',
          })
        ).status,
        400,
      );
      const task = (
        await (
          await call('/v1/tasks', {
            schemaVersion: 1,
            repo: f.repo,
            input: 'explain value',
            requestKey: 'good',
          })
        ).json()
      ).task;
      for (let i = 0; i < 2; i++) {
        await service.controller.tick();
        await service.controller.wait();
      }
      const status = await (await call(`/v1/tasks/${task.id}`)).json();
      assert.equal(status.accepted, true, JSON.stringify(status.task));
      assert.equal(status.handoffs.length, 2);
      const run = service.controller.runs.forTask(task.id)[0]!;
      const invocation = JSON.parse(
        readFileSync(
          join(directory, 'executions', run.id, 'invocation.json'),
          'utf8',
        ),
      );
      assert.ok(
        invocation.args.some(
          (a: string) =>
            a.startsWith('permissions.relay=') && a.includes('deny'),
        ),
      );
      assert.ok(invocation.args.includes('features.apps=false'));
      assert.equal(git(f.repo, 'status', '--porcelain'), '');
    } finally {
      await service.close();
    }
  },
);
test('isolated native profile rejects tracked project runtime extensions instead of ignoring them', async (t) => {
  const f = workspaceFixture(t);
  mkdirSync(join(f.repo, '.codex'));
  writeFileSync(
    join(f.repo, '.codex', 'config.toml'),
    '[mcp_servers.fixture]\ncommand="fixture"\n',
  );
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-qm', 'runtime extension fixture');
  const request = {
    workspace: { managedId: f.task.id, path: f.repo },
    run: { profile: { permission: 'read-only' } },
  } as Parameters<typeof isolatedPermissions>[0];
  await assert.rejects(
    isolatedPermissions(request, [join(f.directory, 'runtime')]),
    /audited integration/,
  );
});
