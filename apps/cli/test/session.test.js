// C1 session regression: index, resume, history replay from events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, makeEvent } from '@asynx6/nexus-event-system';
import {
  newSessionId, recordSession, findSession, loadSessionIndex,
  saveSessionIndex, emitSessionEvents, replaySessionHistory,
} from '../src/session.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sess-'));
  mkdirSync(join(dir, '.nexus', 'store'), { recursive: true });
  return dir;
}

test('record + find session by cwd, latest wins', () => {
  const dir = tmpStore();
  try {
    const store = join(dir, '.nexus', 'store');
    const a = newSessionId(), b = newSessionId();
    recordSession(store, { id: a, cwd: dir, subject: 'first task' });
    recordSession(store, { id: b, cwd: dir, subject: 'second task' });
    const found = findSession(store, { cwd: dir });
    assert.equal(found.id, b); // latest
    assert.equal(findSession(store, { id: a }).id, a);
    assert.equal(findSession(store, { id: 'nope' }), null);
    assert.equal(findSession(store, { cwd: '/elsewhere' }), null);
    // prefix match
    assert.equal(findSession(store, { id: a.slice(0, 10) }).id, a);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordSession updates lastSubject on same id', () => {
  const dir = tmpStore();
  try {
    const store = join(dir, '.nexus', 'store');
    const id = newSessionId();
    recordSession(store, { id, cwd: dir, subject: 'one' });
    recordSession(store, { id, cwd: dir, subject: 'two' });
    const sessions = loadSessionIndex(store);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].lastSubject, 'two');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('emitSessionEvents -> replaySessionHistory rebuilds the spine', async () => {
  const dir = tmpStore();
  try {
    const store = new EventStore(join(dir, '.nexus', 'store', 'events.jsonl'));
    const bus = { emit: (e) => store.append(e) };
    const sid = newSessionId();
    emitSessionEvents(bus, sid, { user: 'hello' });
    emitSessionEvents(bus, sid, { assistant: 'hi there' });
    emitSessionEvents(bus, sid, { user: 'do a thing' });
    emitSessionEvents(bus, sid, { assistant: 'done' });
    // other subject noise must not leak in
    bus.emit(makeEvent('session.user_message', { content: 'other' }, 'session-other'));
    await store.close();
    const reopened = new EventStore(join(dir, '.nexus', 'store', 'events.jsonl'));
    const history = await replaySessionHistory(reopened, sid);
    await reopened.close();
    assert.deepEqual(history, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'do a thing' },
      { role: 'assistant', content: 'done' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saveSessionIndex round-trip', () => {
  const dir = tmpStore();
  try {
    const store = join(dir, '.nexus', 'store');
    saveSessionIndex(store, [{ id: 'session-x', startedAt: 'now', cwd: dir, lastSubject: 's' }]);
    assert.deepEqual(loadSessionIndex(store), [{ id: 'session-x', startedAt: 'now', cwd: dir, lastSubject: 's' }]);
    // corrupt file -> empty, not a crash
    writeFileSync(join(store, 'sessions.json'), '{broken');
    assert.deepEqual(loadSessionIndex(store), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
