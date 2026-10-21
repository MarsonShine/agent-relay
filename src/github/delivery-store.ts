import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tasks } from '../storage/tasks.ts';
import type { Task } from '../core/contracts.ts';
import { RelayError } from '../core/errors.ts';
import { Sources } from './source.ts';
import type { Transport } from './transport.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const step = z.enum(['prepared', 'dispatched', 'settled']);
export const intentSchema = z.strictObject({
  key: z.uuid(),
  taskId: z.uuid(),
  sourceVersion: z.string(),
  requirementVersion: z.number().int().positive(),
  revision: sha,
  branch: z.string(),
  baseRevision: sha,
  expectedRemote: sha.nullable(),
  marker: z.string(),
  push: step,
  pull: step,
  pr: z.number().int().positive().nullable(),
  url: z.string().nullable(),
});
export type DeliveryIntent = z.infer<typeof intentSchema>;
export const deliverySchema = z.strictObject({
  taskId: z.uuid(),
  current: z.uuid(),
  status: z.enum([
    'pending',
    'waiting_local',
    'watching',
    'complete',
    'blocked',
    'cancelled',
  ]),
  diagnostic: z.string().nullable(),
  polls: z.number().int().nonnegative(),
  nextPollAt: z.number().nonnegative(),
  deadlineAt: z.number().positive(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export class Deliveries {
  readonly tasks: Tasks;
  readonly sources: Sources;
  constructor(tasks: Tasks, transport: Transport) {
    this.tasks = tasks;
    this.sources = new Sources(tasks, transport);
  }
  get(taskId: string): Delivery | null {
    const row = this.tasks.db.sql
      .prepare('SELECT document FROM deliveries WHERE task_id=?')
      .get(taskId);
    return row ? deliverySchema.parse(JSON.parse(String(row.document))) : null;
  }
  intent(key: string): DeliveryIntent {
    const row = this.tasks.db.sql
      .prepare('SELECT document FROM delivery_intents WHERE operation_key=?')
      .get(key);
    if (!row) throw new RelayError('not_found', 'delivery intent not found');
    return intentSchema.parse(JSON.parse(String(row.document)));
  }
  list(): Delivery[] {
    return this.tasks.db.sql
      .prepare('SELECT document FROM deliveries')
      .all()
      .map((r) => deliverySchema.parse(JSON.parse(String(r.document))));
  }
  save(delivery: Delivery): void {
    this.tasks.db.sql
      .prepare(
        'INSERT INTO deliveries VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document',
      )
      .run(delivery.taskId, JSON.stringify(deliverySchema.parse(delivery)));
  }
  saveIntent(intent: DeliveryIntent): void {
    this.tasks.db.sql
      .prepare(
        'INSERT INTO delivery_intents VALUES(?,?,?) ON CONFLICT(operation_key) DO UPDATE SET document=excluded.document',
      )
      .run(
        intent.key,
        intent.taskId,
        JSON.stringify(intentSchema.parse(intent)),
      );
  }
  current(intent: DeliveryIntent): Task {
    const task = this.tasks.get(intent.taskId),
      source = this.sources.get(task.id),
      delivery = this.get(task.id);
    if (
      !source ||
      source.sourceVersion !== intent.sourceVersion ||
      task.requirementVersion !== intent.requirementVersion ||
      task.codeRevision !== intent.revision ||
      delivery?.current !== intent.key ||
      delivery.status !== 'pending' ||
      task.status !== 'succeeded' ||
      task.control ||
      Date.now() >= delivery.deadlineAt
    )
      throw new RelayError(
        'conflict',
        'delivery no longer owns current accepted requirement/candidate',
      );
    return task;
  }
  prepare(task: Task, baseRevision: string): DeliveryIntent {
    return this.tasks.db.transaction(() => {
      const current = this.tasks.get(task.id),
        source = this.sources.get(task.id),
        previous = this.get(task.id);
      if (
        current.version !== task.version ||
        current.status !== 'succeeded' ||
        current.stage !== 'deliver' ||
        !current.codeRevision ||
        !source?.policy.publish ||
        Date.now() >= task.deadlineAt
      )
        throw new RelayError(
          'conflict',
          'delivery requires current local acceptance and trusted publish permission',
        );
      const old = previous ? this.intent(previous.current) : null;
      if (
        previous &&
        ['complete', 'cancelled', 'blocked'].includes(previous.status)
      )
        throw new RelayError(
          'conflict',
          'previous delivery is terminal or blocked',
        );
      if (
        old?.revision === task.codeRevision &&
        old.requirementVersion === task.requirementVersion
      ) {
        if (previous?.status === 'waiting_local') {
          if (old.push !== 'settled' || old.pull !== 'settled')
            throw new RelayError(
              'conflict',
              'unchanged candidate has unknown publication effects',
            );
          this.save({ ...previous, status: 'watching', diagnostic: null });
        }
        return old;
      }
      if (
        previous &&
        (['complete', 'cancelled', 'blocked'].includes(previous.status) ||
          old?.push !== 'settled' ||
          old.pull !== 'settled')
      )
        throw new RelayError(
          'conflict',
          'previous delivery is terminal or has unknown side effects',
        );
      const key = randomUUID();
      const intent = intentSchema.parse({
        key,
        taskId: task.id,
        sourceVersion: source.sourceVersion,
        requirementVersion: task.requirementVersion,
        revision: task.codeRevision,
        branch: `codex/task-${task.id}/delivery`,
        baseRevision,
        expectedRemote: old?.revision ?? null,
        marker: old?.marker ?? `<!-- agent-relay:${task.id} -->`,
        push: 'prepared',
        pull: old?.pr ? 'settled' : 'prepared',
        pr: old?.pr ?? null,
        url: old?.url ?? null,
      });
      this.saveIntent(intent);
      this.save({
        taskId: task.id,
        current: key,
        status: 'pending',
        diagnostic: null,
        polls: previous?.polls ?? 0,
        nextPollAt: previous?.nextPollAt ?? 0,
        deadlineAt: previous?.deadlineAt ?? task.deadlineAt,
      });
      this.tasks.append(
        task.id,
        null,
        `delivery:${key}`,
        'delivery.prepared',
        `${intent.requirementVersion}:${intent.revision}`,
      );
      return intent;
    });
  }
  claim(key: string, step: 'push' | 'pull'): DeliveryIntent | null {
    return this.tasks.db.transaction(() => {
      const intent = this.intent(key);
      this.current(intent);
      if (intent[step] !== 'prepared') return null;
      intent[step] = 'dispatched';
      this.saveIntent(intent);
      return intent;
    });
  }
}
