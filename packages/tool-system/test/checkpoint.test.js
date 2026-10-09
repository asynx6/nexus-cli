// Checkpoint + rewind round-trip (Fase 6a)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRuntime } from '@nexus/sandbox-runtime';
import { Checkpointer } from '../src/checkpoint.js';

function makeCtx(root) {
  return { runtime: new HostRuntime({ root }), sandboxId: 't', hostRoot: root, agentId: 'a1' };
}

test('checkpoint before write; restore rolls content back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-cp-'));
  const cpRoot = mkdtempSync(join(tmpdir(), 'nx-cpstore-'));
  try {
    const ctx = makeCtx(root);
    await ctx.runtime.copyIn(ctx.sandboxId, [{ path: 'a.txt', content: 'v1' }]);
    const cp = new Checkpointer({ root: cpRoot, sessionId: 's1' });
    // checkpoint #1: before overwriting a.txt with v2
    const c1 = await cp.beforeTool({ tool: 'fs.write', args: { path: 'a.txt', content: 'v2' }, ctx });
    assert.equal(c1.checkpoint, 1);
    await ctx.runtime.copyIn(ctx.sandboxId, [{ path: 'a.txt', content: 'v2' }]);
    // checkpoint #2: before creating b.txt
    const c2 = await cp.beforeTool({ tool: 'fs.write', args: { path: 'b.txt', content: 'new' }, ctx });
    assert.equal(c2.checkpoint, 2);
    await ctx.runtime.copyIn(ctx.sandboxId, [{ path: 'b.txt', content: 'new' }]);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v2');
    assert.ok(existsSync(join(root, 'b.txt')));

    // restore to checkpoint 2: state before b.txt existed. a.txt's newest
    // snapshot <= cp2 is cp1 (v1) — the v2 write happened after cp1 and was
    // never snapshotted again, so a.txt rolls back to v1.
    const restored = await cp.restore(2, ctx);
    assert.ok(restored.some((r) => r.includes('b.txt')));
    assert.ok(!existsSync(join(root, 'b.txt')), 'created-after-checkpoint file removed');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v1');

    // restore to checkpoint 1: same file state for a.txt
    const r2 = await cp.restore(1, ctx);
    assert.ok(r2.includes('a.txt'));
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v1');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cpRoot, { recursive: true, force: true });
  }
});

test('non-mutating tools are not checkpointed; list() order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-cp-'));
  const cpRoot = mkdtempSync(join(tmpdir(), 'nx-cpstore-'));
  try {
    const ctx = makeCtx(root);
    const cp = new Checkpointer({ root: cpRoot, sessionId: 's2' });
    assert.equal(await cp.beforeTool({ tool: 'fs.read', args: { path: 'x' }, ctx }), null);
    assert.equal(await cp.beforeTool({ tool: 'terminal.exec', args: { command: 'ls' }, ctx }), null);
    await cp.beforeTool({ tool: 'fs.edit', args: { path: 'n.txt', old_text: 'a', new_text: 'b' }, ctx });
    const list = cp.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].tool, 'fs.edit');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cpRoot, { recursive: true, force: true });
  }
});

test('session isolation: separate dirs, seq continues across restart', async () => {
  const cpRoot = mkdtempSync(join(tmpdir(), 'nx-cpstore-'));
  try {
    const root = mkdtempSync(join(tmpdir(), 'nx-cp-'));
    const ctx = makeCtx(root);
    const cp1 = new Checkpointer({ root: cpRoot, sessionId: 'sA' });
    await cp1.beforeTool({ tool: 'fs.write', args: { path: 'x', content: '1' }, ctx });
    const cp2 = new Checkpointer({ root: cpRoot, sessionId: 'sA' }); // "restart"
    const c = await cp2.beforeTool({ tool: 'fs.write', args: { path: 'y', content: '2' }, ctx });
    assert.equal(c.checkpoint, 2, 'seq continues from disk');
    const other = new Checkpointer({ root: cpRoot, sessionId: 'sB' });
    const c3 = await other.beforeTool({ tool: 'fs.write', args: { path: 'z', content: '3' }, ctx });
    assert.equal(c3.checkpoint, 1, 'other session starts fresh');
  } finally { rmSync(cpRoot, { recursive: true, force: true }); }
});
