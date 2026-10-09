import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@asynx6/nexus-event-system';
import { Handshake } from '../index.js';

function fresh() {
  return new EventStore(join(mkdtempSync(join(tmpdir(), 'p13-')), 'events.jsonl'));
}

test('handshake: single agent hello is not ready without peer acks', () => {
  const store = fresh();
  const hs = new Handshake(store, ['agent-a', 'agent-b', 'agent-c', 'agent-d']);
  const st = hs.hello('agent-a');
  assert.equal(st.ready, false);
  assert.equal(st.hello, true);
  assert.equal(hs.allReady(), false);
});

test('handshake: hello from each of 4 agents => all ready', () => {
  const store = fresh();
  const roster = ['agent-vinz', 'agent-kevin', 'agent-leo', 'agent-leonars'];
  const hs = new Handshake(store, roster);
  for (const id of roster) hs.hello(id);
  assert.equal(hs.allReady(), true);
  const st = hs.status('agent-kevin');
  assert.deepEqual(st.acks.sort(), roster.filter((r) => r !== 'agent-kevin').sort());
});

test('handshake: acks land on the peer stream, not the acker', () => {
  const store = fresh();
  const hs = new Handshake(store, ['agent-a', 'agent-b']);
  hs.hello('agent-a');
  const b = hs.stream('agent-b');
  assert.equal([...b.events()].length, 1);
  assert.equal([...b.events()][0].data.ackTo, 'agent-a');
});

test('handshake: partial roster (2 agents) is valid and completes', () => {
  const store = fresh();
  const hs = new Handshake(store, ['agent-x', 'agent-y']);
  hs.hello('agent-x');
  hs.hello('agent-y');
  assert.equal(hs.allReady(), true);
});
