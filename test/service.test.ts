import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startService } from '../src/service/server.ts';
import { readToken } from '../src/service/local.ts';
import { defaultConfig } from '../src/core/config.ts';

async function serviceFixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-service-'));
  const service = await startService({
    directory,
    port: 0,
    autoSchedule: false,
  });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.port}`;
  const headers = {
    authorization: `Bearer ${readToken(directory)}`,
    'content-type': 'application/json',
  };
  const call = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      headers,
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
    });
  return { directory, service, base, headers, call };
}

test('loopback endpoints require bearer authentication and reject browser origins', async (t) => {
  const { base, headers, call } = await serviceFixture(t);
  assert.equal((await fetch(`${base}/v1/health`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/v1/health`, {
        headers: { ...headers, origin: 'https://example.test' },
      })
    ).status,
    401,
  );
  const forgedHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = httpRequest(
        `${base}/v1/health`,
        { headers: { ...headers, host: 'example.test' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end();
    },
  );
  assert.equal(forgedHostStatus, 401);
  assert.equal((await call('/v1/health')).status, 200);
  assert.equal((await call('/v1/tasks', { schemaVersion: 2 })).status, 400);
  const oversized = await fetch(`${base}/v1/tasks`, {
    headers,
    method: 'POST',
    body: 'x'.repeat(131073),
  });
  assert.equal(oversized.status, 400);
});

test('authenticated lifecycle enforces versions, immutable policy and artifact diagnostics', async (t) => {
  const { directory, service, call } = await serviceFixture(t);
  const input = {
    schemaVersion: 1,
    requestKey: 'once',
    repo: directory,
    input: 'simulation',
  };
  assert.equal(
    (await call('/v1/tasks', { ...input, config: defaultConfig() })).status,
    400,
  );
  const task = (await (await call('/v1/tasks', input)).json()).task;
  assert.equal(
    (await (await call('/v1/tasks', input)).json()).task.id,
    task.id,
  );
  assert.equal(
    (
      await call(`/v1/tasks/${task.id}/commands`, {
        schemaVersion: 1,
        command: { action: 'pause', expectedVersion: 99 },
      })
    ).status,
    409,
  );
  await service.controller.tick();
  await service.controller.wait();
  const status = await (await call(`/v1/tasks/${task.id}`)).json();
  assert.equal(status.accepted, true);
  const artifact = status.artifacts.find(
    (item: { kind: string }) => item.kind === 'result',
  );
  assert.match(
    (await (await call(`/v1/artifacts/${artifact.id}`)).json()).content,
    /Simulation completed/,
  );
  writeFileSync(join(directory, 'evidence', artifact.sha256), 'broken');
  const corrupted = await (await call(`/v1/tasks/${task.id}`)).json();
  assert.equal(corrupted.accepted, false);
  assert.equal(corrupted.evidenceIssues.length, 1);
  assert.equal((await call(`/v1/artifacts/${artifact.id}`)).status, 500);
  const events = await (
    await call(`/v1/tasks/${task.id}/events?after=0&limit=2`)
  ).json();
  assert.equal(events.events.length, 2);
  assert.equal(events.nextCursor, events.events[1].sequence);
});

test('same runtime directory cannot start two services or change its port', async (t) => {
  const { directory, service } = await serviceFixture(t);
  await assert.rejects(
    startService({ directory, autoSchedule: false }),
    /EADDRINUSE/,
  );
  await assert.rejects(startService({ directory, port: 0 }), /another port/);
  await service.close();
  const restarted = await startService({ directory, autoSchedule: false });
  assert.equal(restarted.port, service.port);
  await restarted.close();
});
