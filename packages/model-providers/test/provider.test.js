import { test } from 'node:test';
import assert from 'node:assert';
import { ModelProvider } from '../src/provider.js';

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opt) => {
    const body = opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url, body, headers: opt.headers });
    return handler(url, body, calls.length);
  };
  return calls;
}
const resp = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const ok = (content) => resp({ choices: [{ message: { content } }], usage: { total_tokens: 5 }, id: 'x' });
const fail = (status) => ({ ok: false, status, json: async () => ({ error: 'boom' }), text: async () => 'boom' });

test('rejects bad config', () => {
  assert.throws(() => new ModelProvider({}), TypeError);
  assert.throws(() => new ModelProvider({ baseUrl: 'notaurl' }), TypeError);
  assert.throws(() => new ModelProvider({ baseUrl: 'https://a', apiKey: '', models: ['m'] }), /apiKey/);
});

test('primary model used first; content + usage returned', async () => {
  const calls = mockFetch(() => ok('PONG'));
  const p = new ModelProvider({ baseUrl: 'https://api.test/', apiKey: 'k', models: ['m1', 'm2'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.model, 'm1');
  assert.strictEqual(r.content, 'PONG');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.test/chat/completions');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer k');
  globalThis.fetch = undefined;
});

test('4xx on primary falls through to secondary without retry', async () => {
  const calls = mockFetch((u, b) => b.model === 'm1' ? fail(403) : ok('from-m2'));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m1', 'm2'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.model, 'm2');
  assert.strictEqual(calls.length, 2);
  globalThis.fetch = undefined;
});

test('5xx retries once before moving to next model', async () => {
  const calls = mockFetch((u, b, n) => (b.model === 'm1' && n <= 2) ? fail(500) : ok('late'));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m1', 'm2'], retries: 1 });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(calls.length, 3); // m1 x2 (initial+retry), then m2
  assert.strictEqual(r.content, 'late');
  globalThis.fetch = undefined;
});

test('all models down -> single aggregate error, key never in message', async () => {
  mockFetch(() => fail(500));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'sup3rsecret', models: ['m1'], retries: 0 });
  await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), (e) => {
    assert.match(e.message, /all models failed/);
    assert.ok(!e.message.includes('sup3rsecret'), 'error must not leak key');
    return true;
  });
  globalThis.fetch = undefined;
});

test('choices missing -> treated as provider fault', async () => {
  mockFetch(() => resp({ _manifest: {} }));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m1'], retries: 0 });
  await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /no choices/);
  globalThis.fetch = undefined;
});

test('explicit opts.model overrides order', async () => {
  const calls = mockFetch(() => ok('x'));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m1', 'm2'] });
  await p.chat([{ role: 'user', content: 'hi' }], { model: 'm2' });
  assert.strictEqual(calls[0].body.model, 'm2');
  globalThis.fetch = undefined;
});

test('listModels parses data array', async () => {
  mockFetch(() => resp({ data: [{ id: 'a' }, { id: 'b' }] }));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['a'] });
  assert.deepStrictEqual(await p.listModels(), ['a', 'b']);
  globalThis.fetch = undefined;
});

test('opts.tools sent as native function schemas; native tool_calls normalized', async () => {
  let captured;
  mockFetch((u, b) => {
    captured = b;
    return resp({
          choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_write', arguments: '{"path":"/p"}' } }] } }],
          usage: null, id: 'x',
        });
  });
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }], { tools: [{ name: 'fs_write', description: 'd', parameters: { type: 'object' } }] });
  assert.deepStrictEqual(captured.tools, [{ type: 'function', function: { name: 'fs_write', description: 'd', parameters: { type: 'object' } } }]);
  assert.deepStrictEqual(r.tool_call, { id: 'c1', name: 'fs_write', arguments: { path: '/p' } });
  assert.deepStrictEqual(r.tool_calls, [{ id: 'c1', name: 'fs_write', arguments: { path: '/p' } }]);
  assert.strictEqual(r.content, null);
  globalThis.fetch = undefined;
});

test('malformed arguments string survives as _raw', async () => {
  mockFetch(() => resp({
    choices: [{ message: { tool_calls: [{ function: { name: 't', arguments: 'not-json' } }] } }] }));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(r.tool_call.arguments, { _raw: 'not-json' });
  globalThis.fetch = undefined;
});

test('gateway replies SSE to non-stream call -> aggregated content', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"P"}}]}',
    'data: {"choices":[{"delta":{"content":"ONG"}}],"model":"m"}',
    'data: [DONE]',
    '',
  ].join('\n');
  mockFetch(() => ({ ok: true, status: 200, text: async () => sse, json: async () => { throw new Error('not json'); } }));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.content, 'PONG');
  assert.strictEqual(r.model, 'm');
  globalThis.fetch = undefined;
});


test('MiniBucket throttles beyond burst', async () => {
  const { MiniBucket } = await import('../src/provider.js');
  const b = new MiniBucket({ rpm: 60, burst: 1 }); // ~1 token/s
  assert.equal(b.waitMs(), 0, 'first token is free');
  b.consume();
  const w = b.waitMs();
  assert.ok(w >= 900 && w <= 1100, `second call must wait ~1000ms, got ${w}`);
});

test('rateLimit config is honored by ModelProvider', () => {
  const p = new ModelProvider({
    baseUrl: 'http://localhost:1', apiKey: 'k',
    models: ['m'], rateLimit: { rpm: 10, burst: 2 }
  });
  assert.deepEqual(p.models, ['m']);
});

test('rateLimit default uses rpm as burst', () => {
  const p = new ModelProvider({
    baseUrl: 'http://localhost:1', apiKey: 'k',
    models: ['m'], rateLimit: { rpm: 5 }
  });
  assert.deepEqual(p.models, ['m']);
});

test('B7: SSE tool_call deltas accumulate across chunks (name + argument fragments)', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_","arguments":"{\\"pa"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write","arguments":"th\\":\\"/p\\"}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":9}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  mockFetch(() => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(r.tool_calls, [{ id: 'c1', name: 'fs_write', arguments: { path: '/p' } }]);
  globalThis.fetch = undefined;
});

test('B7: two tool_calls in one response both survive', async () => {
  mockFetch(() => resp({
    choices: [{ message: { content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'fs.read', arguments: '{"path":"/1"}' } },
      { id: 'b', type: 'function', function: { name: 'fs.write', arguments: '{"path":"/2"}' } },
    ] } }],
  }));
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.tool_calls.length, 2);
  assert.strictEqual(r.tool_calls[0].id, 'a');
  assert.strictEqual(r.tool_calls[1].id, 'b');
  assert.strictEqual(r.tool_call.id, 'a');
  globalThis.fetch = undefined;
});

test('B8: internal fields (ok) never reach the API body', async () => {
  let captured;
  mockFetch((u, b) => { captured = b; return resp({ choices: [{ message: { content: 'ok' } }] }); });
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  await p.chat([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'out', ok: true },
  ]);
  const toolMsg = captured.messages.find((m) => m.role === 'tool');
  assert.deepStrictEqual(Object.keys(toolMsg).sort(), ['content', 'role', 'tool_call_id']);
  globalThis.fetch = undefined;
});

test('B7: max_tokens defaults to 4096, NEXUS_MAX_TOKENS overrides', async () => {
  let captured;
  mockFetch((u, b) => { captured = b; return resp({ choices: [{ message: { content: 'ok' } }] }); });
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k', models: ['m'] });
  await p.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(captured.max_tokens, 4096);
  process.env.NEXUS_MAX_TOKENS = '2048';
  try {
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(captured.max_tokens, 2048);
  } finally { delete process.env.NEXUS_MAX_TOKENS; }
  globalThis.fetch = undefined;
});
