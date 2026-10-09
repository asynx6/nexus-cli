// Integration: MemoryManager + EventStore + EventRecall work together.
// Use case: agent writes memory → emit event 'memory.created' to bus →
// EventStore appends envelope → EventRecall surfaces it via sqlite index.
// Verifies the three layers cooperate without duplicate state.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, EventStore, makeEvent } from '@asynx6/nexus-event-system';
import { MemoryManager, JsonlStorage, EventRecall, openEventRecall } from '@asynx6/nexus-memory';

test('memory + event-system integration: remember → emit → recall', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-int-'));
  try {
    const bus = new EventBus();
    const store = new EventStore(dir + '/events.jsonl');
    const recall = await openEventRecall(store, dir);

    // Wire MemoryManager: emit → bus → store → recall (sqlite)
    const storage = new JsonlStorage(dir + '/memory.jsonl');
    const mem = new MemoryManager({
      storage,
      emit: (evt) => bus.emit(makeEvent(evt.name, evt.data, evt.data.subject ?? null)),
    });

    await storage.init();
    await mem.init();

    // bus listener also stores (simulate the runtime wiring in ctx.js)
    bus.on('memory.created', (env) => { store.append(env); });

    // remember: triggers emit hook → bus → store
    const r1 = await mem.rememberShort('user.name', 'Asynx6', { subject: 'user.profile' });
    const r2 = await mem.rememberLong('agent.style', 'concise', { subject: 'agent.config' });

    // give listeners a chance to flush
    await new Promise((r) => setTimeout(r, 50));

    // re-index from store into recall (in real wiring, store appends hook recall.index)
    const allEnvs = [...store.replay({})];
    recall.indexBatch(allEnvs);
    const recent = await recall.recall({ subject: 'user.profile', limit: 5 });
    assert.strictEqual(recent.length >= 1, true, 'memory.created event should appear');
    assert.strictEqual(recent[0].name, 'memory.created');

    // recall via MemoryManager (k-v)
    const user = await mem.recallOne('short', 'user.name');
    assert.strictEqual(user.value, 'Asynx6');

    const style = await mem.recallOne('long', 'agent.style');
    assert.strictEqual(style.value, 'concise');

    // close cleanly (avoid EBUSY on Windows teardown)
    await mem.close();
    await store.close();
    await recall.close();
  } finally {
    // Windows: sqlite may keep file handles briefly after close(); best-effort cleanup.
    // Temp dir cleanup is non-essential for test correctness — don't fail test on Windows EBUSY/EPERM.
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { /* Windows file-handle race; OS will clean temp */ }
  }
});
