import { test } from 'node:test';
import assert from 'node:assert';
import {
  NAME, MemoryKind, isMemoryRecord, makeMemory,
  MemoryManager, MemoryStorage, JsonlStorage,
} from '../index.js';

test('memory skeleton loads', () => {
  assert.strictEqual(NAME, '@asynx6/nexus-memory');
});

test('makeMemory builds valid records and rejects bad input', () => {
  const rec = makeMemory('long', 'fact:db', { engine: 'sqlite' });
  assert.ok(isMemoryRecord(rec));
  assert.strictEqual(rec.kind, 'long');
  assert.strictEqual(rec.subject, null);
  assert.throws(() => makeMemory('bogus', 'k', 1), TypeError);
  assert.throws(() => makeMemory('long', '', 1), TypeError);
});

test('MemoryManager stores and recalls by kind/key via in-memory storage', async () => {
  const mgr = new MemoryManager({ storage: new MemoryStorage() });
  await mgr.init();
  const events = [];
  const mgr2 = new MemoryManager({
    storage: mgr === null ? new MemoryStorage() : new MemoryStorage(),
    emit: (e) => events.push(e),
  });
  await mgr2.init();

  await mgr2.rememberShort('conversation:current', { turns: 3 });
  await mgr2.rememberLong('fact:db', { engine: 'sqlite' });
  await mgr2.rememberProject('info:stack', ['node', 'sqlite'], { subject: 'nexus' });

  const all = await mgr2.recall();
  assert.strictEqual(all.length, 3);
  const longs = await mgr2.recall({ kind: MemoryKind.LONG });
  assert.strictEqual(longs.length, 1);
  assert.strictEqual(longs[0].key, 'fact:db');

  const one = await mgr2.recallOne(MemoryKind.PROJECT, 'info:stack');
  assert.deepStrictEqual(one.value, ['node', 'sqlite']);

  const hit = events.find((e) => e.name === 'memory.created');
  assert.ok(hit, 'memory.created emitted');
  await mgr2.close();
});

test('JsonlStorage persists across instances and filters lists', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'nexus-mem-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.jsonl');

  const a = new MemoryManager({ storage: new JsonlStorage(path) });
  await a.init();
  const rec = await a.rememberLong('decision:auth', { mode: 'token' });
  await a.rememberShort('conversation:current', { turns: 1 });
  await a.close();

  const b = new MemoryManager({ storage: new JsonlStorage(path) });
  await b.init();
  assert.deepStrictEqual((await b.get(rec.id)).value, { mode: 'token' });
  const longs = await b.recall({ kind: MemoryKind.LONG });
  assert.strictEqual(longs.length, 1);

  const upd = await b.update(rec.id, { mode: 'oauth' });
  assert.deepStrictEqual(upd.value, { mode: 'oauth' });
  assert.deepStrictEqual((await b.recallOne(MemoryKind.LONG, 'decision:auth')).value, { mode: 'oauth' });

  await b.forget(rec.id);
  assert.strictEqual(await b.get(rec.id), null);
  await b.close();
});
