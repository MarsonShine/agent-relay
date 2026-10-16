import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent } from '../../core/execution.ts';
import { RelayError } from '../../core/errors.ts';

export const testedCodexVersion = '0.162.0-alpha.17.2';
const envelope = z.object({ type: z.string().min(1).max(128) }).passthrough();
const itemSchema = z
  .object({ id: z.string().min(1).max(256), type: z.string().min(1).max(128) })
  .passthrough();
const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .passthrough();
const limitsSchema = z.strictObject({
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
  maxLineBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
  maxEvents: z.number().int().positive().max(100_000),
});
export type CodexTurn = {
  outcome: 'turn_completed' | 'failed' | 'needs_reconciliation';
  continuation: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  diagnostics: string[];
};

/** One CLI invocation. A completed turn is protocol evidence, not task acceptance. */
export class CodexEvents {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly limits: z.infer<typeof limitsSchema>;
  private readonly seen = new Map<string, string>();
  private readonly diagnostics = new Set<string>();
  private pending = '';
  private bytes = 0;
  private count = 0;
  private threadId: string | null = null;
  private started = false;
  private completed = false;
  private failed = false;
  private ended = false;
  private usage: CodexTurn['usage'] = null;
  constructor(
    version: string,
    limits = {
      maxBytes: 2 * 1024 * 1024,
      maxLineBytes: 262_144,
      maxEvents: 10_000,
    },
  ) {
    if (version !== testedCodexVersion)
      throw new RelayError(
        'invalid',
        'Codex event format has not been verified for this version',
      );
    this.limits = limitsSchema.parse(limits);
  }
  push(chunk: Uint8Array): AgentEvent[] {
    if (this.ended)
      throw new RelayError('conflict', 'Codex event stream is already closed');
    if (this.diagnostics.size > 0) return [];
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limits.maxBytes) {
      this.reject('output limit exceeded');
      return [];
    }
    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
    } catch {
      this.reject('invalid UTF-8');
      return [];
    }
    const events: AgentEvent[] = [];
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      if (Buffer.byteLength(line) > this.limits.maxLineBytes) {
        this.reject('line limit exceeded');
        break;
      }
      if (!line.trim()) continue;
      if (++this.count > this.limits.maxEvents) {
        this.reject('event limit exceeded');
        break;
      }
      try {
        events.push(...this.consume(envelope.parse(JSON.parse(line))));
      } catch {
        this.reject('invalid native event');
        break;
      }
      if (this.diagnostics.size > 0) break;
    }
    if (Buffer.byteLength(this.pending) > this.limits.maxLineBytes)
      this.reject('line limit exceeded');
    return events;
  }
  finish(exitCode: number | null): CodexTurn {
    if (this.ended)
      throw new RelayError('conflict', 'Codex event stream is already closed');
    this.ended = true;
    try {
      this.pending += this.decoder.decode();
    } catch {
      this.reject('invalid UTF-8');
    }
    if (this.pending.trim()) this.reject('truncated JSONL');
    let outcome: CodexTurn['outcome'] = 'needs_reconciliation';
    if (this.failed || (exitCode !== null && exitCode !== 0))
      outcome = 'failed';
    else if (
      exitCode === 0 &&
      this.started &&
      this.threadId &&
      this.completed &&
      this.diagnostics.size === 0
    )
      outcome = 'turn_completed';
    return {
      outcome,
      continuation:
        this.threadId && this.diagnostics.size === 0
          ? JSON.stringify({
              schemaVersion: 1,
              backend: 'codex-cli',
              version: testedCodexVersion,
              session: this.threadId,
            })
          : null,
      usage: this.usage && { ...this.usage },
      diagnostics: [...this.diagnostics],
    };
  }
  private reject(message: string): void {
    this.diagnostics.add(message);
    this.pending = '';
  }
  private event(
    key: string,
    type: AgentEvent['type'],
    message: string,
  ): AgentEvent {
    return { schemaVersion: 1, key, type, message };
  }
  private duplicate(key: string, value: unknown): boolean {
    const text = JSON.stringify(value);
    const prior = this.seen.get(key);
    if (prior !== undefined) {
      if (prior !== text) this.reject('conflicting duplicate event');
      return true;
    }
    this.seen.set(key, text);
    return false;
  }
  private consume(event: z.infer<typeof envelope>): AgentEvent[] {
    switch (event.type) {
      case 'thread.started': {
        const id = z.uuid().parse(event.thread_id);
        if (this.duplicate('thread.started', id)) return [];
        if (this.started) {
          this.reject('session arrived after turn start');
          return [];
        }
        this.threadId = id;
        return [];
      }
      case 'turn.started':
        if (this.duplicate(event.type, true)) return [];
        if (!this.threadId) {
          this.reject('turn started without session');
          return [];
        }
        this.started = true;
        return [this.event('turn-started', 'started', 'Codex turn started')];
      case 'item.started':
      case 'item.completed': {
        if (!this.started || this.completed || this.failed) {
          this.reject('item outside active turn');
          return [];
        }
        const item = itemSchema.parse(event.item);
        const key = `${event.type}:${createHash('sha256').update(item.id).digest('hex').slice(0, 32)}`;
        if (this.duplicate(key, item)) return [];
        // Native tool text, paths and session identifiers stay inside the adapter.
        return [
          this.event(
            key,
            'progress',
            `${item.type}: ${event.type === 'item.started' ? 'started' : 'finished'}`,
          ),
        ];
      }
      case 'turn.completed': {
        if (!this.started) {
          this.reject('terminal without turn start');
          return [];
        }
        const usage =
          event.usage === undefined ? null : usageSchema.parse(event.usage);
        if (this.duplicate(event.type, usage)) return [];
        if (this.failed) {
          this.reject('conflicting terminal events');
          return [];
        }
        this.completed = true;
        if (!usage) return [];
        this.usage = {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        };
        return [this.event('turn-usage', 'usage', JSON.stringify(this.usage))];
      }
      case 'error':
      case 'turn.failed':
        if (this.completed) this.reject('conflicting terminal events');
        this.failed = true;
        return [];
      default:
        // Future informational events can be ignored; they cannot establish success.
        return [];
    }
  }
}
