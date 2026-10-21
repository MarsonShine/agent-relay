import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CodexEvents,
  testedCodexVersion,
} from '../src/adapters/codex/events.ts';
const id = '00000000-0000-4000-8000-000000000001';
const beginning = [
  { type: 'thread.started', thread_id: id },
  { type: 'turn.started' },
];
const end = {
  type: 'turn.completed',
  usage: { input_tokens: 12, cached_input_tokens: 5, output_tokens: 3 },
};
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

test('native UTF-8 chunks, duplicate events and unknown information preserve one turn', () => {
  const parser = new CodexEvents(testedCodexVersion);
  const progress = {
    type: 'item.completed',
    item: { id: 'item-a', type: 'agent_message', text: '中文' },
  };
  const bytes = Buffer.concat(
    [
      ...beginning,
      { type: 'future.info', value: 1 },
      progress,
      progress,
      end,
      end,
    ].map(line),
  );
  const events = [];
  for (const byte of bytes) events.push(...parser.push(Uint8Array.of(byte)));
  const result = parser.finish(0);
  assert.equal(result.outcome, 'turn_completed');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(events.filter((event) => event.type === 'progress').length, 1);
  assert.equal(
    events.some((event) => event.type === 'completed'),
    false,
  );
  assert.ok(
    events.every(
      (event) => !event.message.includes(id) && !event.message.includes('中文'),
    ),
  );
  assert.equal(JSON.parse(result.continuation!).session, id);
});

test('M0 protocol projections preserve outcome distinctions without using private transcripts', () => {
  const projections = readFileSync(
    new URL('../docs/m0/events.sanitized.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((text) => JSON.parse(text) as Record<string, unknown>);
  for (const scenario of new Set(projections.map((event) => event.scenario))) {
    const parser = new CodexEvents(testedCodexVersion);
    for (const { scenario: _scenario, ...event } of projections.filter(
      (event) => event.scenario === scenario,
    )) {
      // The public projection replaces native identities; restore a synthetic, non-resumable fixture UUID.
      if (event.type === 'thread.started') event.thread_id = id;
      parser.push(line(event));
    }
    assert.equal(
      parser.finish(
        scenario === 'invalid-effort' || scenario === 'no-auth' ? 1 : 0,
      ).outcome,
      scenario === 'invalid-effort' || scenario === 'no-auth'
        ? 'failed'
        : scenario === 'cancel'
          ? 'needs_reconciliation'
          : 'turn_completed',
    );
  }
});

test('zero exit, JSON validity and agent claims cannot establish a completed turn alone', () => {
  for (const contents of [
    [],
    beginning,
    [
      ...beginning,
      {
        type: 'item.completed',
        item: { id: 'claim', type: 'agent_message', text: 'completed' },
      },
    ],
    [end],
  ]) {
    const parser = new CodexEvents(testedCodexVersion);
    parser.push(Buffer.concat(contents.map(line)));
    assert.equal(parser.finish(0).outcome, 'needs_reconciliation');
  }
  for (const exitCode of [1, null]) {
    const parser = new CodexEvents(testedCodexVersion);
    parser.push(Buffer.concat([...beginning, end].map(line)));
    assert.notEqual(parser.finish(exitCode).outcome, 'turn_completed');
  }
});

test('malformed output, conflicting sessions, duplicate contents and terminals fail closed', () => {
  const item = {
    type: 'item.completed',
    item: { id: 'item', type: 'agent_message', text: 'A' },
  };
  const suffixes = [
    Buffer.from('{broken}\n'),
    Buffer.from('{"type":"turn.completed"}'),
    Uint8Array.of(0xff),
    Buffer.concat(
      [item, { ...item, item: { ...item.item, text: 'B' } }].map(line),
    ),
    line({
      type: 'thread.started',
      thread_id: '00000000-0000-4000-8000-000000000002',
    }),
    line({ type: 'turn.failed' }),
  ];
  for (const suffix of suffixes) {
    const parser = new CodexEvents(testedCodexVersion);
    parser.push(Buffer.concat(beginning.map(line)));
    parser.push(suffix);
    parser.push(line(end));
    assert.notEqual(parser.finish(0).outcome, 'turn_completed');
  }
  const parser = new CodexEvents(testedCodexVersion);
  parser.push(Buffer.concat([...beginning, end, { type: 'error' }].map(line)));
  assert.equal(parser.finish(0).outcome, 'failed');
});

test('native decoder enforces byte, line, event and supported-version limits', () => {
  for (const limits of [
    { maxBytes: 20, maxLineBytes: 1000, maxEvents: 100 },
    { maxBytes: 1000, maxLineBytes: 20, maxEvents: 100 },
    { maxBytes: 1000, maxLineBytes: 1000, maxEvents: 2 },
  ]) {
    const parser = new CodexEvents(testedCodexVersion, limits);
    parser.push(Buffer.concat([...beginning, end].map(line)));
    assert.equal(parser.finish(0).outcome, 'needs_reconciliation');
  }
  assert.throws(
    () => new CodexEvents('unverified-version'),
    /not been verified/,
  );
  const parser = new CodexEvents(testedCodexVersion);
  parser.finish(0);
  assert.throws(() => parser.push(line(end)), /closed/);
});
