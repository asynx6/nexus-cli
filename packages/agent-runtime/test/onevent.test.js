// Fase 3: AgentLoop onEvent — UI hook without changing run() contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/loop.js';

function fakeTools() {
  return { list: () => [], execute: async () => ({ ok: true, output: 'ok' }) };
}

test('onEvent receives text_delta per chunk when provider streams', async () => {
  const provider = {
    chat: async () => { throw new Error('chat should not be called'); },
    async *stream() {
      yield { type: 'text', delta: 'Hel' };
      yield { type: 'text', delta: 'lo' };
      yield { type: 'usage', usage: { total_tokens: 3 } };
      yield { type: 'done', result: { model: 'm', content: 'Hello', tool_calls: [], usage: { total_tokens: 3 } } };
    },
  };
  const events = [];
  const loop = new AgentLoop({ provider, tools: fakeTools() });
  const r = await loop.run('task', { agentId: 'a', onEvent: (e) => events.push(e) });
  assert.equal(r.done, true);
  assert.equal(r.answer, 'Hello');
  const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.delta);
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.ok(events.some((e) => e.type === 'usage'));
});

test('onEvent absent or provider without stream -> plain chat() path', async () => {
  const provider = { chat: async () => ({ model: 'm', content: 'plain', tool_calls: [] }) };
  const loop = new AgentLoop({ provider, tools: fakeTools() });
  const r = await loop.run('task', { agentId: 'a', onEvent: () => {} });
  assert.equal(r.answer, 'plain');
  // no onEvent at all
  const r2 = await loop.run('task', { agentId: 'a' });
  assert.equal(r2.answer, 'plain');
});

test('onEvent receives tool_call_delta fragments', async () => {
  const provider = {
    chat: async () => { throw new Error('chat should not be called'); },
    async *stream() {
      yield { type: 'tool_call_delta', index: 0, name: 'fs_write', argsFragment: '{"pa' };
      yield { type: 'tool_call_delta', index: 0, name: 'fs_write', argsFragment: 'th":"x"}' };
      yield { type: 'done', result: { model: 'm', content: null, tool_calls: [{ id: 'c1', name: 'fs_write', arguments: { path: 'x' } }], usage: null } };
    },
  };
  const events = [];
  const loop = new AgentLoop({ provider, tools: {
    list: () => [],
    execute: async (name, args) => ({ ok: true, output: 'wrote ' + name }),
  } });
  // second turn: final answer
  provider.stream = async function* (messages) {
    if (messages.some((m) => m.role === 'tool')) {
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', result: { model: 'm', content: 'done', tool_calls: [], usage: null } };
    } else {
      yield { type: 'tool_call_delta', index: 0, name: 'fs_write', argsFragment: '{"path":"x"}' };
      yield { type: 'done', result: { model: 'm', content: null, tool_calls: [{ id: 'c1', name: 'fs_write', arguments: { path: 'x' } }], usage: null } };
    }
  };
  const r = await loop.run('task', { agentId: 'a', onEvent: (e) => events.push(e) });
  assert.equal(r.done, true);
  assert.equal(r.answer, 'done');
  const frags = events.filter((e) => e.type === 'tool_call_delta');
  assert.equal(frags.length, 1);
  assert.equal(frags[0].name, 'fs_write');
});

test('onEvent errors never kill the loop', async () => {
  const provider = {
    chat: async () => { throw new Error('no'); },
    async *stream() {
      yield { type: 'text', delta: 'x' };
      yield { type: 'done', result: { model: 'm', content: 'x', tool_calls: [], usage: null } };
    },
  };
  const loop = new AgentLoop({ provider, tools: fakeTools() });
  const r = await loop.run('task', { agentId: 'a', onEvent: () => { throw new Error('UI bug'); } });
  assert.equal(r.answer, 'x');
});
