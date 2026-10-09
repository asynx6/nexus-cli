// C2 abort: AbortController membatalkan provider call yang sedang berjalan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/loop.js';

function fakeRegistry() {
  return {
    list: () => [],
    execute: async () => ({ ok: true }),
  };
}

test('signal aborted before run -> immediate throw', async () => {
  const provider = { chat: async () => { throw new Error('should not be called'); } };
  const loop = new AgentLoop({ provider, tools: fakeRegistry() });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    loop.run('task', { agentId: 'a', signal: ac.signal }),
    /aborted before start/
  );
});

test('signal aborts mid-run: provider sees the signal', async () => {
  let calls = 0;
  const provider = {
    chat: async (messages, opts) => {
      calls++;
      // simulate a slow gateway honoring the signal
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        opts?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
      return { content: 'never', model: 'm' };
    },
  };
  const loop = new AgentLoop({ provider, tools: fakeRegistry() });
  const ac = new AbortController();
  const p = loop.run('task', { agentId: 'a', signal: ac.signal, maxSteps: 5 });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, /aborted/);
  assert.equal(calls, 1);
});

test('no signal -> run completes normally', async () => {
  const provider = { chat: async () => ({ content: 'done', model: 'm' }) };
  const loop = new AgentLoop({ provider, tools: fakeRegistry() });
  const r = await loop.run('task', { agentId: 'a' });
  assert.equal(r.done, true);
});
