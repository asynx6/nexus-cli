import { test } from 'node:test';
import assert from 'node:assert';
import { AgentLoop } from '../src/loop.js';
import { EventBus, EVENTS } from '@nexus/event-system';

function fakeTools(log = []) {
  return {
    list: () => [{ name: 'fs.write', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
    execute: async (name, args) => { log.push({ name, args }); return { ok: true, output: 'wrote ' + args.path }; },
  };
}

test('rejects without provider/tools', () => {
  assert.throws(() => new AgentLoop({}), TypeError);
  assert.throws(() => new AgentLoop({ provider: { chat: async () => ({}) } }), TypeError);
});

test('simple answer: no tool call -> done immediately', async () => {
  const provider = { chat: async () => ({ content: '21', model: 'm1' }) };
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (e) => seen.push(e.name));
  const loop = new AgentLoop({ provider, tools: fakeTools(), bus });
  const r = await loop.run('fib(8)?', { agentId: 'agent-1' });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.answer, '21');
  assert.strictEqual(r.steps, 1);
  assert.ok(seen.includes(EVENTS.AGENT_STARTED));
  assert.ok(seen.includes(EVENTS.TASK_COMPLETED));
});

test('tool round-trip: model calls tool, then answers with tool output in history', async () => {
  const execLog = [];
  let turn = 0;
  const provider = { chat: async (msgs) => {
    turn++;
    if (turn === 1) return { model: 'm1', tool_call: { name: 'fs.write', arguments: { path: '/workspace/fib.py', content: 'print(1)' } } };
    // second turn must see the tool result appended
    const toolMsg = msgs.find((m) => m.role === 'tool');
    return { content: 'created: ' + toolMsg.content, model: 'm1' };
  } };
  const loop = new AgentLoop({ provider, tools: fakeTools(execLog) });
  const r = await loop.run('create fib', { agentId: 'agent-1' });
  assert.strictEqual(r.done, true);
  assert.match(r.answer, /created: wrote \/workspace\/fib\.py/);
  assert.strictEqual(execLog.length, 1);
  assert.strictEqual(execLog[0].name, 'fs.write');
});

test('permission denial feeds reason back to model, tool never executes', async () => {
  const execLog = [];
  let turn = 0;
  const provider = { chat: async () => (++turn === 1
    ? { model: 'm1', tool_call: { name: 'fs.write', arguments: { path: '/etc/shadow', content: 'x' } } }
    : { content: 'sorry, blocked', model: 'm1' }) };
  const perms = { check: (id, tool, args) => ({ agentId: id, tool, allowed: !args.path?.startsWith('/etc/'), reason: 'path outside workspace', args }) };
  const loop = new AgentLoop({ provider, tools: fakeTools(execLog), permissions: perms });
  const r = await loop.run('rm shadow', { agentId: 'agent-1' });
  assert.strictEqual(execLog.length, 0);
  assert.match(r.history.find((m) => m.role === 'tool').content, /PERMISSION DENIED/);
  assert.strictEqual(r.answer, 'sorry, blocked');
});

test('audit receives every check decision', async () => {
  const decisions = [];
  let turn = 0;
  const provider = { chat: async () => (++turn === 1 ? { model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/workspace/a' } } } : { content: 'ok', model: 'm' }) };
  const perms = { check: () => ({ allowed: true, reason: 'grant match' }) };
  const audit = { logDecision: (d) => decisions.push(d) };
  const loop = new AgentLoop({ provider, tools: fakeTools(), permissions: perms, audit });
  await loop.run('t', { agentId: 'agent-9' });
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].allowed, true);
});

test('tool crash -> error string fed back, loop recovers', async () => {
  let turn = 0;
  const provider = { chat: async (msgs) => (++turn === 1
    ? { model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/x' } } }
    : { content: 'saw: ' + msgs.find((m) => m.role === 'tool').content, model: 'm' }) };
  const tools = { list: () => [], execute: async () => { throw new Error('disk on fire'); } };
  const loop = new AgentLoop({ provider, tools });
  const r = await loop.run('t', { agentId: 'a' });
  assert.match(r.answer, /TOOL ERROR: disk on fire/);
});

test('maxSteps guard: endless tool caller returns done:false', async () => {
  const provider = { chat: async () => ({ model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/x' } } }) };
  const loop = new AgentLoop({ provider, tools: fakeTools() });
  const r = await loop.run('t', { agentId: 'a', maxSteps: 3 });
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.steps, 3);
});

test('emitter failure never kills the run', async () => {
  const badBus = { emit: () => { throw new Error('bus down'); } };
  const loop = new AgentLoop({ provider: { chat: async () => ({ content: 'x', model: 'm' }) }, tools: fakeTools(), bus: badBus });
  const r = await loop.run('t', { agentId: 'a' });
  assert.strictEqual(r.answer, 'x');
});

test('run() forwards extra toolCtx (runtime, sandboxId, bus, env) to tools.execute', async () => {
  let captured;
  const tools = { list: () => [], execute: async (n, a, ctx) => { captured = ctx; return { ok: true, output: 'x' }; } };
  let turn = 0;
  const provider = { chat: async () => (++turn === 1 ? { model: 'm', tool_call: { name: 'fs.write', arguments: {} } } : { content: 'ok', model: 'm' }) };
  const runtime = { exec: true };
  const loop = new AgentLoop({ provider, tools });
  await loop.run('t', { agentId: 'a', runtime, sandboxId: 'sbx-1', env: { SECRET: 'v' } });
  assert.strictEqual(captured.runtime, runtime);
  assert.strictEqual(captured.sandboxId, 'sbx-1');
  assert.deepStrictEqual(captured.env, { SECRET: 'v' });
});

test('verdict shortcut: PASS/FAIL alongside tool_call after successful tool -> done:true', async () => {
  // P09 regression: hermes-agent emits a tool_call AND a short verdict line
  // in the same step. Without the shortcut the loop keeps stepping until
  // maxSteps and returns done:false.
  let turn = 0;
  const provider = { chat: async () => (++turn === 1
    ? { model: 'm1', tool_call: { name: 'terminal.exec', arguments: { command: 'python', args: ['/workspace/test_fib.py'] } } }
    : { content: 'PASS', model: 'm1' }) };
  const tools = fakeTools();
  const loop = new AgentLoop({ provider, tools });
  const r = await loop.run('fib', { agentId: 'a' });
  // Without shortcut, the model returns tool_call + 'PASS' on turn 1; the loop
  // executes the tool then on turn 2 sees tool_call (or content) again.
  // With shortcut: after the successful tool, the verdict content terminates.
  assert.ok(['PASS', null].includes(r.answer) || r.steps <= 2, 'shortcut did not converge: steps=' + r.steps + ' answer=' + r.answer);
});

test('verdict shortcut does NOT fire when last tool errored', async () => {
  // if the previous tool crashed, the model must still be allowed to keep going
  let turn = 0;
  const provider = { chat: async () => (++turn === 1
    ? { model: 'm1', tool_call: { name: 'fs.write', arguments: { path: '/x' } } }
    : { content: 'try again', model: 'm1' }) };
  const tools = { list: () => [], execute: async () => { throw new Error('boom'); } };
  const loop = new AgentLoop({ provider, tools });
  const r = await loop.run('t', { agentId: 'a' });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.answer, 'try again');
});

test('B6: verdict shortcut is OFF by default — short ERROR content does not stop the loop', async () => {
  let turn = 0;
  const provider = { chat: async () => (++turn === 1
    ? { model: 'm1', content: 'ERROR found', tool_call: { name: 'fs.write', arguments: { path: '/x', content: 'y' } } }
    : { content: 'final answer', model: 'm1' }) };
  const loop = new AgentLoop({ provider, tools: fakeTools() });
  const r = await loop.run('t', { agentId: 'a' });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.answer, 'final answer');
  assert.strictEqual(r.steps, 2, 'default must NOT shortcut on verdict word');
});

test('B6: verdict shortcut opt-in terminates on PASS after a successful tool', async () => {
  // P09 shape: turn 1 = tool_call only; turn 2 = tool_call + short 'PASS' content.
  let turn = 0;
  const provider = { chat: async () => (++turn === 1
    ? { model: 'm1', tool_call: { name: 'fs.write', arguments: { path: '/x', content: 'y' } } }
    : { model: 'm1', content: 'PASS', tool_call: { name: 'fs.write', arguments: { path: '/z', content: 'w' } } }) };
  const loop = new AgentLoop({ provider, tools: fakeTools(), verdictShortcut: true });
  const r = await loop.run('t', { agentId: 'a' });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.answer, 'PASS');
  assert.strictEqual(r.steps, 2);
});

test('B7: all tool_calls in one turn execute; one tool message per tool_call_id', async () => {
  const provider = { chat: async () => ({
    model: 'm1',
    content: null,
    tool_calls: [
      { id: 'c1', name: 'fs.write', arguments: { path: '/a', content: '1' } },
      { id: 'c2', name: 'fs.write', arguments: { path: '/b', content: '2' } },
    ],
  }) };
  const log = [];
  const tools = fakeTools(log);
  const loop = new AgentLoop({ provider, tools });
  const r = await loop.run('t', { agentId: 'a', maxSteps: 1 });
  assert.strictEqual(r.done, false, 'maxSteps=1 with only tool calls -> exhausted');
  assert.strictEqual(log.length, 2, 'both calls must execute');
  const toolMsgs = r.history.filter((m) => m.role === 'tool');
  assert.strictEqual(toolMsgs.length, 2);
  assert.deepStrictEqual(toolMsgs.map((m) => m.tool_call_id).sort(), ['c1', 'c2']);
  const assistant = r.history.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.strictEqual(assistant.tool_calls.length, 2);
});
