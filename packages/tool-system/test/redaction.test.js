// C2: secret redaction on tool output before it hits the event store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutor } from '../src/executor.js';
import { ToolRegistry } from '../src/registry.js';

test('fs.read result with embedded api key is redacted in events and result', async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: 'fs.read', permission: 'fs.read', description: 'read',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => ({ content: 'token=abc123\npassword=hunter2\nplain text' }),
  });
  const events = [];
  const bus = { emit: (e) => events.push(e) };
  const ex = new ToolExecutor({ registry: reg });
  const r = await ex.execute({ tool: 'fs.read', args: { path: 'config.txt' } }, { agentId: 'a', bus });
  assert.equal(r.ok, true);
  assert.equal(r.result.content.includes('hunter2'), false);
  assert.match(r.result.content, /\[redacted\]/);
  const finished = events.find((e) => e.name === 'agent.tool_finished');
  assert.ok(finished, 'tool_finished event emitted');
  assert.equal(JSON.stringify(finished).includes('hunter2'), false);
  // plain values survive
  assert.match(r.result.content, /plain text/);
});
