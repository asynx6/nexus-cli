// B1+B2 regression: nexus run with FakeProvider executes fs tools on the host
// (cwd temp dir) and every agent event lands in the store, visible via replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNexusCli } from '../src/cli.js';
import { FakeProvider } from '@nexus/model-providers';

// buildRunCtx reads env for the provider; we inject a fake via a monkey-patched
// ctx builder is not possible — instead we drive the loop directly through the
// same wiring buildRunCtx produces, using the CLI's own run path with a
// provider override via opts. cli.js builds its own ctx, so we test the ctx
// wiring + loop here (the full CLI e2e with a fake gateway lives in
// test/e2e-fake.test.js).
import { buildRunCtx, closeCtx } from '../src/ctx.js';
import { AgentLoop } from '@nexus/agent-runtime';
import { makeEvent } from '@nexus/event-system';

test('B1+B2: FakeProvider tool call writes a real file in cwd; events stored', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-b1-'));
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const provider = new FakeProvider([
      { tool_calls: [{ id: 'c1', name: 'fs.write', arguments: { path: 'hello.txt', content: 'hi nexus\n' } }] },
      { content: 'wrote hello.txt' },
    ]);
    const ctx = await buildRunCtx({
      env: { ...process.env, NEXUS_GATEWAY_KEY: 'test-key' },
      apiKey: 'test-key',
      agentId: 'agent-b1',
      sandbox: 'host',
      storeDir: '.nexus/store',
      permissionMode: 'auto',
    });
    // swap the real provider for the fake
    const loop = new AgentLoop({
      provider, tools: ctx.tools, permissions: ctx.permissions, audit: ctx.audit, bus: ctx.bus,
    });
    const taskId = 'task-b1';
    await ctx.store.append(makeEvent('task.started', { task: 'write file', taskId }, taskId));
    const r = await loop.run('write hello.txt with content hi nexus', {
      agentId: 'agent-b1',
      sandbox: ctx.sandboxId,
      runtime: ctx.runtime,
      hostRoot: ctx.hostRoot,
      sandboxId: ctx.sandboxId,
      maxSteps: 4,
      env: ctx.env,
      system: 'test',
    });
    await ctx.store.append(makeEvent('task.ended', { taskId, ok: r.done }, taskId));
    await closeCtx(ctx);

    assert.strictEqual(r.done, true);
    assert.strictEqual(r.answer, 'wrote hello.txt');
    // the file must exist on the REAL host cwd
    assert.strictEqual(await readFile(join(cwd, 'hello.txt'), 'utf8'), 'hi nexus\n');

    // B2: replay shows agent events, not just task.started/ended
    const { EventStore } = await import('@nexus/event-system');
    const store = new EventStore(join(cwd, '.nexus/store/events.jsonl'));
    const names = [];
    for await (const e of store.replay({})) names.push(e.name);
    store.close();
    assert.ok(names.includes('agent.step'), 'agent.step missing: ' + names.join(','));
    assert.ok(names.includes('agent.tool_called'), 'agent.tool_called missing');
    assert.ok(names.includes('agent.tool_finished'), 'agent.tool_finished missing');
    assert.ok(names.includes('file.created') || names.includes('file.modified'), 'file event missing');
  } finally {
    process.chdir(prev);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('B1: fs.read reads a real file from cwd via the tool funnel', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-b1r-'));
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    await mkdir('.nexus', { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile('data.txt', 'payload-42');
    const provider = new FakeProvider([
      { tool_calls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'data.txt' } }] },
      { content: 'read it' },
    ]);
    const ctx = await buildRunCtx({
      env: { ...process.env, NEXUS_GATEWAY_KEY: 'test-key' },
      apiKey: 'test-key',
      agentId: 'agent-b1r',
      sandbox: 'host',
      storeDir: '.nexus/store',
      permissionMode: 'auto',
    });
    const loop = new AgentLoop({
      provider, tools: ctx.tools, permissions: ctx.permissions, audit: ctx.audit, bus: ctx.bus,
    });
    const r = await loop.run('read data.txt', {
      agentId: 'agent-b1r',
      sandbox: ctx.sandboxId, runtime: ctx.runtime, hostRoot: ctx.hostRoot, sandboxId: ctx.sandboxId,
      maxSteps: 4, env: ctx.env, system: 'test',
    });
    await closeCtx(ctx);
    assert.strictEqual(r.done, true);
    // the tool output must have reached the model history
    const toolMsg = r.history.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool message missing');
    assert.match(toolMsg.content, /payload-42/);
  } finally {
    process.chdir(prev);
    await rm(cwd, { recursive: true, force: true });
  }
});
