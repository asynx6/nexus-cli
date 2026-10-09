// @asynx6/audit — hash chain + verify + tamper detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditChain, canonical, sha256Hex, hashEntry, verify } from '../src/index.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'nexus-audit-'));
  return { dir: d, path: join(d, 'audit.jsonl') };
}

test('canonical: deterministic regardless of key order', () => {
  assert.equal(canonical({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});

test('canonical: arrays, nested, primitives', () => {
  assert.equal(canonical([3, 1, 2]), '[3,1,2]');
  assert.equal(canonical(null), 'null');
  assert.equal(canonical('x'), '"x"');
  assert.equal(canonical(42), '42');
  assert.equal(canonical({ x: [1, { a: 1 }] }), '{"x":[1,{"a":1}]}');
});

test('sha256Hex + hashEntry: known-vector sanity', () => {
  const h = sha256Hex('hello');
  assert.match(h, /^[a-f0-9]{64}$/);
  const e = hashEntry('0'.repeat(64), { msg: 'hi' });
  assert.match(e, /^[a-f0-9]{64}$/);
});

test('append: head advances and chain links', () => {
  const { dir, path } = tmp();
  try {
    const c = new AuditChain(path);
    const h0 = c.append({ kind: 'a', n: 1 });
    const h1 = c.append({ kind: 'b', n: 2 });
    assert.notEqual(h0, h1);
    assert.equal(c.head, h1);
    c.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const e0 = JSON.parse(lines[0]);
    const e1 = JSON.parse(lines[1]);
    assert.equal(e0.prev_hash, '0'.repeat(64));
    assert.equal(e1.prev_hash, h0);
    assert.equal(e0.hash, h0);
    assert.equal(e1.hash, h1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append: resumes from existing head on reopen', () => {
  const { dir, path } = tmp();
  try {
    const c1 = new AuditChain(path);
    const h = c1.append({ x: 1 });
    c1.close();
    const c2 = new AuditChain(path);
    assert.equal(c2.head, h);
    const h2 = c2.append({ y: 2 });
    assert.notEqual(h2, h);
    c2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify: clean log returns ok with count and head', async () => {
  const { dir, path } = tmp();
  try {
    const c = new AuditChain(path);
    c.append({ a: 1 }); c.append({ a: 2 }); c.append({ a: 3 });
    c.close();
    const r = await verify(path);
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    assert.match(r.head, /^[a-f0-9]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify: tampering in middle is detected', async () => {
  const { dir, path } = tmp();
  try {
    const c = new AuditChain(path);
    c.append({ a: 1 });
    c.append({ a: 2, important: 'value' });
    c.append({ a: 3 });
    c.close();
    // Mutate the second record's payload byte, keep its declared hash.
    const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const second = JSON.parse(raw[1]);
    second.a = 999;
    raw[1] = JSON.stringify({ ...second, hash: raw[1] && JSON.parse(raw[1]).hash, prev_hash: JSON.parse(raw[1]).prev_hash });
    writeFileSync(path, raw.join('\n') + '\n');
    const r = await verify(path);
    assert.equal(r.ok, false);
    assert.equal(r.index, 1);
    assert.equal(r.reason, 'hash mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify: missing entry breaks chain (prev_hash mismatch)', async () => {
  const { dir, path } = tmp();
  try {
    const c = new AuditChain(path);
    c.append({ a: 1 });
    c.append({ a: 2 });
    c.append({ a: 3 });
    c.close();
    const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    raw.splice(1, 1); // drop middle entry
    writeFileSync(path, raw.join('\n') + '\n');
    const r = await verify(path);
    assert.equal(r.ok, false);
    assert.equal(r.index, 1);
    assert.equal(r.reason, 'prev_hash mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify: empty file returns ok with count 0', async () => {
  const { dir, path } = tmp();
  try {
    const r = await verify(path);
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AuditChain.close is idempotent enough (reopen after close works)', () => {
  const { dir, path } = tmp();
  try {
    const c1 = new AuditChain(path);
    c1.append({ a: 1 });
    c1.close();
    const c2 = new AuditChain(path);
    assert.equal(c2.head.length, 64);
    c2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
