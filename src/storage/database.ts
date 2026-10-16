import { DatabaseSync } from 'node:sqlite';
import { RelayError } from '../core/errors.ts';

const migrations = [
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
    status TEXT GENERATED ALWAYS AS (json_extract(document, '$.status')) VIRTUAL
  ) STRICT;
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    event_key TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
    UNIQUE(task_id, event_key)
  ) STRICT;
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    document TEXT NOT NULL CHECK(json_valid(document))
  ) STRICT;`,
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    document TEXT NOT NULL CHECK(json_valid(document)),
    status TEXT GENERATED ALWAYS AS (json_extract(document, '$.status')) VIRTUAL
  ) STRICT;
  CREATE UNIQUE INDEX one_outstanding_run ON runs((1)) WHERE status != 'stopped';`,
  `CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(run_id, kind)
  ) STRICT;`,
];

export class Database {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    this.sql = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.sql.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
      );
      this.transaction(() => {
        const version = Number(
          this.sql.prepare('PRAGMA user_version').get()?.user_version,
        );
        if (version > migrations.length)
          throw new RelayError(
            'storage',
            'database version is newer than this application',
          );
        for (let index = version; index < migrations.length; index++) {
          this.sql.exec(migrations[index]!);
          this.sql.exec(`PRAGMA user_version=${index + 1}`);
        }
      });
      if (this.sql.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
        throw new RelayError('storage', 'database integrity check failed');
      }
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  transaction<T>(action: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.sql.close();
  }
}
