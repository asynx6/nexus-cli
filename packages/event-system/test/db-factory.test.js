// @asynx6/event-system db factory — routing, scheme parsing, SQLite default.
// Pure factory logic only — driver modules are mocked so these tests stay
// dependency-free (no node:sqlite, no pg, no mysql2, no mongodb in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDbAdapter,
  parseDbUrl,
  listSupportedSchemes,
  _registerDriver,
  _drivers,
} from '../src/db/factory.js';

function mockDriver(name) {
  return {
    parseUrl: (u) => ({ scheme: name, _raw: u }),
    factory: () => Promise.resolve({
      driver: name,
      query: async () => [],
      exec: async () => undefined,
      close: async () => undefined,
      _driverName: name,
    }),
  };
}

const realDrivers = { ..._drivers };

function withMockDrivers(fn) {
  for (const s of ['sqlite', 'postgres', 'mysql', 'mongo']) {
    _registerDriver(s, mockDriver(s).factory, mockDriver(s).parseUrl);
  }
  try { return fn(); }
  finally {
    for (const [s, v] of Object.entries(realDrivers)) _registerDriver(s, v.factory, v.parseUrl);
  }
}

test('parseDbUrl: sqlite scheme (default)', () => {
  assert.deepEqual(parseDbUrl('sqlite:./data/events.db'), { scheme: 'sqlite', target: './data/events.db' });
  assert.deepEqual(parseDbUrl('sqlite://:memory:'), { scheme: 'sqlite', target: ':memory:' });
});

test('parseDbUrl: postgres scheme', () => {
  const r = parseDbUrl('postgres://user:pass@host:5432/db');
  assert.equal(r.scheme, 'postgres');
  assert.equal(r.host, 'host');
  assert.equal(r.port, 5432);
  assert.equal(r.database, 'db');
  assert.equal(r.user, 'user');
  assert.equal(r.password, 'pass');
});

test('parseDbUrl: postgresql alias', () => {
  assert.equal(parseDbUrl('postgresql://x/y').scheme, 'postgres');
});

test('parseDbUrl: mysql scheme', () => {
  const r = parseDbUrl('mysql://root@127.0.0.1:3306/nexus');
  assert.equal(r.scheme, 'mysql');
  assert.equal(r.host, '127.0.0.1');
  assert.equal(r.port, 3306);
  assert.equal(r.database, 'nexus');
});

test('parseDbUrl: mongo scheme (mongodb:// and mongodb+srv://)', () => {
  assert.equal(parseDbUrl('mongodb://m.local:27017/events').scheme, 'mongo');
  assert.equal(parseDbUrl('mongodb+srv://cluster.x/events').scheme, 'mongo');
});

test('parseDbUrl: unsupported scheme throws', () => {
  assert.throws(() => parseDbUrl('redis://x'), /unsupported scheme: redis/);
});

test('listSupportedSchemes: returns all four', () => {
  assert.deepEqual(listSupportedSchemes().sort(), ['mongo', 'mysql', 'postgres', 'sqlite']);
});

test('createDbAdapter: defaults to sqlite when url is undefined', async () => {
  await withMockDrivers(async () => {
    const adapter = await createDbAdapter();
    assert.equal(adapter._driverName, 'sqlite');
  });
});

test('createDbAdapter: routes sqlite URL to sqlite driver', async () => {
  await withMockDrivers(async () => {
    const a = await createDbAdapter('sqlite:./x.db');
    assert.equal(a._driverName, 'sqlite');
  });
});

test('createDbAdapter: routes postgres URL to postgres driver', async () => {
  await withMockDrivers(async () => {
    const a = await createDbAdapter('postgres://u:p@h:5432/d');
    assert.equal(a._driverName, 'postgres');
  });
});

test('createDbAdapter: routes mysql URL to mysql driver', async () => {
  await withMockDrivers(async () => {
    const a = await createDbAdapter('mysql://u@h/d');
    assert.equal(a._driverName, 'mysql');
  });
});

test('createDbAdapter: routes mongodb URL to mongo driver', async () => {
  await withMockDrivers(async () => {
    const a = await createDbAdapter('mongodb://h:27017/d');
    assert.equal(a._driverName, 'mongo');
  });
});

test('createDbAdapter: rejects unknown scheme', async () => {
  await withMockDrivers(async () => {
    await assert.rejects(() => createDbAdapter('redis://x'), /unsupported scheme/);
  });
});
