// Session model: every run gets a sessionId; full conversation is
// reconstructable from the event store alone (session.* events).
// --continue resumes the latest session in cwd; --resume <id> picks one.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';

export function newSessionId() {
  return newId('session');
}

/** sessions.json index in the store dir: [{id, startedAt, cwd, lastSubject}] */
function indexPath(storeDir) {
  return join(storeDir, 'sessions.json');
}

export function loadSessionIndex(storeDir) {
  const p = indexPath(storeDir);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

export function saveSessionIndex(storeDir, sessions) {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(indexPath(storeDir), JSON.stringify(sessions, null, 2));
}

export function recordSession(storeDir, { id, cwd, subject }) {
  const sessions = loadSessionIndex(storeDir);
  const existing = sessions.find((s) => s.id === id);
  if (existing) {
    existing.lastSubject = subject ?? existing.lastSubject;
  } else {
    sessions.push({ id, startedAt: new Date().toISOString(), cwd, lastSubject: subject ?? null });
  }
  saveSessionIndex(storeDir, sessions);
}

/** Latest session for this cwd, or by explicit id. */
export function findSession(storeDir, { id = null, cwd = null } = {}) {
  const sessions = loadSessionIndex(storeDir);
  if (id) return sessions.find((s) => s.id === id || s.id.startsWith(id)) ?? null;
  if (!cwd) return null;
  const mine = sessions.filter((s) => s.cwd === cwd);
  return mine.length ? mine[mine.length - 1] : null;
}

/** Rebuild the message history of a session from session.* events. */
export async function replaySessionHistory(store, sessionId) {
  const messages = [];
  const real = typeof store?.replay === 'function' ? store : await store?.open?.();
  const iter = await real.replay({ subject: sessionId });
  for await (const e of iter) {
    if (e.name === 'session.user_message') {
      messages.push({ role: 'user', content: e.data.content });
    } else if (e.name === 'session.assistant_message') {
      messages.push({ role: 'assistant', content: e.data.content });
    }
    // tool messages are replayed by the model on demand; the core conversation
    // spine is user/assistant pairs.
  }
  return messages;
}

/** Emit the full conversation spine as events so replay reconstructs it. */
export function emitSessionEvents(bus, sessionId, { user, assistant, toolResult } = {}) {
  if (user !== undefined) bus.emit(makeEvent('session.user_message', { content: user }, sessionId));
  if (assistant !== undefined) bus.emit(makeEvent('session.assistant_message', { content: assistant }, sessionId));
  if (toolResult !== undefined) bus.emit(makeEvent('session.tool_result', toolResult, sessionId));
}
