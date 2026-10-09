import { test } from 'node:test';
import assert from 'node:assert';
import { EventBus } from '../src/bus.js';
import { makeEvent } from '../src/events.js';
import { EVENTS } from '@asynx6/nexus-shared';

test('routes by name, once, wildcard, unsubscribe', () => {
  const bus = new EventBus();
  const seen = [];
  const off = bus.on(EVENTS.AGENT_STARTED, (e) => seen.push(['typed', e.name]));
  bus.on('*', (e) => seen.push(['wild', e.name]));
  bus.once(EVENTS.AGENT_THINKING, (e) => seen.push(['once', e.name]));
  bus.emit(makeEvent(EVENTS.AGENT_STARTED, {}, 'agent-r'));
  bus.emit(makeEvent(EVENTS.AGENT_THINKING, {}, 'agent-r'));
  bus.emit(makeEvent(EVENTS.AGENT_THINKING, {}, 'agent-r'));
  off();
  bus.emit(makeEvent(EVENTS.AGENT_STARTED, {}, 'agent-r'));
  assert.deepStrictEqual(seen, [
    ['typed', 'agent.started'], ['wild', 'agent.started'],
    ['once', 'agent.thinking'], ['wild', 'agent.thinking'],
    ['wild', 'agent.thinking'],
    ['wild', 'agent.started'],
  ]);
});

test('listener throw does not break other listeners', () => {
  const bus = new EventBus();
  let hit = 0;
  bus.on('x.y', () => { throw new Error('boom'); });
  bus.on('x.y', () => { hit++; });
  const n = bus.emit(makeEvent('x.y', {}, null));
  assert.strictEqual(n, 2);
  assert.strictEqual(hit, 1);
});

test('removeAllListeners', () => {
  const bus = new EventBus();
  let c = 0;
  bus.on('x.y', () => c++);
  bus.removeAllListeners('x.y');
  bus.emit(makeEvent('x.y', {}, null));
  assert.strictEqual(c, 0);
});
