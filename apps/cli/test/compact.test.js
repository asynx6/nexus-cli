// CLI-level tests for `nexus events compact`.
// Both reproduce real consumer bugs found testing @asynx6/nexus-cli@0.3.4:
//   1. cached store handle is reused after compact() closed it -> EBADF
//   2. `--keep-recent=N` keeps N+1 events (replay({since: dropped})
//      includes the boundary event; seq starts at 0 in EventStore)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNexusCli } from '../src/cli.js';
import { EventStore, makeEvent } from '@asynx6/nexus-event-system';

function tmp() { return mkdtempSync(join(tmpdir(), 'nexus-compact-cli-')); }

// Populate a store exactly like `nexus run` does: seqs start at 0, and the
// process exits (store closed) before compact runs in a separate process.
function populate(storePath, n) {
  const store = new EventStore(storePath);
  for (let i = 0; i < n; i++) store.append(makeEvent('test.event', { i }, 'subj-1'));
  store.close();
}

// `nexus events compact` without --store resolves its store relative to cwd,
// so each test chdirs into its own temp dir.
async function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

test('cli events compact: drops N-keepRecent and keeps exactly keepRecent', async () => {
  const dir = tmp();
  try {
    const storePath = join(dir, '.nexus', 'store', 'events.jsonl');
    populate(storePath, 10);

    let out = '';
    let err = '';
    const code = await withCwd(dir, () => runNexusCli(
      ['events', 'compact', '--keep-recent=3'],
      {}, (s) => { out += s + '\n'; }, (s) => { err += s + '\n'; }
    ));
    assert.strictEqual(code, 0, `unexpected exit: ${err}`);
    assert.match(out, /compact: 10 → 3 events/);

    // Assert on the JSONL directly: opening an EventStore after compact leaves
    // a Windows file handle on the freshly renamed .idx -> EBUSY on rmSync below.
    const lines = readFileSync(storePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, `store must hold exactly 3 events: ${lines}`);
    const seqs = lines.map((l) => JSON.parse(l).seq);
    assert.deepEqual(seqs, [1, 2, 3]);
    assert.deepEqual(lines.map((l) => JSON.parse(l).data.i), [7, 8, 9]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli events compact: keep-recent=1 keeps exactly 1', async () => {
  const dir = tmp();
  try {
    const storePath = join(dir, ".nexus", "store", "events.jsonl");
    populate(storePath, 5);

    let out = '';
    let err = '';
    const code = await withCwd(dir, () => runNexusCli(
      ['events', 'compact', '--keep-recent=1'],
      {}, (s) => { out += s + '\n'; }, (s) => { err += s + '\n'; }
    ));
    assert.strictEqual(code, 0, `compact keep-recent=1 failed: ${err}`);
    assert.match(out, /compact: 5 → 1 events/);
    const lines = readFileSync(storePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, `store must hold exactly 1 event: ${lines}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli events compact: second run is idempotent (no cached closed handle)', async () => {
  const dir = tmp();
  try {
    const storePath = join(dir, ".nexus", "store", "events.jsonl");
    populate(storePath, 8);

    for (const want of ['compact: 8 → 2 events', 'compact: 2 → 2 events']) {
      let out = '';
      let err = '';
      const code = await withCwd(dir, () => runNexusCli(
        ['events', 'compact', '--keep-recent=2'],
        {}, (s) => { out += s + '\n'; }, (s) => { err += s + '\n'; }
      ));
      assert.strictEqual(code, 0, `expected success, got ${code}: ${err}`);
      assert.match(out, new RegExp(want.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compact: keepRecent is inclusive of the boundary seq', () => {
  // EventStore assigns seq starting at 0. With total=10 and keepRecent=3 the
  // survivors are seq 7,8,9 — NOT 6,7,8. replay({since: dropped}) returns
  // dropped..end which is one row too many.
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    const store = new EventStore(path);
    for (let i = 0; i < 10; i++) store.append(makeEvent('test.event', { i }, 'subj-1'));
    store.close();
    const reopen = new EventStore(path);
    try {
      assert.equal([...reopen.replay({ since: 7 })].length, 3);
      assert.deepEqual([...reopen.replay({ since: 7 })].map((e) => e.data.i), [7, 8, 9]);
    } finally { reopen.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
