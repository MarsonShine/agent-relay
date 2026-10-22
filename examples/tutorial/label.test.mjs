import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLabel } from '../src/label.mjs';

test('trims surrounding whitespace', () => {
  assert.equal(normalizeLabel('  hello  '), 'hello');
});

test('collapses internal whitespace and preserves Chinese text', () => {
  assert.equal(normalizeLabel('  中文\t hello\n world  '), '中文 hello world');
});

test('empty and whitespace-only labels stay empty', () => {
  assert.equal(normalizeLabel(''), '');
  assert.equal(normalizeLabel(' \t\n'), '');
});
