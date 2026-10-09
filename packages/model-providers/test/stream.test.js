// Fase 3: provider.stream() — SSE incremental parse, fallback, abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ModelProvider } from '../src/provider.js';

function sseServer(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': contentType });
      if (status !== 200) { res.end(JSON.stringify({ error: 'no stream' })); return; }
      for (const c of chunks) res.write(c);
      res.end();
    });
  });
  return srv;
}

test('stream: text deltas in order, usage, done with chat()-shaped result', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":42}}\n\n',
    'data: [DONE]\n\n',
  ];
  const srv = sseServer(chunks);
  await new Promise((r) => srv.listen(18901, '127.0.0.1', r));
  const p = new ModelProvider({ baseUrl: 'http://127.0.0.1:18901/v1', apiKey: 'k', models: ['m'] });
  const seen = [];
  for await (const e of p.stream([{ role: 'user', content: 'hi' }])) seen.push(e);
  srv.close();
  const texts = seen.filter((e) => e.type === 'text').map((e) => e.delta);
  assert.deepEqual(texts, ['Hel', 'lo']);
  assert.equal(seen.at(-1).type, 'done');
  const result = seen.at(-1).result;
  assert.equal(result.content, 'Hello');
  assert.equal(result.model, 'm');
  assert.deepEqual(result.usage, { total_tokens: 42 });
  assert.equal(result.tool_calls.length, 0);
});

test('stream: tool_call deltas accumulate name + argument fragments', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"x\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const srv = sseServer(chunks);
  await new Promise((r) => srv.listen(18902, '127.0.0.1', r));
  const p = new ModelProvider({ baseUrl: 'http://127.0.0.1:18902/v1', apiKey: 'k', models: ['m'] });
  const seen = [];
  for await (const e of p.stream([{ role: 'user', content: 'hi' }])) seen.push(e);
  srv.close();
  const result = seen.at(-1).result;
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].name, 'fs_write');
  assert.deepEqual(result.tool_calls[0].arguments, { path: 'x' });
  assert.equal(result.tool_calls[0].id, 'c1');
  // deltas were emitted along the way
  const tcd = seen.filter((e) => e.type === 'tool_call_delta');
  assert.equal(tcd.length, 3);
});

test('stream: fallback to non-stream when gateway rejects (400)', async () => {
  // stream endpoint 400s; chat endpoint works
  let streamCalls = 0, chatCalls = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      const isStream = JSON.parse(body).stream === true;
      if (isStream) {
        streamCalls++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'streaming unsupported' }));
      } else {
        chatCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'fallback reply' } }], usage: { total_tokens: 5 } }));
      }
    });
  });
  await new Promise((r) => srv.listen(18903, '127.0.0.1', r));
  const p = new ModelProvider({ baseUrl: 'http://127.0.0.1:18903/v1', apiKey: 'k', models: ['m'] });
  const seen = [];
  for await (const e of p.stream([{ role: 'user', content: 'hi' }])) seen.push(e);
  srv.close();
  assert.equal(streamCalls, 1);
  assert.equal(chatCalls, 1);
  assert.deepEqual(seen.map((e) => e.type), ['text', 'usage', 'done']);
  assert.equal(seen.at(-1).result.content, 'fallback reply');
});

test('stream: 200 JSON body parsed directly (no second request)', async () => {
  let calls = 0;
  const srv2 = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      calls++;
      const isStream = JSON.parse(body).stream === true;
      // gateway answers a normal completion even for stream:true
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: isStream ? 'json not sse' : 'chat reply' } }] }));
    });
  });
  await new Promise((r) => srv2.listen(18904, '127.0.0.1', r));
  const p = new ModelProvider({ baseUrl: 'http://127.0.0.1:18904/v1', apiKey: 'k', models: ['m'] });
  const seen = [];
  for await (const e of p.stream([{ role: 'user', content: 'hi' }])) seen.push(e);
  srv2.close();
  assert.equal(calls, 1); // exactly one request — no double billing
  assert.equal(seen.at(-1).result.content, 'json not sse');
});

test('stream: abort signal stops the stream', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    // never send [DONE]; keep connection open
    req.on('close', () => res.end());
  });
  await new Promise((r) => srv.listen(18905, '127.0.0.1', r));
  const p = new ModelProvider({ baseUrl: 'http://127.0.0.1:18905/v1', apiKey: 'k', models: ['m'], timeoutMs: 60_000 });
  const ac = new AbortController();
  const seen = [];
  try {
    const iter = p.stream([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    const t = setTimeout(() => ac.abort(), 50);
    for await (const e of iter) { seen.push(e); }
    clearTimeout(t);
  } catch (e) {
    assert.match(String(e?.message ?? e), /abort/i);
    srv.close();
    return;
  }
  srv.close();
  assert.fail('expected abort to throw');
});

test('stream: multi-line data frames split across chunk boundaries', async () => {
  // one TCP chunk contains two SSE frames + a partial frame completed later
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\ndata: {"choi');
    setTimeout(() => {
      res.write('ces":[{"delta":{"content":"z"}}]}\n\ndata: [DONE]\n\n');
      res.end();
    }, 30);
  });
  await new Promise((r) => srv.listen(18906, '127.0.0.1', r));
  const p = new ModelProvider({ baseUrl: 'http://127.0.0.1:18906/v1', apiKey: 'k', models: ['m'] });
  const seen = [];
  for await (const e of p.stream([{ role: 'user', content: 'hi' }])) seen.push(e);
  srv.close();
  assert.equal(seen.at(-1).result.content, 'xyz');
});
