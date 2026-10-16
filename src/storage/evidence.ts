import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  readFileSync,
  lstatSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { artifactSchema } from '../core/contracts.ts';
import type { Artifact, Run } from '../core/contracts.ts';
import { RelayError } from '../core/errors.ts';
import type { Tasks } from './tasks.ts';
import { redact } from './redaction.ts';

export class Evidence {
  readonly tasks: Tasks;
  readonly directory: string;
  readonly secrets: readonly string[];
  constructor(
    tasks: Tasks,
    directory: string,
    secrets: readonly string[] = [],
  ) {
    this.tasks = tasks;
    this.directory = directory;
    this.secrets = secrets;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    ) {
      throw new RelayError(
        'storage',
        'evidence directory must be a real directory',
      );
    }
  }
  put(run: Run, kind: Artifact['kind'], text: string, limit: number): Artifact {
    if (Buffer.byteLength(text) > limit)
      throw new RelayError('storage', `${kind} size limit exceeded`);
    const content = Buffer.from(redact(text, this.secrets), 'utf8');
    if (content.byteLength > limit)
      throw new RelayError(
        'storage',
        `${kind} size limit exceeded after redaction`,
      );
    const sha256 = createHash('sha256').update(content).digest('hex');
    const artifact = artifactSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      taskId: run.taskId,
      runId: run.id,
      kind,
      sha256,
      bytes: content.byteLength,
      evidence: run.evidence,
    });
    const destination = join(this.directory, sha256);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.verifyFile(artifact);
      return this.tasks.db.transaction(() => {
        const row = this.tasks.db.sql
          .prepare('SELECT document FROM runs WHERE id=? AND task_id=?')
          .get(run.id, run.taskId);
        if (!row)
          throw new RelayError('storage', 'artifact run does not exist');
        const persisted = JSON.parse(String(row.document)) as Run;
        if (JSON.stringify(persisted.evidence) !== JSON.stringify(run.evidence))
          throw new RelayError(
            'conflict',
            'artifact evidence differs from run',
          );
        const existing = this.tasks.db.sql
          .prepare('SELECT document FROM artifacts WHERE run_id=? AND kind=?')
          .get(run.id, kind);
        if (existing) {
          const old = artifactSchema.parse(
            JSON.parse(String(existing.document)),
          );
          if (old.sha256 !== sha256)
            throw new RelayError('conflict', 'artifact cannot be overwritten');
          return old;
        }
        this.tasks.db.sql
          .prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)')
          .run(
            artifact.id,
            artifact.taskId,
            artifact.runId,
            kind,
            JSON.stringify(artifact),
          );
        this.tasks.append(
          run.taskId,
          run.id,
          `artifact:${artifact.id}`,
          'artifact.saved',
          `${kind}:${sha256}`,
        );
        return artifact;
      });
    } finally {
      unlinkSync(temporary);
    }
  }
  private verifyFile(artifact: Artifact): Buffer {
    try {
      const path = join(this.directory, artifact.sha256);
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== artifact.bytes
      )
        throw new Error('invalid artifact file');
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('artifact hash mismatch');
      return bytes;
    } catch {
      throw new RelayError(
        'storage',
        `artifact ${artifact.id} is missing or corrupt`,
      );
    }
  }
  list(taskId: string): Artifact[] {
    return this.tasks.db.sql
      .prepare('SELECT document FROM artifacts WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => artifactSchema.parse(JSON.parse(String(row.document))));
  }
  read(id: string): string {
    const row = this.tasks.db.sql
      .prepare('SELECT document FROM artifacts WHERE id=?')
      .get(id);
    if (!row) throw new RelayError('not_found', 'artifact does not exist');
    return this.verifyFile(
      artifactSchema.parse(JSON.parse(String(row.document))),
    ).toString('utf8');
  }
  diagnose(taskId: string): string[] {
    const issues: string[] = [];
    for (const artifact of this.list(taskId)) {
      try {
        this.verifyFile(artifact);
      } catch {
        issues.push(`artifact ${artifact.id} is missing or corrupt`);
      }
    }
    return issues;
  }
}

export class BoundedLog {
  private readonly chunks: string[] = [];
  private bytes = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  append(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.bytes + bytes > this.limit)
      throw new RelayError('storage', 'log size limit exceeded');
    this.chunks.push(text);
    this.bytes += bytes;
  }
  text(): string {
    return this.chunks.join('');
  }
}
