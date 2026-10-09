import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { makeEvent } from '../src/events.js';
import { EVENTS, newTaskId } from '@asynx6/nexus-shared';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ev-'));
  const path = join(dir, 'events.jsonl');
  return { dir, path, store: new EventStore(path) };
}

test('append assigns gapless seq in write order', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.append(makeEvent(EVENTS.AGENT_STARTED, {}, 'agent-run1', { ts: '2026-01-01T00:00:01.000Z' }));
    const b = store.append(makeEvent(EVENTS.TASK_CREATED, { title: 'fib' }, 'task-1', { ts: '2026-01-01T00:00:02.000Z' }));
    assert.strictEqual(a.seq, 0);
    assert.strictEqual(b.seq, 1);
    assert.strictEqual(store.count(), 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('write-drain-replay is deterministic across reopen', () => {
  const { dir, path, store } = tempStore();
  const written = [];
  try {
    for (let i = 0; i < 50; i++) {
      const ev = makeEvent(EVENTS.AGENT_TOOL_CALLED, { i }, i % 2 === 0 ? 'agent-runA' : 'agent-runB');
      written.push(store.append(ev));
    }
  } finally { store.close(); }

  // reopen from disk (fresh index read from the existing DB)
  const store2 = new EventStore(path);
  try {
    const replayed = [...store2.replay()];
    assert.strictEqual(replayed.length, 50);
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(replayed[i].seq, written[i].seq);
      assert.strictEqual(replayed[i].id, written[i].id);
      assert.strictEqual(replayed[i].subject, written[i].subject);
      assert.deepStrictEqual(replayed[i].data, written[i].data);
    }
    // per-run ordering preserved
    const runA = [...store2.replay({ subject: 'agent-runA' })];
    assert.strictEqual(runA.length, 25);
    assert.ok(runA.every((e, idx, arr) => idx === 0 || e.seq > arr[idx - 1].seq));
    // type filter and since cursor
    assert.strictEqual([...store2.replay({ name: EVENTS.TASK_CREATED })].length, 0);
    assert.strictEqual([...store2.replay({ since: 48 })].length, 2);
    assert.strictEqual([...store2.replay({ limit: 5 })].length, 5);
  } finally { store2.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rebuildIndex reproduces identical replay from JSONL alone', () => {
  const { dir, path, store } = tempStore();
  try {
    for (let i = 0; i < 20; i++) store.append(makeEvent(EVENTS.FILE_MODIFIED, { i }, 'file-r'));
    const before = [...store.replay()].map((e) => e.id);
    store.close(); // Windows: sqlite keeps .idx locked until closed
    rmSync(path + '.idx', { force: true });
    rmSync(path + '.idx-wal', { force: true });
    rmSync(path + '.idx-shm', { force: true });
    const reopened = new EventStore(path); // fresh DB, empty index
    reopened.rebuildIndex();
    const after = [...reopened.replay()].map((e) => e.id);
    assert.deepStrictEqual(after, before);
    assert.strictEqual(reopened.count(), 20);
    // next append continues seq after rebuild
    const next = reopened.append(makeEvent(EVENTS.FILE_CREATED, {}, 'file-r'));
    assert.strictEqual(next.seq, 20);
    reopened.close();
  } finally { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test('index auto-recovers lines appended without indexing (simulated crash)', () => {
  const { dir, path, store } = tempStore();
  try {
    const e0 = store.append(makeEvent(EVENTS.AGENT_CREATED, {}, 'agent-r'));
    const e1 = makeEvent(EVENTS.AGENT_STARTED, {}, 'agent-r', { id: 'ghost' });
    const rec = { seq: 1, ...e1 };
    appendFileSync(path, JSON.stringify(rec) + '\n'); // on disk, NOT in index
    store.close();
    const store2 = new EventStore(path);
    assert.strictEqual(store2.count(), 2);
    assert.deepStrictEqual([...store2.replay()].map((e) => e.id), [e0.id, 'ghost']);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects malformed events', () => {
  const { dir, store } = tempStore();
  try {
    assert.throws(() => store.append({ id: 'evt-aaaa1111', name: 'x.y' }), TypeError);
    assert.throws(() => makeEvent(''), TypeError);
    assert.throws(() => makeEvent('not-a-name'), TypeError);
    assert.doesNotThrow(() => makeEvent('custom.kind_ok')); // custom dot names allowed
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('1000 write-drain-replay events under 200ms', () => {
  const { dir, store } = tempStore();
  try {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      store.append(makeEvent(EVENTS.AGENT_TOOL_FINISHED, { i, out: 'x'.repeat(32) }, 'agent-perf'));
    }
    const events = [...store.replay()];
    const t1 = performance.now();
    assert.strictEqual(events.length, 1000);
    assert.strictEqual(events[999].data.i, 999);
    assert.ok(t1 - t0 < 200, `write+drain took ${t1 - t0}ms (budget 200ms)`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
