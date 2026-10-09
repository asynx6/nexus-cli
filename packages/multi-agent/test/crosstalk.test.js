import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@asynx6/nexus-event-system';
import { CrossTalk } from '../index.js';

function fresh() {
  return new EventStore(join(mkdtempSync(join(tmpdir(), 'p13-')), 'events.jsonl'));
}

test('crosstalk: vinz -> kevin message lands in kevin inbox, not vinz own stream-as-inbox', () => {
  const store = fresh();
  const ct = new CrossTalk(store, ['agent-vinz', 'agent-kevin', 'agent-leo']);
  ct.send('agent-vinz', 'agent-kevin', 'ship P13 branch');
  const kb = [...ct.inbox('agent-kevin')];
  assert.equal(kb.length, 1);
  assert.equal(kb[0].data.from, 'agent-vinz');
  assert.equal(kb[0].data.to, 'agent-kevin');
  assert.equal(kb[0].subject, 'agent-kevin');
  assert.equal([...ct.inbox('agent-vinz')].length, 0);
});

test('crosstalk: kevin <-> leo bidirectional + reply helper', () => {
  const store = fresh();
  const ct = new CrossTalk(store, ['agent-kevin', 'agent-leo']);
  const sent = ct.send('agent-leo', 'agent-kevin', 'test plan ready?');
  assert.equal(sent.length, 1);
  const [msg] = [...ct.inbox('agent-kevin')];
  const rep = ct.reply(msg, 'yes, 6 tests');
  assert.equal(rep.data.from, 'agent-kevin');
  assert.equal(rep.data.replyTo, msg.id);
  const back = [...ct.inbox('agent-leo')];
  assert.equal(back.length, 1);
  assert.equal(back[0].data.text, 'yes, 6 tests');
});

test('crosstalk: broadcast to multiple recipients creates one copy each', () => {
  const store = fresh();
  const roster = ['agent-vinz', 'agent-kevin', 'agent-leo', 'agent-leonars'];
  const ct = new CrossTalk(store, roster);
  const out = ct.send('agent-vinz', ['agent-kevin', 'agent-leo', 'agent-leonars'], 'wave-2 merged');
  assert.equal(out.length, 3);
  for (const id of roster.slice(1)) assert.equal([...ct.inbox(id)].length, 1);
});

test('crosstalk: unknown recipient rejected, no partial delivery', () => {
  const store = fresh();
  const ct = new CrossTalk(store, ['agent-a', 'agent-b']);
  assert.throws(() => ct.send('agent-a', 'agent-zzz', 'hi'));
  assert.equal(store.count(), 0);
});
