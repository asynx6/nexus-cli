// @asynx6/api graceful shutdown unit tests. We never bind a real port:
// everything is stubbed and we drive the lifecycle directly via .close().
//
// Test surface:
//   - throws if `app` missing
//   - closes http + drains taskStore + closes eventStore in that order
//   - calls exit(0) once
//   - second invocation escalates to exit(1) and never re-runs steps
//   - logs each phase
//   - one step throwing does not prevent the rest from running
//   - uninstall() removes the signal listeners

import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from '../src/graceful.js';

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => lines.push({ level: 'error', msg, meta }),
    debug: () => {},
  };
}

function makeServer() {
  const ee = new EventEmitter();
  let closed = false;
  return {
    ee,
    isClosed: () => closed,
    close(cb) { closed = true; setImmediate(cb); },
  };
}

function makeTaskStore() {
  let drained = 0;
  return { drained: () => drained, drain: async () => { drained += 1; } };
}

function makeEventStore() {
  let closed = 0;
  return { closed: () => closed, close: () => { closed += 1; } };
}

test('throws when app is missing', () => {
  assert.throws(() => installGracefulShutdown({}), /app required/);
});

test('close() stops http, drains tasks, closes store, exits 0', async () => {
  const order = [];
  const server = makeServer();
  const tasks = makeTaskStore();
  const events = makeEventStore();
  const exitCalls = [];
  const logger = makeLogger();
  const handle = installGracefulShutdown({
    app: { taskStore: { drain: async () => { order.push('drain'); tasks.drained(); } }, eventStore: { close: () => { order.push('close'); events.close(); } } },
    http: { server: { close: (cb) => { order.push('http'); server.close(cb); } } },
    logger,
    exit: (code) => { exitCalls.push(code); },
  });
  await handle.close();
  assert.deepStrictEqual(order, ['http', 'drain', 'close'], 'shutdown order');
  assert.deepStrictEqual(exitCalls, [0]);
  assert.ok(logger.lines.some((l) => l.level === 'info' && l.msg === 'shutdown: starting'));
  assert.ok(logger.lines.some((l) => l.level === 'info' && l.msg === 'shutdown: http closed'));
  assert.ok(logger.lines.some((l) => l.level === 'info' && l.msg === 'shutdown: tasks drained'));
  assert.ok(logger.lines.some((l) => l.level === 'info' && l.msg === 'shutdown: store closed'));
  assert.ok(logger.lines.some((l) => l.level === 'info' && l.msg === 'shutdown: complete'));
});

test('http.close throwing does not block drain+close', async () => {
  const order = [];
  const logger = makeLogger();
  const exitCalls = [];
  await installGracefulShutdown({
    app: {
      taskStore: { drain: async () => { order.push('drain'); } },
      eventStore: { close: () => { order.push('close'); } },
    },
    http: { server: { close: () => { throw new Error('boom'); } } },
    logger,
    exit: (code) => { exitCalls.push(code); },
  }).close();
  assert.deepStrictEqual(order, ['drain', 'close']);
  assert.deepStrictEqual(exitCalls, [0]);
  assert.ok(logger.lines.some((l) => l.level === 'warn' && l.msg === 'shutdown: http close error'));
});

test('drain throwing does not block store close', async () => {
  const order = [];
  const logger = makeLogger();
  const exitCalls = [];
  await installGracefulShutdown({
    app: {
      taskStore: { drain: async () => { throw new Error('drain fail'); } },
      eventStore: { close: () => { order.push('close'); } },
    },
    http: null,
    logger,
    exit: (code) => { exitCalls.push(code); },
  }).close();
  assert.deepStrictEqual(order, ['close']);
  assert.deepStrictEqual(exitCalls, [0]);
  assert.ok(logger.lines.some((l) => l.level === 'warn' && l.msg === 'shutdown: drain error'));
});

test('re-entrant: second close() escalates to exit(1)', async () => {
  const exitCalls = [];
  const logger = makeLogger();
  // first close hangs the drain so a second signal fires mid-flight
  let resolveDrain;
  const handle = installGracefulShutdown({
    app: {
      taskStore: { drain: () => new Promise((r) => { resolveDrain = r; }) },
      eventStore: { close: () => {} },
    },
    http: null,
    logger,
    exit: (code) => { exitCalls.push(code); },
  });
  const first = handle.close();
  // let the first close set shuttingDown=true and call drain
  await new Promise((r) => setImmediate(r));
  await handle.close(); // second call -> escalation
  assert.deepStrictEqual(exitCalls, [1], 'second invocation escalates');
  assert.ok(logger.lines.some((l) => l.level === 'warn' && /escalation/.test(l.msg)));
  // finish the dangling drain so the promise can settle without leaks
  resolveDrain();
  await first;
});

test('multiple escalations only call exit(1) once', async () => {
  const exitCalls = [];
  const logger = makeLogger();
  let resolveDrain;
  const handle = installGracefulShutdown({
    app: {
      taskStore: { drain: () => new Promise((r) => { resolveDrain = r; }) },
      eventStore: { close: () => {} },
    },
    http: null,
    logger,
    exit: (code) => { exitCalls.push(code); },
  });
  const first = handle.close();
  await new Promise((r) => setImmediate(r));
  await handle.close();
  await handle.close();
  await handle.close();
  assert.deepStrictEqual(exitCalls, [1]);
  resolveDrain();
  await first;
});

test('uninstall() removes signal listeners and close still works manually', async () => {
  const exitCalls = [];
  const logger = makeLogger();
  const handle = installGracefulShutdown({
    app: {
      taskStore: { drain: async () => {} },
      eventStore: { close: () => {} },
    },
    http: null,
    logger,
    exit: (code) => { exitCalls.push(code); },
  });
  handle.uninstall();
  // emitting SIGTERM after uninstall must not trigger the listener
  process.emit('SIGTERM');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(exitCalls, []);
  await handle.close();
  assert.deepStrictEqual(exitCalls, [0]);
});

test('SIGTERM triggers shutdown end-to-end', async () => {
  const exitCalls = [];
  const order = [];
  const handle = installGracefulShutdown({
    app: {
      taskStore: { drain: async () => { order.push('drain'); } },
      eventStore: { close: () => { order.push('close'); } },
    },
    http: { server: { close: (cb) => { order.push('http'); setImmediate(cb); } } },
    logger: makeLogger(),
    exit: (code) => { exitCalls.push(code); },
  });
  process.emit('SIGTERM');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(order, ['http', 'drain', 'close']);
  assert.deepStrictEqual(exitCalls, [0]);
  handle.uninstall();
});
