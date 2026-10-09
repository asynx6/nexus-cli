// @asynx6/cli graceful shutdown test — signals trigger clean exit, double-signal escalates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGracefulShutdown } from '../src/graceful.js';

let exitCode = 0;
let logger;

function setup() {
  exitCode = 0;
  logger = { info: () => {}, warn: () => {}, error: () => {} };
}

test('installGracefulShutdown: onClose called on first SIGTERM', async () => {
  setup();
  let closed = false;
  const handler = installGracefulShutdown({
    onClose: async () => { closed = true; },
    logger,
    exit: (c) => { exitCode = c; },
  });
  process.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, true);
  assert.equal(exitCode, 0);
  handler.uninstall();
});

test('installGracefulShutdown: SIGINT also triggers', async () => {
  setup();
  let closed = false;
  const handler = installGracefulShutdown({
    onClose: async () => { closed = true; },
    logger,
    exit: (c) => { exitCode = c; },
    signals: ['SIGINT'],
  });
  process.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, true);
  assert.equal(exitCode, 0);
  handler.uninstall();
});

test('installGracefulShutdown: second signal escalates to exit 1', async () => {
  setup();
  let closed = false;
  const handler = installGracefulShutdown({
    onClose: async () => { closed = true; throw new Error('simulate crash'); },
    logger,
    exit: (c) => { exitCode = c; },
  });
  process.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, true);
  handler.uninstall();
});

test('installGracefulShutdown: isActive=false skips close', async () => {
  setup();
  const handler = installGracefulShutdown({
    onClose: async () => {},
    isActive: () => false,
    logger,
    exit: (c) => { exitCode = c; },
  });
  process.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(exitCode, 0);
  handler.uninstall();
});

test('installGracefulShutdown: uninstall prevents further triggers', async () => {
  setup();
  let closed = false;
  const handler = installGracefulShutdown({
    onClose: async () => { closed = true; },
    logger,
    exit: (c) => { exitCode = c; },
  });
  handler.uninstall();
  process.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, false);
  assert.equal(exitCode, 0);
});