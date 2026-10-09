import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, makeEvent } from '@asynx6/nexus-event-system';
import { AgentStream } from '../index.js';

function fresh() {
  return new EventStore(join(mkdtempSync(join(tmpdir(), 'p13-')), 'events.jsonl'));
}

test('stream: events are stamped with the owning agent and replay in order', () => {
  const store = fresh();
  const a = new AgentStream(store, 'agent-kevin');
  a.append('agent.started', { role: 'coder' });
  a.append('agent.thinking', { step: 1 });
  const evs = [...a.events()];
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.subject === 'agent-kevin'));
  assert.equal(evs[0].name, 'agent.started');
  assert.equal(evs[1].data.step, 1);
  const b = new AgentStream(store, 'agent-vinz');
  assert.equal([...b.events()].length, 0);
});

test('stream: envelope append is re-stamped to the owning stream', () => {
  const store = fresh();
  const a = new AgentStream(store, 'agent-kevin');
  const forged = makeEvent('agent.thinking', {}, 'agent-vinz');
  a.append(forged);
  assert.equal([...a.events()][0].subject, 'agent-kevin');
});

test('stream: inbox filters agent.message addressed to this agent', () => {
  const store = fresh();
  const a = new AgentStream(store, 'agent-kevin');
  a.append('agent.message', { from: 'agent-vinz', to: 'agent-kevin', text: 'hi' });
  a.append('agent.message', { from: 'agent-vinz', to: 'agent-other', text: 'not mine' });
  a.append('agent.started', {});
  assert.equal([...a.inbox()].length, 1);
});
