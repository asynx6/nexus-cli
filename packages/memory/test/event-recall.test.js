// EventRecall tests — round-trip, filter, idempotency, hydrate.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@asynx6/nexus-event-system';
import { EventRecall, openEventRecall } from '../src/event-recall.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-recall-'));
  return { dir, path: join(dir, 'events.jsonl') };
}

function env(id, name, subject, ts, data = {}) {
  return { id, name, subject, ts: typeof ts === 'string' ? ts : new Date(ts).toISOString(), data };
}

test('EventRecall: index + recall round-trip', () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const recall = openEventRecall(store, dir);
  recall.index(env('a1', 'task.started', 'task-A', 1000));
  recall.index(env('a2', 'tool.executed', 'task-A', 1500));
  recall.index(env('a3', 'task.ended', 'task-A', 2000));
  const rows = recall.recall({ subject: 'task-A', limit: 10 });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].id, 'a3');
  assert.strictEqual(rows[2].id, 'a1');
  recall.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

test('EventRecall: filtered by name + ts range', () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const recall = openEventRecall(store, dir);
  for (let i = 0; i < 10; i++) recall.index(env(`e${i}`, 'tool.executed', 's', 1000 + i * 100));
  recall.index(env('x', 'task.started', 's', 1500));
  assert.strictEqual(recall.count({ name: 'tool.executed' }), 10);
  assert.strictEqual(recall.count({ name: 'task.started' }), 1);
  const since = recall.recall({ name: 'tool.executed', sinceTs: 1500 });
  assert.ok(since.every((r) => r.ts >= 1500));
  recall.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

test('EventRecall: idempotent index', () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const recall = openEventRecall(store, dir);
  const e = env('dup', 'task.started', 's', 100);
  assert.strictEqual(recall.index(e), true);
  assert.strictEqual(recall.index(e), false);
  assert.strictEqual(recall.count(), 1);
  recall.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

test('EventRecall: rebuild walks EventStore', async () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  await store.append(env('r1', 'task.started', 'X', 100, { k: 1 }));
  await store.append(env('r2', 'tool.executed', 'Y', 200, { k: 2 }));
  await store.append(env('r3', 'task.ended', 'X', 300, { k: 3 }));
  const recall = openEventRecall(store, dir);
  const n = await recall.rebuild();
  assert.strictEqual(n, 3);
  assert.strictEqual(recall.count({ subject: 'X' }), 2);
  assert.strictEqual(recall.count({ subject: 'Y' }), 1);
  recall.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
});

test('EventRecall: recallHydrated returns envelopes DESC by ts', async () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const recall = openEventRecall(store, dir);
  await store.append(env('h1', 'tool.executed', 'T', 100, { payload: 1 }));
  await store.append(env('h2', 'tool.executed', 'T', 200, { payload: 2 }));
  await recall.rebuild();
  const out = [];
  for await (const e of recall.recallHydrated({ subject: 'T' })) out.push(e);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].data.payload, 2);
  assert.strictEqual(out[1].data.payload, 1);
  recall.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
});

test('EventRecall + MemoryManager co-exist (separate concerns)', async () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const recall = openEventRecall(store, dir);
  const { MemoryManager, MemoryStorage } = await import('../index.js');
  const mgr = new MemoryManager({ storage: new MemoryStorage() });
  await mgr.init();
  await mgr.rememberLong('fact:db', { engine: 'sqlite' });
  recall.index(env('ev1', 'task.started', 'agent-1', Date.now()));
  assert.strictEqual(recall.count(), 1);
  await mgr.close();
  recall.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});
