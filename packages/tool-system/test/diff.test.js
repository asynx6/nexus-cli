// diff.js unit tests — Myers path, hunks, CRLF, fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff, diffOps, splitLines } from '../src/tools/diff.js';

test('unifiedDiff: single line change', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.match(d, /--- a/);
  assert.match(d, /\+\+\+ b/);
  assert.match(d, /@@ -1,3 \+1,3 @@/);
  assert.ok(d.includes('-b\n'));
  assert.ok(d.includes('+B\n'));
});

test('unifiedDiff: pure insertion', () => {
  const d = unifiedDiff('one\nthree\n', 'one\ntwo\nthree\n');
  assert.ok(d.includes('+two\n'));
  assert.match(d, /@@ -1,2 \+1,3 @@/);
});

test('unifiedDiff: two hunks with context 3 collapses when close', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const b = a.replace('line 3\n', 'LINE 3\n').replace('line 15\n', 'LINE 15\n');
  const d = unifiedDiff(a, b);
  assert.equal(d.split('\n').filter((l) => l.startsWith('@@')).length, 2);
});

test('unifiedDiff: no changes -> header only', () => {
  const d = unifiedDiff('same\n', 'same\n');
  assert.equal(d, '--- a\n+++ b');
});

test('unifiedDiff: empty to content', () => {
  const d = unifiedDiff('', 'hello\n');
  assert.ok(d.includes('+hello'));
});

test('splitLines preserves CRLF terminators', () => {
  const ls = splitLines('a\r\nb\r\n');
  assert.equal(ls[0], 'a\r\n');
  assert.equal(ls[1], 'b\r\n');
});

test('CRLF vs LF same content -> diff still minimal', () => {
  const d = unifiedDiff('a\r\nb\r\n', 'a\nb\n');
  // stripCr in eq: identical logical lines -> no hunks
  assert.equal(d, '--- a\n+++ b');
});

test('diffOps: mixed edits produce valid op sequence', () => {
  const a = splitLines('x\ny\nz\n');
  const b = splitLines('x\nY\nW\nz\n');
  const eq = (i, j) => a[i] === b[j];
  const ops = diffOps(a, b, eq);
  const rebuiltA = ops.filter((o) => o.t !== 'ins').map((o) => a[o.i]).join('');
  const rebuiltB = ops.filter((o) => o.t !== 'del').map((o) => b[o.j]).join('');
  assert.equal(rebuiltA, 'x\ny\nz\n');
  assert.equal(rebuiltB, 'x\nY\nW\nz\n');
});

test('fallback path: wildly different files still produce a diff', () => {
  const a = Array.from({ length: 4000 }, (_, i) => `aaa${i}\n`).join('');
  const b = Array.from({ length: 4000 }, (_, i) => `bbb${i}\n`).join('');
  const d = unifiedDiff(a, b, { context: 1 });
  assert.ok(d.includes('--- a'));
  assert.ok(d.includes('@@'));
  assert.ok(d.split('\n').length > 10);
});
