import assert from 'node:assert/strict';
import test from 'node:test';
import { configSchema, defaultConfig } from '../src/core/config.ts';
import { createTaskSchema, findingSchema } from '../src/core/contracts.ts';

test('configuration is finite, strict and backend-specific', () => {
  assert.deepEqual(configSchema.parse(defaultConfig()), defaultConfig());
  const cases = [
    { ...defaultConfig(), extra: true },
    {
      ...defaultConfig(),
      budget: { ...defaultConfig().budget, maxRuns: Infinity },
    },
    { ...defaultConfig(), budget: { ...defaultConfig().budget, maxTaskMs: 0 } },
  ];
  for (const config of cases)
    assert.equal(configSchema.safeParse(config).success, false);
  for (const change of [
    { model: 'unverified' },
    { executor: 'codex' },
    { permission: 'workspace-write' },
    { native: { scenario: 'success', delayMs: 0, shell: true } },
    { role: 'review' },
    { timeoutMs: 60_001 },
  ]) {
    const config = defaultConfig();
    Object.assign(config.profiles.design, change);
    assert.equal(configSchema.safeParse(config).success, false);
  }
});

test('request versions and evidence cannot silently drift', () => {
  const request = {
    schemaVersion: 1,
    requestKey: 'test',
    repo: '.',
    input: 'test',
    codeRevision: null,
    config: defaultConfig(),
  };
  assert.equal(createTaskSchema.safeParse(request).success, true);
  assert.equal(
    createTaskSchema.safeParse({ ...request, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    createTaskSchema.safeParse({ ...request, codeRevision: 'main' }).success,
    false,
  );
  const id = '00000000-0000-4000-8000-000000000000';
  const finding = {
    schemaVersion: 1,
    id,
    taskId: id,
    runId: id,
    evidence: { requirementVersion: 1, codeRevision: null },
    stage: 'design',
    severity: 'blocking',
    status: 'resolved',
    description: 'defect',
    proof: 'reproduction',
    verification: null,
  };
  assert.equal(findingSchema.safeParse(finding).success, false);
  assert.equal(
    findingSchema.safeParse({ ...finding, verification: 'retest evidence' })
      .success,
    true,
  );
});
