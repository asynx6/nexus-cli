import { test } from 'node:test';
import assert from 'node:assert';
import { loopTools } from '../src/bridge.js';
import { AgentLoop } from '../src/loop.js';
import { ToolRegistry, ToolExecutor } from '@asynx6/nexus-tool-system';
import { PermissionManager, AuditTrail } from '@asynx6/nexus-security';
import { EventBus } from '@asynx6/nexus-event-system';

function setup({ allowed = true } = {}) {
  const reg = new ToolRegistry();
  reg.register({
    name: 'fs.write', description: 'write file',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async (args) => ({ stdout: 'wrote ' + args.path }),
  });
  const bus = new EventBus();
  const pm = new PermissionManager();
  if (allowed) pm.grant('agent-1', 'fs.write', {});
  const audit = new AuditTrail({ bus, runId: 'agent-1' });
  const ex = new ToolExecutor({ registry: reg, permissions: pm, audit });
  return { tools: loopTools({ registry: reg, executor: ex }), bus, pm, audit };
}

test('bridge exposes provider-shaped list()', () => {
  const { tools } = setup();
  const l = tools.list();
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual(Object.keys(l[0]).sort(), ['description', 'name', 'parameters']);
});

test('bridge executes through the full funnel: ok + stringified output', async () => {
  const { tools, bus } = setup();
  const seen = [];
  bus.on('*', (e) => seen.push(e.name));
  const r = await tools.execute('fs.write', { path: '/workspace/a.py' }, { agentId: 'agent-1', bus });
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /wrote \/workspace\/a\.py/);
  assert.ok(seen.includes('agent.tool_called'), 'executor emitted the event');
});

test('denied by permissions -> PERMISSION DENIED result, not throw', async () => {
  const { tools } = setup({ allowed: false });
  const r = await tools.execute('fs.write', { path: '/x' }, { agentId: 'agent-9', bus: new EventBus() });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /^PERMISSION DENIED/);
});

test('invalid args -> INVALID CALL result', async () => {
  const { tools } = setup();
  const r = await tools.execute('fs.write', {}, { agentId: 'agent-1', bus: new EventBus() });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /^INVALID CALL/);
});

test('end-to-end: loop + bridge (loop itself has NO permission gate)', async () => {
  const { tools, bus } = setup();
  let turn = 0;
  const provider = { chat: async (msgs) => (++turn === 1
    ? { model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/workspace/f.py' } } }
    : { content: 'done: ' + msgs.find((x) => x.role === 'tool').content, model: 'm' }) };
  const loop = new AgentLoop({ provider, tools, bus });
  const r = await loop.run('write f', { agentId: 'agent-1' });
  assert.strictEqual(r.done, true);
  assert.match(r.answer, /done: .*wrote \/workspace\/f\.py/);
});

test('end-to-end denial flows back to model', async () => {
  const { tools } = setup({ allowed: false });
  let turn = 0;
  const provider = { chat: async (msgs) => (++turn === 1
    ? { model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/x' } } }
    : { content: 'blocked because: ' + msgs.find((x) => x.role === 'tool').content, model: 'm' }) };
  const loop = new AgentLoop({ provider, tools });
  const r = await loop.run('write x', { agentId: 'agent-9' });
  assert.match(r.answer, /PERMISSION DENIED/);
});
