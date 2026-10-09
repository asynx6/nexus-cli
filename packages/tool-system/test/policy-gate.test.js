// Permission-mode gate on ToolExecutor: hard denylist > rules > mode > ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutor } from '../src/executor.js';
import { ToolRegistry } from '../src/registry.js';

function makeRegistry() {
  const reg = new ToolRegistry();
  reg.register({
    name: 'fs.read',
    permission: 'fs.read', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, description: 'read',
    handler: async (args) => ({ content: 'file:' + args.path }),
  });
  reg.register({
    name: 'fs.write',
    permission: 'fs.write', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] }, description: 'write',
    handler: async (args) => ({ written: args.path }),
  });
  reg.register({
    name: 'terminal.exec',
    permission: 'terminal.exec', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, description: 'exec',
    handler: async (args) => ({ stdout: 'ran: ' + args.command }),
  });
  return reg;
}

const RMRF = 'rm -rf /tmp/build ' + 'x'; // starts with rm -rf but not root — allowed form

// web.fetch + shell stricter gates (Fase 4)
function webRegistry() {
  const reg = new ToolRegistry();
  reg.register({
    name: 'web.fetch', permission: 'web.fetch',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, description: 'fetch',
    handler: async (args) => ({ url: args.url }),
  });
  reg.register({
    name: 'terminal.exec', permission: 'terminal.exec',
    schema: { type: 'object', properties: { command: { type: 'string' }, shell: { type: 'boolean' } }, required: ['command'] }, description: 'exec',
    handler: async (args) => ({ stdout: 'ran' }),
  });
  return reg;
}

async function runWeb(policy, call, asks = []) {
  const ex = new ToolExecutor({
    registry: webRegistry(), policy,
    onAskFn: null,
  });
  return ex.execute(call, { agentId: 'a1' });
}

async function run(policy, call) {
  const ex = new ToolExecutor({ registry: makeRegistry(), policy });
  return ex.execute(call, { agentId: 'a1' });
}

test('auto mode allows everything except hard denylist', async () => {
  assert.equal((await run({ mode: 'auto' }, { tool: 'fs.write', args: { path: 'x.txt', content: 'a' } })).ok, true);
  assert.equal((await run({ mode: 'auto' }, { tool: 'terminal.exec', args: { command: 'npm test' } })).ok, true);
  // hard deny still blocks even in auto
  const denied = await run({ mode: 'auto' }, { tool: 'terminal.exec', args: { command: 'echo hi; rm -rf /' } });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /hard deny/);
});

test('plan mode: reads pass, writes and exec denied', async () => {
  assert.equal((await run({ mode: 'plan' }, { tool: 'fs.read', args: { path: 'x' } })).ok, true);
  const w = await run({ mode: 'plan' }, { tool: 'fs.write', args: { path: 'x', content: 'a' } });
  assert.equal(w.ok, false);
  assert.match(w.reason, /plan mode/);
  const e = await run({ mode: 'plan' }, { tool: 'terminal.exec', args: { command: 'npm test' } });
  assert.equal(e.ok, false);
  assert.match(e.reason, /plan mode/);
});

test('ask mode: reads pass, writes prompt', async () => {
  assert.equal((await run({ mode: 'ask' }, { tool: 'fs.read', args: { path: 'x' } })).ok, true);
  const asked = [];
  const ok = await run({ mode: 'ask', onAsk: async (c) => { asked.push(c.tool); return true; } }, { tool: 'fs.write', args: { path: 'x', content: 'a' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(asked, ['fs.write']);
  // user denies
  const denied = await run({ mode: 'ask', onAsk: async () => false }, { tool: 'fs.write', args: { path: 'x', content: 'a' } });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /user denied/);
});

test('ask mode without prompt callback denies with clear reason', async () => {
  const r = await run({ mode: 'ask' }, { tool: 'fs.write', args: { path: 'x', content: 'a' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /permission required/);
});

test('accept-edits: fs.write auto-approved, terminal.exec still asks', async () => {
  assert.equal((await run({ mode: 'accept-edits' }, { tool: 'fs.write', args: { path: 'x', content: 'a' } })).ok, true);
  assert.equal((await run({ mode: 'accept-edits' }, { tool: 'fs.read', args: { path: 'x' } })).ok, true);
  const asked = [];
  const ok = await run({ mode: 'accept-edits', onAsk: async (c) => { asked.push(c.tool); return true; } }, { tool: 'terminal.exec', args: { command: RMRF } });
  assert.equal(ok.ok, true);
  assert.deepEqual(asked, ['terminal.exec']);
});

test('persistent rules beat mode: deny rule blocks even in auto', async () => {
  const settings = { permissions: { allow: [], deny: ['terminal.exec:npm*'], defaultMode: 'ask' } };
  const r = await run({ mode: 'auto', settings }, { tool: 'terminal.exec', args: { command: 'npm publish' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /denied by rule/);
});

test('persistent allow rule skips prompt in ask mode', async () => {
  const settings = { permissions: { allow: ['terminal.exec:npm test'], deny: [] } };
  const asked = [];
  const r = await run({ mode: 'ask', settings, onAsk: async (c) => { asked.push(c.tool); return true; } }, { tool: 'terminal.exec', args: { command: 'npm test' } });
  assert.equal(r.ok, true);
  assert.deepEqual(asked, []); // never asked
});

test('hard denylist beats allow rule', async () => {
  const settings = { permissions: { allow: ['terminal.exec'], deny: [] } };
  const r = await run({ mode: 'auto', settings }, { tool: 'terminal.exec', args: { command: 'dd if=/dev/zero of=/dev/sda' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hard deny/);
});

test('hard deny path beats auto mode', async () => {
  const r = await run({ mode: 'auto' }, { tool: 'fs.write', args: { path: '/etc/passwd', content: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hard deny/);
});

test('web.fetch always asks, even in auto mode; persistent allow rule bypasses', async () => {
  // auto mode without prompt -> still denied for web.fetch (always ask)
  const denied = await runWeb({ mode: 'auto' }, { tool: 'web.fetch', args: { url: 'https://x.example/' } });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /permission required|ask/);
  // with onAsk -> prompted
  let asked = 0;
  const ex = new ToolExecutor({
    registry: webRegistry(),
    policy: { mode: 'auto', onAsk: async () => { asked++; return true; } },
  });
  const ok = await ex.execute({ tool: 'web.fetch', args: { url: 'https://x.example/' } }, { agentId: 'a1' });
  assert.equal(ok.ok, true);
  assert.equal(asked, 1);
  // persistent allow rule for the domain skips the ask
  const ex2 = new ToolExecutor({
    registry: webRegistry(),
    policy: { mode: 'auto', settings: { permissions: { allow: ['web.fetch:x.example'], deny: [] } }, onAsk: async () => { asked++; return false; } },
  });
  const ok2 = await ex2.execute({ tool: 'web.fetch', args: { url: 'https://x.example/' } }, { agentId: 'a1' });
  assert.equal(ok2.ok, true);
  assert.equal(asked, 1); // not prompted again
});

test('shell:true exec asks in ask/accept-edits modes, auto passes', async () => {
  for (const mode of ['ask', 'accept-edits']) {
    let asked = 0;
    const ex = new ToolExecutor({
      registry: webRegistry(),
      policy: { mode, onAsk: async () => { asked++; return true; } },
    });
    const r = await ex.execute({ tool: 'terminal.exec', args: { command: 'echo hi', shell: true } }, { agentId: 'a1' });
    assert.equal(r.ok, true);
    assert.equal(asked, 1, `shell exec must ask in ${mode}`);
  }
  const ex = new ToolExecutor({ registry: webRegistry(), policy: { mode: 'auto' } });
  const r = await ex.execute({ tool: 'terminal.exec', args: { command: 'echo hi', shell: true } }, { agentId: 'a1' });
  assert.equal(r.ok, true);
});
