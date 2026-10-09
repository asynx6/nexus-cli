// CLI tests for `nexus replay diff` (TASK-LEONARS-B3).
//   node --test apps/cli/test/replaydiff.test.js
//
// Covers: identical runs, divergent runs, --json output, missing subjects,
// arg validation, and that the diff is scoped to the requested subjects
// (a regression where the subject filter was ignored would show every event
// in the store leaking into the diff).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNexusCli } from '../src/cli.js';
import { EventStore, makeEvent } from '@asynx6/nexus-event-system';

function tmp() { return mkdtempSync(join(tmpdir(), 'nexus-replaydiff-')); }

/** Populate a store with two runs and return the store path. */
function seed(dir, runs) {
  const storePath = join(dir, '.nexus', 'store', 'events.jsonl');
  const store = new EventStore(storePath);
  for (const [subject, events] of Object.entries(runs)) {
    for (const [name, data] of events) store.append(makeEvent(name, data, subject));
  }
  store.close();
  return storePath;
}

async function runCli(dir, argv) {
  const prev = process.cwd();
  let out = '', err = '';
  process.chdir(dir);
  try {
    const code = await runNexusCli(argv, {}, (s) => { out += s + '\n'; }, (s) => { err += s + '\n'; });
    return { code, out, err };
  } finally { process.chdir(prev); }
}

test('replay diff: identical runs report identical spine', async () => {
  const dir = tmp();
  try {
    seed(dir, {
      'r1': [['agent.task_start', { task: 'fib' }], ['agent.tool_called', { tool: 'fs.read', path: '/a' }], ['agent.task_done', { result: [1] }]],
      'r2': [['agent.task_start', { task: 'fib' }], ['agent.tool_called', { tool: 'fs.read', path: '/a' }], ['agent.task_done', { result: [1] }]],
    });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2']);
    assert.strictEqual(r.code, 0, `unexpected exit: ${r.err}`);
    assert.match(r.out, /identical/);
    assert.match(r.out, /same 3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: divergent runs show mod + added, exit 0', async () => {
  const dir = tmp();
  try {
    seed(dir, {
      'r1': [['agent.task_start', { task: 'fib' }], ['agent.tool_finished', { tool: 'fs.write', ok: true, ms: 10 }], ['agent.task_done', { result: [1] }]],
      'r2': [['agent.task_start', { task: 'fib' }], ['agent.tool_finished', { tool: 'fs.write', ok: false, ms: 30, errorText: 'ENOSPC' }], ['agent.tool_called', { tool: 'terminal.exec', cmd: 'run' }], ['agent.task_done', { result: [2] }]],
    });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2']);
    assert.strictEqual(r.code, 0, `unexpected exit: ${r.err}`);
    assert.match(r.out, /modified 2/);
    assert.match(r.out, /added 1/);
    assert.match(r.out, /removed 0/);
    assert.match(r.out, /ok: true → false/);
    assert.match(r.out, /\+ added/);
    assert.doesNotMatch(r.out, /identical/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: reversed direction flips added/removed', async () => {
  const dir = tmp();
  try {
    seed(dir, {
      'r1': [['agent.task_start', { task: 't' }], ['agent.task_done', { result: 1 }]],
      'r2': [['agent.task_start', { task: 't' }], ['agent.tool_called', { tool: 'fs.read', path: '/x' }], ['agent.task_done', { result: 1 }]],
    });
    const fwd = await runCli(dir, ['replay', 'diff', 'r1', 'r2']);
    const rev = await runCli(dir, ['replay', 'diff', 'r2', 'r1']);
    assert.strictEqual(fwd.code, 0);
    assert.strictEqual(rev.code, 0);
    assert.match(fwd.out, /added 1/);
    assert.match(rev.out, /removed 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: --json emits machine-readable ops', async () => {
  const dir = tmp();
  try {
    seed(dir, {
      'r1': [['agent.tool_finished', { tool: 'fs.write', ok: true }]],
      'r2': [['agent.tool_finished', { tool: 'fs.write', ok: false, errorText: 'boom' }]],
    });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2', '--json']);
    assert.strictEqual(r.code, 0, `unexpected exit: ${r.err}`);
    const payload = JSON.parse(r.out);
    assert.strictEqual(payload.left, 'r1');
    assert.strictEqual(payload.right, 'r2');
    assert.strictEqual(payload.summary.mod, 1);
    assert.strictEqual(payload.ops.length, 1);
    assert.strictEqual(payload.ops[0].op, 'mod');
    assert.deepStrictEqual(payload.ops[0].changes.map((c) => c.field), ['errorText', 'ok']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: only the two requested subjects participate', async () => {
  const dir = tmp();
  try {
    // Three runs; r3 must not leak into the r1/r2 diff.
    seed(dir, {
      'r1': [['agent.task_start', { task: 'a' }], ['agent.task_done', { result: 1 }]],
      'r2': [['agent.task_start', { task: 'a' }], ['agent.task_done', { result: 1 }]],
      'r3': [['agent.tool_called', { tool: 'terminal.exec', cmd: 'unrelated' }], ['agent.tool_finished', { tool: 'terminal.exec', ok: false, errorText: 'nope' }]],
    });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2']);
    assert.strictEqual(r.code, 0, `unexpected exit: ${r.err}`);
    assert.match(r.out, /identical/);
    assert.doesNotMatch(r.out, /unrelated/);
    assert.doesNotMatch(r.out, /nope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: missing subject errors with exit 1', async () => {
  const dir = tmp();
  try {
    seed(dir, { 'r1': [['agent.task_start', { task: 'a' }]] });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'nope']);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /no events for subject nope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: two subjects required, exit 2', async () => {
  const dir = tmp();
  try {
    seed(dir, { 'r1': [['agent.task_start', { task: 'a' }]] });
    const r = await runCli(dir, ['replay', 'diff', 'r1']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /two subjects required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: --left/--right flags resolve subjects', async () => {
  const dir = tmp();
  try {
    seed(dir, {
      'r1': [['agent.task_start', { task: 'a' }], ['agent.task_done', { result: 1 }]],
      'r2': [['agent.task_start', { task: 'a' }], ['agent.task_done', { result: 1 }]],
    });
    const r = await runCli(dir, ['replay', 'diff', '--left=r1', '--right=r2']);
    assert.strictEqual(r.code, 0, `unexpected exit: ${r.err}`);
    assert.match(r.out, /identical/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: --limit must be a positive integer', async () => {
  const dir = tmp();
  try {
    seed(dir, {
      'r1': [['agent.task_start', { task: 'a' }]],
      'r2': [['agent.task_start', { task: 'a' }]],
    });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2', '--limit=abc']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /--limit must be a positive integer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: --limit truncates long runs', async () => {
  const dir = tmp();
  try {
    const storePath = join(dir, '.nexus', 'store', 'events.jsonl');
    const store = new EventStore(storePath);
    for (let i = 0; i < 50; i++) {
      store.append(makeEvent('agent.tool_called', { tool: 'fs.read', path: `/f${i}` }, 'r1'));
      store.append(makeEvent('agent.tool_called', { tool: 'fs.read', path: `/f${i}` }, 'r2'));
    }
    store.close();
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2', '--limit=10']);
    assert.strictEqual(r.code, 0, `unexpected exit: ${r.err}`);
    assert.match(r.out, /events: 10 vs 10/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: --help prints usage, exit 0', async () => {
  const dir = tmp();
  try {
    seed(dir, { 'r1': [['agent.task_start', { task: 'a' }]] });
    const r = await runCli(dir, ['replay', 'diff', '--help']);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /nexus replay diff/);
    assert.match(r.out, /--json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay diff: empty store (no events at all) errors, exit 1', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.nexus', 'store'), { recursive: true });
    const r = await runCli(dir, ['replay', 'diff', 'r1', 'r2']);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /no events for subject/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
