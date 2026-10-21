import { z } from 'zod';
import type { LocalWorkflow } from '../workflow/local.ts';
import { RelayError } from '../core/errors.ts';
import type { Task } from '../core/contracts.ts';
import { Deliveries } from './delivery-store.ts';
import { Publisher } from './delivery.ts';
import { Poller } from './poll.ts';
import { Feedback } from './feedback.ts';
import type { Push } from './push.ts';

export const deliveryCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().positive(),
  action: z.enum(['publish', 'reconcile', 'complete', 'cancel']),
});
export class GitHubWorkflow {
  readonly store: Deliveries;
  readonly publisher: Publisher;
  readonly poller: Poller;
  readonly feedback: Feedback;
  readonly local: LocalWorkflow;
  private active: Promise<void> | null = null;
  private closing = false;
  constructor(store: Deliveries, push: Push, local: LocalWorkflow) {
    this.store = store;
    this.local = local;
    this.publisher = new Publisher(store, push, (task, base) =>
      this.candidate(task, base),
    );
    this.poller = new Poller(store);
    this.feedback = new Feedback(store);
  }
  async candidate(task: Task, baseRevision?: string): Promise<string> {
    const issues = await this.local.acceptance(task);
    if (issues.length) throw new RelayError('conflict', issues.join('; '));
    if (this.store.tasks.get(task.id).version !== task.version)
      throw new RelayError(
        'conflict',
        'candidate changed during acceptance check',
      );
    const workspace = this.local.workspaces
      .list(task.id)
      .find((w) => w.kind === 'implementation')!;
    if (baseRevision && workspace.baselineRevision !== baseRevision)
      throw new RelayError(
        'conflict',
        'publication base must match the accepted workspace baseline',
      );
    return workspace.path;
  }
  async command(taskId: string, value: unknown): Promise<void> {
    const command = deliveryCommandSchema.parse(value),
      task = this.store.tasks.get(taskId);
    if (task.version !== command.expectedVersion)
      throw new RelayError('conflict', 'task version changed');
    if (command.action === 'publish') {
      await this.publisher.prepare(task);
      return;
    }
    const d = this.store.get(taskId);
    if (!d) throw new RelayError('not_found', 'delivery not started');
    if (command.action === 'cancel') {
      if (d.status === 'complete')
        throw new RelayError('conflict', 'delivery already completed');
      this.store.save({
        ...d,
        status: 'cancelled',
        diagnostic:
          'user cancelled remote delivery; completed effects remain recorded',
      });
      return;
    }
    if (command.action === 'complete') {
      await this.candidate(task);
      this.feedback.finish(taskId, command.expectedVersion);
      return;
    }
    if (
      d.status !== 'blocked' ||
      Date.now() >= d.deadlineAt ||
      d.polls >= this.store.sources.get(taskId)!.policy.maxPolls
    )
      throw new RelayError(
        'conflict',
        'reconciliation cannot reset terminal state or budgets',
      );
    await this.candidate(task);
    this.store.tasks.db.transaction(() => {
      const current = this.store.get(taskId);
      if (
        !current ||
        current.status !== 'blocked' ||
        current.current !== d.current ||
        this.store.tasks.get(taskId).version !== task.version ||
        Date.now() >= current.deadlineAt ||
        current.polls >= this.store.sources.get(taskId)!.policy.maxPolls
      )
        throw new RelayError(
          'conflict',
          'delivery changed during reconciliation',
        );
      const intent = this.store.intent(current.current);
      this.store.save({
        ...current,
        status:
          intent.push === 'settled' && intent.pull === 'settled'
            ? 'watching'
            : 'pending',
        diagnostic: null,
      });
    });
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.active ??= this.run().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async run(): Promise<void> {
    for (const d of this.store.list()) {
      if (d.status !== 'waiting_local') continue;
      const task = this.store.tasks.get(d.taskId);
      if (task.status === 'succeeded' && task.stage === 'deliver') {
        try {
          await this.publisher.prepare(task);
        } catch {
          const current = this.store.get(d.taskId)!;
          if (
            current.status === 'waiting_local' &&
            current.current === d.current
          )
            this.store.save({
              ...current,
              status: 'blocked',
              diagnostic:
                'updated local candidate could not be prepared for delivery',
            });
        }
      } else if (
        ['blocked', 'failed', 'cancelled'].includes(task.status) ||
        Date.now() >= d.deadlineAt
      )
        this.store.save({
          ...d,
          status: 'blocked',
          diagnostic: 'local feedback workflow blocked or deadline exhausted',
        });
    }
    await this.publisher.tick();
    await this.poller.tick();
    for (const d of this.store.list().filter((d) => d.status === 'watching')) {
      try {
        this.feedback.consume(d.taskId);
      } catch {
        this.store.save({
          ...this.store.get(d.taskId)!,
          status: 'blocked',
          diagnostic:
            'feedback could not be applied within original acceptance and budget gates',
        });
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.active;
  }
}
