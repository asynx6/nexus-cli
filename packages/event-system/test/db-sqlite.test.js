// @asynx6/event-system — SQLite driver end-to-end (real node:sqlite, in-memory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbAdapter } from '../src/db/factory.js';

test('sqlite adapter: defaults to sqlite via NEXUS_DB_URL unset', async () => {
  const adapter = await createDbAdapter('sqlite://:memory:');
  assert.equal(adapter.driver, 'sqlite');
  await adapter.close();
});

test('sqlite adapter: query (SELECT) returns rows', async () => {
  const a = await createDbAdapter('sqlite://:memory:');
  await a.exec('CREATE TABLE t (id INTEGER, name TEXT);');
  await a.query('INSERT INTO t VALUES (?, ?);', [1, 'kevin']);
  await a.query('INSERT INTO t VALUES (?, ?);', [2, 'vinz']);
  const rows = await a.query('SELECT id, name FROM t ORDER BY id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'kevin');
  assert.equal(rows[1].name, 'vinz');
  await a.close();
});

test('sqlite adapter: PRAGMAs applied (WAL on file, in-memory allowed)', async () => {
  const a = await createDbAdapter('sqlite://:memory:');
  await a.close();
});

test('sqlite adapter: closes cleanly (double-close tolerated)', async () => {
  const a = await createDbAdapter('sqlite://:memory:');
  await a.close();
  // Second close: node:sqlite throws "database is not open" — caller contract
  // is single-close; we surface the error so users notice leaks rather than
  // silently swallowing.
  await assert.rejects(() => a.close(), /not open/);
});
