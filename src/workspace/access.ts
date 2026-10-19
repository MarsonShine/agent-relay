import { randomUUID } from 'node:crypto';
import type { Run } from '../core/contracts.ts';
import type { ExecutionRequest } from '../core/execution.ts';
import { RelayError } from '../core/errors.ts';
import { Runs } from '../storage/runs.ts';
import type { WorkspaceLease, WorkspaceMode } from './contracts.ts';
import { destination, pathKey } from './git.ts';
import type { Workspaces } from './manager.ts';

export class WorkspaceAccess {
  readonly workspaces: Workspaces;
  readonly runs: Runs;
  constructor(workspaces: Workspaces) {
    this.workspaces = workspaces;
    this.runs = new Runs(workspaces.tasks);
  }
  private owned(run: Run): void {
    const current = this.runs.get(run.id);
    const task = this.workspaces.tasks.get(run.taskId);
    if (
      current.owner !== run.owner ||
      current.taskId !== run.taskId ||
      current.executorVersion !== run.executorVersion ||
      current.status !== 'active' ||
      current.leaseUntil <= Date.now() ||
      task.status !== 'running' ||
      task.control !== null ||
      task.deadlineAt <= Date.now() ||
      JSON.stringify(current.profile) !== JSON.stringify(run.profile) ||
      JSON.stringify(current.profile) !==
        JSON.stringify(task.config.profiles[current.profile.role]) ||
      current.evidence.requirementVersion !== run.evidence.requirementVersion ||
      current.evidence.codeRevision !== run.evidence.codeRevision ||
      task.requirementVersion !== run.evidence.requirementVersion ||
      task.codeRevision !== run.evidence.codeRevision
    )
      throw new RelayError(
        'conflict',
        'workspace access requires the active owner and current evidence',
      );
  }
  async acquire(run: Run, mode: WorkspaceMode): Promise<WorkspaceLease> {
    this.owned(run);
    if (
      (mode === 'implementation') !==
      (run.profile.permission === 'workspace-write')
    )
      throw new RelayError(
        'invalid',
        'workspace mode does not match the frozen permission',
      );
    const workspace = await this.workspaces.prepare(run.taskId, mode);
    const revision = await this.workspaces.git.verify(
      workspace,
      mode !== 'implementation',
    );
    if (revision !== run.evidence.codeRevision)
      throw new RelayError(
        'conflict',
        'workspace HEAD does not match run evidence',
      );
    const lease: WorkspaceLease = {
      workspace,
      runId: run.id,
      owner: run.owner,
      token: randomUUID(),
      revision,
      requirementVersion: run.evidence.requirementVersion,
    };
    this.workspaces.tasks.db.transaction(() => {
      this.owned(run);
      if (this.workspaces.get(workspace.id).state !== 'ready')
        throw new RelayError('conflict', 'workspace is not ready');
      this.workspaces.tasks.db.sql
        .prepare(
          'INSERT INTO workspace_access(task_id,workspace_id,run_id,owner,token) VALUES(?,?,?,?,?)',
        )
        .run(run.taskId, workspace.id, run.id, run.owner, lease.token);
    });
    return lease;
  }
  declaration(
    lease: WorkspaceLease,
  ): NonNullable<ExecutionRequest['workspace']> {
    return {
      path: lease.workspace.path,
      kind: lease.workspace.kind === 'repository' ? 'repository' : 'worktree',
      managedId: lease.workspace.id,
      revision: lease.revision,
      access:
        lease.workspace.kind === 'implementation'
          ? 'workspace-write'
          : 'read-only',
    };
  }
  private checkLease(lease: WorkspaceLease): void {
    const run = this.runs.get(lease.runId);
    this.owned({
      ...run,
      owner: lease.owner,
      evidence: {
        requirementVersion: lease.requirementVersion,
        codeRevision: lease.revision,
      },
    });
    const row = this.workspaces.tasks.db.sql
      .prepare(
        'SELECT 1 FROM workspace_access WHERE task_id=? AND workspace_id=? AND run_id=? AND owner=? AND token=?',
      )
      .get(
        run.taskId,
        lease.workspace.id,
        lease.runId,
        lease.owner,
        lease.token,
      );
    if (!row || this.workspaces.get(lease.workspace.id).state !== 'ready')
      throw new RelayError(
        'conflict',
        'workspace ownership is stale or quarantined',
      );
  }
  async validate(lease: WorkspaceLease): Promise<void> {
    this.checkLease(lease);
    try {
      const workspace = this.workspaces.get(lease.workspace.id);
      if (
        pathKey(await destination(this.workspaces.root)) !==
        pathKey(workspace.root)
      )
        throw new RelayError('conflict', 'configured workspace root changed');
      const identity = await this.workspaces.git.identity(
        this.workspaces.tasks.get(workspace.taskId).repo,
      );
      if (
        pathKey(identity.repo) !== pathKey(workspace.repo) ||
        pathKey(identity.commonDir) !== pathKey(workspace.commonDir)
      )
        throw new RelayError('conflict', 'source repository identity changed');
      const revision = await this.workspaces.git.verify(
        workspace,
        workspace.kind !== 'implementation',
      );
      if (workspace.kind !== 'implementation' && revision !== lease.revision)
        throw new RelayError('conflict', 'read-only revision changed');
    } catch (error) {
      this.workspaces.tasks.db.transaction(() => {
        const current = this.workspaces.get(lease.workspace.id);
        if (current.state === 'ready')
          this.workspaces.tasks.db.sql
            .prepare('UPDATE workspaces SET document=? WHERE id=?')
            .run(JSON.stringify({ ...current, state: 'tainted' }), current.id);
      });
      throw error;
    }
    this.checkLease(lease);
  }
}
