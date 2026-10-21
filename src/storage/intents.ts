import { z } from 'zod';
import { evidenceSchema, idSchema } from '../core/contracts.ts';
import type { Run } from '../core/contracts.ts';
import type { Tasks } from './tasks.ts';
import { RelayError } from '../core/errors.ts';

export const intentSchema = z.strictObject({
  key: z.string().min(1).max(128),
  taskId: idSchema,
  runId: idSchema,
  owner: idSchema,
  kind: z.enum(['launch', 'verification', 'result']),
  evidence: evidenceSchema,
  state: z.enum(['prepared', 'settled', 'abandoned']),
  detail: z.string().max(8192),
});
export type Intent = z.infer<typeof intentSchema>;
export class Intents {
  readonly tasks: Tasks;
  constructor(tasks: Tasks) {
    this.tasks = tasks;
  }
  list(taskId: string): Intent[] {
    return this.tasks.db.sql
      .prepare(
        'SELECT document FROM execution_intents WHERE task_id=? ORDER BY rowid',
      )
      .all(taskId)
      .map((r) => intentSchema.parse(JSON.parse(String(r.document))));
  }
  // Caller holds the same transaction as the associated state transition.
  putInside(
    run: Run,
    kind: Intent['kind'],
    key: string,
    evidence = run.evidence,
    detail = '',
  ): Intent {
    const intent = intentSchema.parse({
      key: `${run.id}:${key}`,
      taskId: run.taskId,
      runId: run.id,
      owner: run.owner,
      kind,
      evidence,
      state: 'prepared',
      detail,
    });
    this.tasks.db.sql
      .prepare('INSERT INTO execution_intents VALUES(?,?,?,?)')
      .run(intent.key, run.taskId, run.id, JSON.stringify(intent));
    return intent;
  }
  prepare(
    run: Run,
    kind: Intent['kind'],
    key: string,
    evidence = run.evidence,
    detail = '',
  ): Intent {
    return this.tasks.db.transaction(() => {
      const task = this.tasks.get(run.taskId);
      const current = this.tasks.db.sql
        .prepare("SELECT document FROM runs WHERE id=? AND status='active'")
        .get(run.id);
      const owned = current && JSON.parse(String(current.document));
      if (
        !owned ||
        owned.owner !== run.owner ||
        owned.leaseUntil <= Date.now() ||
        task.control ||
        task.requirementVersion !== run.evidence.requirementVersion ||
        task.codeRevision !== run.evidence.codeRevision
      )
        throw new RelayError(
          'conflict',
          'execution intent lost current ownership',
        );
      return this.putInside(run, kind, key, evidence, detail);
    });
  }
  settleInside(run: Run, state: 'settled' | 'abandoned'): void {
    this.tasks.db.sql
      .prepare(
        "UPDATE execution_intents SET document=json_set(document,'$.state',?) WHERE run_id=? AND json_extract(document,'$.owner')=? AND json_extract(document,'$.state')='prepared'",
      )
      .run(state, run.id, run.owner);
  }
}
