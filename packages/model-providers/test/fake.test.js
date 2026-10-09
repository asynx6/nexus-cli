import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider } from '../src/fake.js';

test('FakeProvider: basic chat returns normalized content', async () => {
  const provider = new FakeProvider([{ content: 'hello world' }]);
  const res = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(res.model, 'fake/empty');
  assert.strictEqual(res.content, 'hello world');
  assert.strictEqual(res.tool_call, null);
  assert.deepStrictEqual(res.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
});

test('FakeProvider: tool_calls round-trip preserves id/name/arguments', async () => {
  const provider = new FakeProvider([
    {
      tool_calls: [
        { id: 't1', name: 'fs.read', arguments: { path: '/tmp/a.txt' } },
        { id: 't2', name: 'fs.write', arguments: { path: '/tmp/b.txt', content: 'x' } },
      ],
    },
  ]);
  const res = await provider.chat([{ role: 'user', content: 'edit' }]);
  assert.strictEqual(res.tool_calls.length, 2);
  assert.deepStrictEqual(res.tool_calls[0], { id: 't1', name: 'fs.read', arguments: { path: '/tmp/a.txt' } });
  assert.deepStrictEqual(res.tool_calls[1], { id: 't2', name: 'fs.write', arguments: { path: '/tmp/b.txt', content: 'x' } });
  assert.strictEqual(res.tool_call.id, 't1');
});

test('FakeProvider: streaming splits content into tokens', async () => {
  const provider = new FakeProvider([{ content: 'hi' }]);
  const chunks = [];
  for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }])) {
    chunks.push(chunk);
  }
  assert.ok(chunks.some((c) => c.type === 'text'), 'must emit text chunks');
  const text = chunks.filter((c) => c.type === 'text').map((c) => c.delta.content).join('');
  assert.strictEqual(text, 'hi');
  assert.ok(chunks.some((c) => c.type === 'done'));
});

test('FakeProvider: streaming tool_calls emits deltas and usage', async () => {
  const provider = new FakeProvider([
    {
      tool_calls: [{ id: 't1', name: 'fs.list', arguments: { path: '.' } }],
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    },
  ]);
  const chunks = [];
  for await (const chunk of provider.stream([{ role: 'user', content: 'list' }])) {
    chunks.push(chunk);
  }
  assert.ok(chunks.some((c) => c.type === 'tool_call_delta'));
  assert.ok(chunks.some((c) => c.type === 'usage'));
  assert.ok(chunks.some((c) => c.type === 'done'));
});

test('FakeProvider: empty queue returns null content', async () => {
  const provider = new FakeProvider([]);
  const res = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(res.content, null);
  assert.strictEqual(res.tool_call, null);
});

test('FakeProvider: abort signal throws', async () => {
  const controller = new AbortController();
  const provider = new FakeProvider([{ content: 'x' }]);
  controller.abort();
  await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }], { signal: controller.signal }), /aborted/);
});

test('FakeProvider: multiple turns are consumed in order', async () => {
  const provider = new FakeProvider([
    { content: 'first' },
    { content: 'second' },
    { content: 'third' },
  ]);
  assert.strictEqual((await provider.chat([])).content, 'first');
  assert.strictEqual((await provider.chat([])).content, 'second');
  assert.strictEqual((await provider.chat([])).content, 'third');
  assert.strictEqual((await provider.chat([])).content, null);
});
