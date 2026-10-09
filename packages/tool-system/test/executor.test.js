// Unit tests: executor gate order + event emission (fake runtime, real bus,
// real PermissionManager + AuditTrail via security facade is not a dep of
// this package, so a stub permission object matching its contract is used).
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolRegistry, ToolExecutor } from '../index.js';
import { EventBus } from '@asynx6/nexus-event-system';
import { PermissionManager } from '@asynx6/nexus-security';

function perms() {
  const pm = new PermissionManager();
  pm.grant('agent-aaa', 'tool.echo', {});
  pm.grant('agent-aaa', 'tool.slow', {});
  pm.grant('agent-aaa', 'tool.boom', {});
  return pm;
}
function registry() {
  const r = new ToolRegistry();
  r.register({ name: 'tool.echo', description: 'echo back', schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    handler: async (a) => ({ msg: a.msg }) });
  r.register({ name: 'tool.slow', description: 'sleeps', timeoutMs: 50, schema: { type: 'object' },
    handler: () => new Promise((res) => setTimeout(() => res({ done: true }), 500)) });
  r.register({ name: 'tool.boom', description: 'throws', schema: { type: 'object' },
    handler: () => { throw new Error('kaput'); } });
  return r;
}

test('unknown tool -> result with reason, no throw', async () => {
  const ex = new ToolExecutor({ registry: registry(), permissions: perms() });
  const out = await ex.execute({ tool: 'tool.nope', args: {} }, { agentId: 'agent-aaa' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'validation');
  assert.match(out.reason, /unknown tool/);
});

test('schema failure precedes permission check', async () => {
  let checked = false;
  const pm = { check: () => { checked = true; return { allowed: true }; } };
  const ex = new ToolExecutor({ registry: registry(), permissions: pm });
  const out = await ex.execute({ tool: 'tool.echo', args: {} }, { agentId: 'agent-aaa' });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /args.msg: required/);
  assert.strictEqual(checked, false, 'permission must not be consulted for invalid args');
});

test('no grant -> denied with machine-readable reason', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (e) => seen.push(e));
  const ex = new ToolExecutor({ registry: registry(), permissions: perms() });
  const out = await ex.execute({ tool: 'tool.echo', args: { msg: 'hi' } }, { agentId: 'agent-zzz', bus });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'denied');
  assert.match(out.reason, /deny-by-default/);
  const names = seen.map((e) => e.name);
  assert.ok(names.includes('permission.decision'));
  assert.ok(!names.includes('agent.tool_called'), 'denied call must not report tool_called');
  const fin = seen.find((e) => e.name === 'agent.tool_finished');
  assert.strictEqual(fin.data.reason, out.reason, 'event carries the denial reason');
});

test('granted call: events in order, result returned', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (e) => seen.push(e));
  const ex = new ToolExecutor({ registry: registry(), permissions: perms() });
  const out = await ex.execute({ tool: 'tool.echo', args: { msg: 'yo' } }, { agentId: 'agent-aaa', bus });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.result, { msg: 'yo' });
  const names = seen.map((e) => e.name);
  assert.ok(names.indexOf('agent.tool_called') < names.indexOf('agent.tool_finished'));
});

test('handler timeout enforced', async () => {
  const ex = new ToolExecutor({ registry: registry(), permissions: perms() });
  const t0 = Date.now();
  const out = await ex.execute({ tool: 'tool.slow', args: {} }, { agentId: 'agent-aaa' });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /timed out/);
  assert.ok(Date.now() - t0 < 400);
});

test('handler error -> result with reason', async () => {
  const ex = new ToolExecutor({ registry: registry(), permissions: perms() });
  const out = await ex.execute({ tool: 'tool.boom', args: {} }, { agentId: 'agent-aaa' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'handler');
  assert.match(out.reason, /kaput/);
});
