import { RelayError } from '../core/errors.ts';
import type { Task } from '../core/contracts.ts';
import { Deliveries } from './delivery-store.ts';
import type { DeliveryIntent } from './delivery-store.ts';
import { GitHubApi, pullSchema } from './api.ts';
import { repository } from './source.ts';
import { successful } from './transport.ts';
import type { Push } from './push.ts';

export class Publisher {
  readonly store: Deliveries;
  readonly push: Push;
  readonly candidate: (task: Task, baseRevision?: string) => Promise<string>;
  private busy = false;
  constructor(
    store: Deliveries,
    push: Push,
    candidate: (task: Task, baseRevision?: string) => Promise<string>,
  ) {
    this.store = store;
    this.push = push;
    this.candidate = candidate;
  }
  async prepare(task: Task): Promise<DeliveryIntent> {
    await this.candidate(task);
    const source = this.store.sources.get(task.id);
    if (!source)
      throw new RelayError('invalid', 'task was not imported from GitHub');
    const api = new GitHubApi(this.store.sources.transport, source.policy);
    await repository(api.transport, source.policy);
    const base = await api.ref(source.policy.base);
    if (!base)
      throw new RelayError('conflict', 'trusted base branch is missing');
    await this.candidate(task, base);
    return this.store.prepare(task, base);
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const delivery of this.store
        .list()
        .filter((d) => d.status === 'pending')) {
        try {
          await this.dispatch(delivery.current);
        } catch (error) {
          const current = this.store.get(delivery.taskId)!;
          if (
            current.current === delivery.current &&
            current.status === 'pending'
          )
            this.store.save({
              ...current,
              status: 'blocked',
              diagnostic:
                error instanceof RelayError
                  ? error.message
                  : 'GitHub operation failed; reconcile before further publication',
            });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async dispatch(key: string): Promise<void> {
    let intent = this.store.intent(key);
    const task = this.store.current(intent),
      source = this.store.sources.get(task.id)!;
    const api = new GitHubApi(this.store.sources.transport, source.policy);
    const workspace = await this.candidate(task, intent.baseRevision);
    await repository(api.transport, source.policy);
    if ((await api.ref(source.policy.base)) !== intent.baseRevision)
      throw new RelayError('conflict', 'trusted base changed during delivery');
    if (
      intent.push === 'dispatched' &&
      (await this.push.stop(intent)) !== 'stopped'
    )
      throw new RelayError('conflict', 'push owner is still unknown');
    let remote = await api.ref(intent.branch);
    if (
      intent.push === 'dispatched' &&
      remote !== intent.revision &&
      remote !== intent.expectedRemote
    )
      throw new RelayError(
        'conflict',
        'remote head was changed by another actor',
      );
    const pulls = await api.pulls(intent.branch);
    if (pulls.length > 1)
      throw new RelayError('conflict', 'multiple PRs use the delivery branch');
    if (pulls[0])
      api.validatePull(
        pulls[0],
        intent.branch,
        intent.marker,
        intent.push === 'dispatched' && remote === intent.revision
          ? intent.revision
          : intent.push === 'settled'
            ? intent.revision
            : (intent.expectedRemote ?? intent.revision),
        intent.baseRevision,
      );
    if (intent.pr && pulls[0]?.number !== intent.pr)
      throw new RelayError('conflict', 'recorded PR is missing or replaced');
    if (intent.push === 'prepared') {
      if (remote !== intent.expectedRemote || (!intent.pr && pulls.length))
        throw new RelayError(
          'conflict',
          'delivery branch already exists or was changed by another actor',
        );
      await this.candidate(this.store.current(intent));
      const claimed = this.store.claim(key, 'push');
      if (!claimed) return;
      intent = claimed;
      try {
        await this.push.send(intent, source.policy, workspace);
      } catch {
        if ((await this.push.stop(intent)) !== 'stopped')
          throw new RelayError('conflict', 'push owner is still unknown');
      }
      remote = await api.ref(intent.branch);
    }
    if (remote !== intent.revision)
      throw new RelayError(
        'conflict',
        'remote head does not confirm the intended push; unknown side effect is not replayed',
      );
    intent.push = 'settled';
    this.store.saveIntent(intent);
    this.store.current(intent);
    const after = await api.pulls(intent.branch);
    if (after.length > 1)
      throw new RelayError('conflict', 'multiple PRs use the delivery branch');
    let pull = after[0];
    if (!pull) {
      if (intent.pull !== 'prepared')
        throw new RelayError(
          'conflict',
          'PR outcome unknown; missing receipt does not authorize another POST',
        );
      await this.candidate(this.store.current(intent));
      const claimed = this.store.claim(key, 'pull');
      if (!claimed) return;
      intent = claimed;
      try {
        pull = pullSchema.parse(
          successful(
            await api.transport.request(`${api.root}/pulls`, 'POST', {
              title: `Agent Relay: issue #${source.issue}`,
              head: intent.branch,
              base: source.policy.base,
              body: `${intent.marker}\n\nImplements #${source.issue}. Managed bounded integration; local review and trusted validation are recorded by Agent Relay. No automatic merge.`,
            }),
          ),
        );
      } catch {
        const found = await api.pulls(intent.branch);
        if (found.length !== 1)
          throw new RelayError(
            'conflict',
            'PR creation outcome unknown; no automatic replay',
          );
        pull = found[0]!;
      }
    }
    api.validatePull(
      pull,
      intent.branch,
      intent.marker,
      intent.revision,
      intent.baseRevision,
    );
    intent = {
      ...intent,
      pull: 'settled',
      pr: pull.number,
      url: pull.html_url,
    };
    this.store.tasks.db.transaction(() => {
      this.store.saveIntent(intent);
      const d = this.store.get(task.id)!;
      // Receipts remain visible even if cancellation won the race.
      if (d.current === key && d.status === 'pending') {
        try {
          this.store.current(intent);
          this.store.save({ ...d, status: 'watching', diagnostic: null });
        } catch {
          this.store.save({
            ...d,
            status: 'blocked',
            diagnostic:
              'publication receipt retained but local evidence was superseded',
          });
        }
      }
    });
  }
}
