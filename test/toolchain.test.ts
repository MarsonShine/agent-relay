import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { schemaVersion } from '../src/version.ts';

test('pinned runtime supports the control kernel SQLite dependency', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(
      db.prepare('SELECT 1 AS version').get()?.version,
      schemaVersion,
    );
  } finally {
    db.close();
  }
});
