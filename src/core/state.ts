import type { Status } from './contracts.ts';
import { RelayError } from './errors.ts';

export const terminal = new Set<Status>(['succeeded', 'failed', 'cancelled']);
const transitions: Record<Status, readonly Status[]> = {
  queued: ['running', 'paused', 'cancelled', 'blocked'],
  running: [
    'waiting_user',
    'recovering',
    'succeeded',
    'failed',
    'blocked',
    'paused',
    'cancelled',
  ],
  waiting_user: ['queued', 'paused', 'cancelled'],
  paused: ['queued', 'waiting_user', 'cancelled'],
  recovering: ['paused', 'cancelled', 'blocked', 'failed'],
  blocked: ['paused', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};
export function assertTransition(from: Status, to: Status): void {
  if (from !== to && !transitions[from].includes(to)) {
    throw new RelayError(
      'conflict',
      `illegal task transition: ${from} -> ${to}`,
    );
  }
}
