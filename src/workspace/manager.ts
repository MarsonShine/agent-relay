import { contentDigest } from './digest.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Tasks } from '../storage/tasks.ts';
import { RelayError } from '../core/errors.ts';
import { terminal } from '../core/state.ts';
import { workspaceSchema } from './contracts.ts';
import type { Workspace, WorkspaceMode } from './contracts.ts';
import { GitWorktrees, inside, pathKey, exists, destination } from './git.ts';

export class Workspaces {
  readonly tasks: Tasks;
  readonly root: string;
  readonly git: GitWorktrees;
  constructor(tasks: Tasks, root: string, git = new GitWorktrees()) {
    if (!isAbsolute(root))
      throw new RelayError(
        'invalid',
        'workspace storage root must be absolute',
      );
    this.tasks = tasks;
    this.root = root;
    this.git = git;
  }
  get(id: string): Workspace {
    const row = this.tasks.db.sql
      .prepare('SELECT document FROM workspaces WHERE id=?')
      .get(id);
    if (!row) throw new RelayError('not_found', 'workspace does not exist');
    return workspaceSchema.parse(JSON.parse(String(row.document)));
  }
  list(taskId: string): Workspace[] {
    return this.tasks.db.sql
      .prepare('SELECT document FROM workspaces WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => workspaceSchema.parse(JSON.parse(String(row.document))));
  }
  private save(workspace: Workspace): Workspace {
    const value = workspaceSchema.parse(workspace);
    this.tasks.db.sql
      .prepare('UPDATE workspaces SET document=? WHERE id=?')
      .run(JSON.stringify(value), value.id);
    return value;
  }
  async prepare(taskId: string, kind: WorkspaceMode): Promise<Workspace> {
    const task = this.tasks.get(taskId);
    if (!task.codeRevision)
      throw new RelayError(
        'invalid',
        'workspace requires a recorded baseline commit',
      );
    const existing = this.list(taskId).find(
      (w) =>
        w.kind === kind &&
        (kind === 'implementation' ||
          (w.revision === task.codeRevision &&
            w.requirementVersion === task.requirementVersion)),
    );
    if (existing) {
      if (existing.state !== 'ready')
        throw new RelayError(
          'conflict',
          'workspace intent requires reconciliation; it will not be replayed',
        );
      if (pathKey(await destination(this.root)) !== pathKey(existing.root))
        throw new RelayError(
          'conflict',
          'configured workspace root differs from registration',
        );
      const identity = await this.git.identity(task.repo);
      if (
        pathKey(identity.repo) !== pathKey(existing.repo) ||
        pathKey(identity.commonDir) !== pathKey(existing.commonDir)
      )
        throw new RelayError(
          'conflict',
          'task repository differs from registration',
        );
      await this.git.verify(existing, kind !== 'implementation');
      return existing;
    }
    const identity = await this.git.identity(task.repo);
    await this.git.preflight(identity.repo, task.codeRevision);
    const targetRoot = await destination(this.root);
    if (
      inside(identity.repo, targetRoot) ||
      inside(targetRoot, identity.repo) ||
      inside(identity.commonDir, targetRoot)
    )
      throw new RelayError(
        'invalid',
        'workspace root must be separate from the source checkout',
      );
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new RelayError('invalid', 'workspace root must not be a symlink');
    const root = await realpath(this.root);
    if (
      inside(identity.repo, root) ||
      inside(root, identity.repo) ||
      inside(identity.commonDir, root)
    )
      throw new RelayError(
        'invalid',
        'workspace root must be separate from the source checkout',
      );
    const implementation = this.list(taskId).find(
      (w) => w.kind === 'implementation',
    );
    if (kind === 'review' && implementation) {
      if (
        implementation.state !== 'ready' ||
        (await this.git.verify(implementation, true)) !== task.codeRevision
      )
        throw new RelayError(
          'conflict',
          'implementation must match the committed review revision',
        );
    }
    if (
      kind === 'repository' &&
      ((await this.git.head(identity.repo)) !== task.codeRevision ||
        (await this.git.status(identity.repo)))
    )
      throw new RelayError(
        'conflict',
        'repository inspection requires a clean recorded revision',
      );
    const id = randomUUID();
    const workspace = workspaceSchema.parse({
      schemaVersion: 1,
      id,
      taskId,
      kind,
      state: kind === 'repository' ? 'ready' : 'creating',
      ...identity,
      root,
      path: kind === 'repository' ? identity.repo : join(root, id),
      contentHash: null,
      branch: kind === 'implementation' ? `codex/task-${taskId}` : null,
      baselineRevision: implementation?.baselineRevision ?? task.codeRevision,
      revision: task.codeRevision,
      requirementVersion: task.requirementVersion,
    });
    if (kind !== 'repository' && (await exists(workspace.path)))
      throw new RelayError('conflict', 'workspace destination already exists');
    this.tasks.db.transaction(() => {
      const current = this.tasks.get(taskId);
      if (current.version !== task.version)
        throw new RelayError(
          'conflict',
          'task changed during workspace preparation',
        );
      if (
        this.tasks.db.sql
          .prepare('SELECT 1 FROM workspace_access WHERE task_id=?')
          .get(taskId)
      )
        throw new RelayError('conflict', 'task workspace is already occupied');
      this.tasks.db.sql
        .prepare(
          'INSERT INTO workspaces(id,task_id,operation_key,document) VALUES(?,?,?,?)',
        )
        .run(
          id,
          taskId,
          kind === 'implementation'
            ? kind
            : `${kind}:${task.requirementVersion}:${task.codeRevision}`,
          JSON.stringify(workspace),
        );
      this.tasks.append(
        taskId,
        null,
        `workspace:${id}`,
        'workspace.prepared',
        `${kind}:${task.codeRevision}`,
      );
    });
    if (kind === 'repository') return workspace;
    await this.git.create(workspace);
    await this.git.verify(workspace, true);
    const contentHash =
      kind === 'review' ? await contentDigest(workspace.path) : null;
    return this.tasks.db.transaction(() =>
      this.save({ ...workspace, state: 'ready', contentHash }),
    );
  }
  async inspect(
    id: string,
  ): Promise<{ workspace: Workspace; consistent: boolean }> {
    const workspace = this.get(id);
    try {
      await this.git.verify(workspace, workspace.kind !== 'implementation');
      return { workspace, consistent: true };
    } catch {
      return { workspace, consistent: false };
    }
  }
  async remove(id: string): Promise<Workspace> {
    const workspace = this.get(id);
    if (pathKey(await destination(this.root)) !== pathKey(workspace.root))
      throw new RelayError(
        'conflict',
        'configured workspace root differs from registration',
      );
    if (!terminal.has(this.tasks.get(workspace.taskId).status))
      throw new RelayError(
        'conflict',
        'only terminal task workspaces can be removed',
      );
    if (workspace.state === 'removed') return workspace;
    if (workspace.state !== 'ready' || workspace.kind === 'repository')
      throw new RelayError('conflict', 'workspace is not eligible for removal');
    await this.git.assertRemovable(workspace);
    this.tasks.db.transaction(() => {
      if (
        this.get(id).state !== 'ready' ||
        this.tasks.db.sql
          .prepare('SELECT 1 FROM workspace_access WHERE task_id=?')
          .get(workspace.taskId)
      )
        throw new RelayError('conflict', 'workspace is occupied or changed');
      this.save({ ...workspace, state: 'removing' });
    });
    await this.git.remove(workspace);
    return this.tasks.db.transaction(() =>
      this.save({ ...workspace, state: 'removed' }),
    );
  }
}
