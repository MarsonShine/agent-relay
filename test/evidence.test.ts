import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { Evidence, BoundedLog } from '../src/storage/evidence.ts';
import { Runs } from '../src/storage/runs.ts';
import { redact } from '../src/storage/redaction.ts';
import { fixture, request } from './helpers.ts';

test('evidence is bounded, redacted, immutable and bound to its source run', (t) => {
  const { tasks, directory } = fixture(t);
  const task = tasks.create(request());
  const run = new Runs(tasks).claim(task.id, 'fake-v1')!;
  const evidence = new Evidence(tasks, join(directory, 'evidence'), [
    'private-value',
  ]);
  const log = new BoundedLog(128);
  log.append('api_key=');
  log.append('private-value\nBearer abc.def\n');
  const artifact = evidence.put(run, 'log', log.text(), 128);
  const content = evidence.read(artifact.id);
  assert.ok(!content.includes('private-value'));
  assert.ok(!content.includes('abc.def'));
  assert.deepEqual(artifact.evidence, run.evidence);
  assert.equal(evidence.put(run, 'log', log.text(), 128).id, artifact.id);
  assert.throws(() => evidence.put(run, 'log', 'changed', 128), /overwritten/);
  assert.throws(
    () => evidence.put(run, 'result', '中文'.repeat(10), 10),
    /size limit/,
  );
  assert.throws(() => log.append('x'.repeat(128)), /log size limit/);
  assert.throws(
    () =>
      evidence.put(
        { ...run, evidence: { ...run.evidence, requirementVersion: 2 } },
        'result',
        'result',
        128,
      ),
    /differs from run/,
  );
  assert.equal(
    readdirSync(join(directory, 'evidence')).filter((file) =>
      file.endsWith('.tmp'),
    ).length,
    0,
  );
});

test('missing and corrupt artifact files are diagnosed rather than trusted', (t) => {
  const { tasks, directory } = fixture(t);
  const run = new Runs(tasks).claim(tasks.create(request()).id, 'fake-v1')!;
  const evidence = new Evidence(tasks, join(directory, 'evidence'));
  const artifact = evidence.put(run, 'result', 'abc', 128);
  const path = join(directory, 'evidence', artifact.sha256);
  writeFileSync(path, 'xyz');
  assert.throws(() => evidence.read(artifact.id), /missing or corrupt/);
  assert.equal(evidence.diagnose(run.taskId).length, 1);
  unlinkSync(path);
  assert.throws(() => evidence.read(artifact.id), /missing or corrupt/);
});

test('common credentials and local paths do not leak in exported text', () => {
  for (const input of [
    'password="abc def"',
    'https://user:pass@example.test',
    'Bearer abc.def',
    'C:\\Users\\example\\private.txt',
    '/home/example/private.txt',
    '\\\\host\\share\\secret',
  ]) {
    const output = redact(input);
    assert.ok(
      !output.includes('abc') &&
        !output.includes('private.txt') &&
        !output.includes('user:pass') &&
        !output.includes('share'),
    );
  }
});

test('event persistence applies redaction before storing or deduplicating', (t) => {
  const { tasks, db } = fixture(t);
  const task = tasks.create(request());
  db.transaction(() =>
    tasks.append(
      task.id,
      null,
      'secret',
      'progress',
      'access_token=private-value',
    ),
  );
  assert.equal(tasks.events(task.id)[1]?.payload, 'access_token=[REDACTED]');
  assert.throws(
    () =>
      db.transaction(() =>
        tasks.append(task.id, null, 'huge', 'progress', '中'.repeat(3000)),
      ),
    /event size limit/,
  );
});
