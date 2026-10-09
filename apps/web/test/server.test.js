// P11 dashboard tests — server boots on ephemeral port, serves healthz + JSON API + index.html.
// Auth gate: without token → 401 on /api/*; with bearer → 200.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { EventStore } from '@asynx6/nexus-event-system';
import { makeEvent } from '@asynx6/nexus-event-system';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-web-'));
  return { dir, path: join(dir, 'events.jsonl') };
}

async function start({ token, authDisabled = false, storePath } = {}) {
  const opts = { port: 0, host: '127.0.0.1', storePath };
  if (authDisabled) opts.tokenEnvVar = null;
  else if (token) {
    process.env.NEXUS_WEB_TOKEN = token;
    opts.tokenEnvVar = 'NEXUS_WEB_TOKEN';
  } else {
    delete process.env.NEXUS_WEB_TOKEN;
    opts.tokenEnvVar = 'NEXUS_WEB_TOKEN';
  }
  return createServer(opts);
}

function url(srv, path) {
  return `http://${srv.host}:${srv.port}${path}`;
}

test('healthz is open and reports event count', async () => {
  const { dir, path } = tmp();
  try {
    const store = new EventStore(path);
    store.append(makeEvent('task.started', { n: 1 }, 'task-1'));
    store.close();
    const srv = await start({ authDisabled: true, storePath: path });
    try {
      const r = await fetch(url(srv, '/healthz'));
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.name, '@asynx6/web');
      assert.ok(j.events >= 1);
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth: 401 without bearer, 200 with bearer on /api/runs', async () => {
  const { dir, path } = tmp();
  try {
    const srv = await start({ token: 's3cret-token', storePath: path });
    try {
      const r401 = await fetch(url(srv, '/api/runs'));
      assert.strictEqual(r401.status, 401);
      const r200 = await fetch(url(srv, '/api/runs'), { headers: { authorization: 'Bearer s3cret-token' } });
      assert.strictEqual(r200.status, 200);
      const j = await r200.json();
      assert.ok(Array.isArray(j.runs));
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runs list groups by subject and orders newest-first', async () => {
  const { dir, path } = tmp();
  try {
    const store = new EventStore(path);
    store.append(makeEvent('task.started', { n: 1 }, 'task-A', { ts: '2026-09-16T10:00:00.000Z' }));
    store.append(makeEvent('task.started', { n: 1 }, 'task-B', { ts: '2026-09-16T10:00:01.000Z' }));
    store.append(makeEvent('tool.executed', { tool: 'fs.write' }, 'task-A', { ts: '2026-09-16T10:00:02.000Z' }));
    store.append(makeEvent('task.ended', {}, 'task-B', { ts: '2026-09-16T10:00:03.000Z' }));
    store.close();
    const srv = await start({ authDisabled: true, storePath: path });
    try {
      const r = await fetch(url(srv, '/api/runs'));
      const j = await r.json();
      assert.strictEqual(j.runs.length, 2);
      // task-B has latest ts, so it's first.
      assert.strictEqual(j.runs[0].subject, 'task-B');
      assert.strictEqual(j.runs[0].count, 2);
      assert.strictEqual(j.runs[1].subject, 'task-A');
      assert.strictEqual(j.runs[1].count, 2);
      assert.strictEqual(j.runs[1].lastName, 'tool.executed');
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('events endpoint returns subject timeline oldest-first', async () => {
  const { dir, path } = tmp();
  try {
    const store = new EventStore(path);
    store.append(makeEvent('task.started', {}, 'task-A', { ts: '2026-09-16T10:00:00.000Z' }));
    store.append(makeEvent('tool.executed', { i: 1 }, 'task-A', { ts: '2026-09-16T10:00:01.000Z' }));
    store.append(makeEvent('tool.executed', { i: 2 }, 'task-A', { ts: '2026-09-16T10:00:02.000Z' }));
    store.append(makeEvent('other.event', {}, 'task-B', { ts: '2026-09-16T10:00:02.500Z' }));
    store.close();
    const srv = await start({ authDisabled: true, storePath: path });
    try {
      const r = await fetch(url(srv, '/api/runs/task-A/events?limit=10'));
      const j = await r.json();
      assert.strictEqual(j.subject, 'task-A');
      assert.strictEqual(j.count, 3);
      assert.strictEqual(j.events[0].name, 'task.started');
      assert.strictEqual(j.events[2].data.i, 2);
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serves index.html at / and /index.html', async () => {
  const { dir, path } = tmp();
  try {
    const srv = await start({ authDisabled: true, storePath: path });
    try {
      const r = await fetch(url(srv, '/'));
      assert.strictEqual(r.status, 200);
      const ct = r.headers.get('content-type') || '';
      assert.match(ct, /text\/html/);
      const html = await r.text();
      assert.match(html, /NEXUS/);
      assert.match(html, /api\/runs/);
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects path traversal on static files', async () => {
  const { dir, path } = tmp();
  try {
    const srv = await start({ authDisabled: true, storePath: path });
    try {
      const r = await fetch(url(srv, '/../package.json'));
      assert.strictEqual(r.status, 404);
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth: bearer matches via SecretStore (no env direct read in handler)', async () => {
  const { dir, path } = tmp();
  try {
    const srv = await start({ token: 'rotated-9router-key', storePath: path });
    try {
      const r = await fetch(url(srv, '/api/runs?limit=5'),
        { headers: { authorization: 'Bearer rotated-9router-key' } });
      assert.strictEqual(r.status, 200);
      const r2 = await fetch(url(srv, '/api/runs?limit=5'),
        { headers: { authorization: 'Bearer wrong' } });
      assert.strictEqual(r2.status, 401);
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public dir assets: index.html exists on disk and is readable', async () => {
  // Sanity: ensure we didn't ship a broken path.
  const htmlPath = join(import.meta.dirname, '..', 'public', 'index.html');
  assert.ok(existsSync(htmlPath), 'public/index.html must exist on disk');
  const txt = readFileSync(htmlPath, 'utf8');
  assert.ok(txt.includes('<script>'));
  assert.ok(txt.includes('api/runs'));
});