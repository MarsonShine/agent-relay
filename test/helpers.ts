import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { CreateTask } from '../src/core/contracts.ts';

export function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-test-'));
  const path = join(directory, 'state.db');
  const db = new Database(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, db, tasks: new Tasks(db) };
}
export function request(): CreateTask & {
  config: ReturnType<typeof defaultConfig>;
} {
  return {
    schemaVersion: 1,
    requestKey: randomUUID(),
    repo: 'fixture-repository',
    input: 'simulation',
    codeRevision: null,
    config: defaultConfig(),
  };
}
