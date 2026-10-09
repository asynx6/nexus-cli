// @asynx6/web — minimal web dashboard.
// Issue #18: 1 file HTML inline script + tiny HTTP server. Port 3300.
// Live: list recent runs (grouped by subject from EventStore) + per-run timeline + payload JSON.
// Auth via SecretStore: token env var name passed at construction; SecretStore.value loaded at startup.
//
// All routes are pure JSON or static HTML. No framework, no build step.
import { createServer as httpCreateServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from '@asynx6/nexus-event-system';
import { SecretStore } from '@asynx6/nexus-security';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const DEFAULT_PORT = 3300;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * @param {{ port?: number,
 *           host?: string,
 *           storePath?: string,
 *           tokenEnvVar?: string|null,
 *           publicDir?: string,
 *           logger?: { log:Function, warn:Function, error:Function } }} [opts]
 *
 * - port: TCP port (default 3300). Can be 0 for tests.
 * - host: bind host (default '127.0.0.1')
 * - storePath: JSONL event store file (default './nexus-events.jsonl')
 * - tokenEnvVar: name of an env var whose VALUE is the bearer token (default 'NEXUS_WEB_TOKEN').
 *                Pass null/false to disable auth (dev only).
 * - publicDir: static dir (default apps/web/public).
 */
export async function createServer(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? '127.0.0.1';
  const publicDir = opts.publicDir ?? PUBLIC_DIR;
  const logger = opts.logger ?? console;

  const store = new EventStore(opts.storePath ?? './nexus-events.jsonl');

  const secrets = new SecretStore();
  let authEnabled = false;
  const tokenEnvVar = opts.tokenEnvVar === undefined ? 'NEXUS_WEB_TOKEN' : opts.tokenEnvVar;
  if (tokenEnvVar && typeof tokenEnvVar === 'string') {
    const v = process.env[tokenEnvVar];
    if (typeof v === 'string' && v.length > 0) {
      secrets.set('NEXUS_WEB_TOKEN', v);
      authEnabled = true;
      logger.log?.(`[nexus-web] auth enabled via SecretStore(${tokenEnvVar})`);
    } else {
      logger.warn?.(`[nexus-web] tokenEnvVar "${tokenEnvVar}" missing/empty — auth DISABLED`);
    }
  }

  const server = httpCreateServer(async (req, res) => {
    try {
      await handle(req, res, { publicDir, store, secrets, authEnabled, logger });
    } catch (err) {
      logger.error?.(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
  const addr = server.address();
  return {
    server,
    address: addr,
    port: typeof addr === 'object' && addr ? addr.port : port,
    host: typeof addr === 'object' && addr ? addr.address : host,
    close: () => new Promise((r) => { server.close(() => { try { store.close(); } catch {} r(); }); }),
    authEnabled,
  };
}

/* ---------- handler ---------- */

async function handle(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method ?? 'GET';

  // auth gate — only API routes need a token; static HTML/assets are public so
  // the user can load the login page in a fresh browser.
  if (ctx.authEnabled && url.pathname.startsWith('/api/')) {
    const auth = req.headers.authorization;
    const ok = typeof auth === 'string' && auth.startsWith('Bearer ')
      && ctx.secrets.inject(['NEXUS_WEB_TOKEN']).NEXUS_WEB_TOKEN === auth.slice(7).trim();
    if (!ok) {
      respond(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }
  }

  if (method === 'GET' && url.pathname === '/healthz') {
    respond(res, 200, { ok: true, name: '@asynx6/web', events: ctx.store.count() });
    return;
  }

  // JSON API
  if (method === 'GET' && url.pathname === '/api/runs') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 25);
    respond(res, 200, { runs: await listRuns(ctx.store, limit) });
    return;
  }

  const mEvents = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (method === 'GET' && mEvents) {
    const subject = decodeURIComponent(mEvents[1]);
    const limit = clampInt(url.searchParams.get('limit'), 1, 5000, 500);
    const events = [];
    for (const e of ctx.store.replay({ subject })) {
      events.push(e);
      if (events.length >= limit) break;
    }
    respond(res, 200, { subject, count: events.length, events });
    return;
  }

  const mStream = url.pathname.match(/^\/api\/runs\/([^/]+)\/events\/stream$/);
  if (method === 'GET' && mStream) {
    const subject = decodeURIComponent(mStream[1]);
    streamEvents(req, res, ctx.store, subject);
    return;
  }

  // static file
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    await sendFile(res, join(ctx.publicDir, 'index.html'));
    return;
  }
  if (method === 'GET' && !url.pathname.startsWith('/api/')) {
    // prevent path traversal: must resolve under publicDir
    const target = normalize(join(ctx.publicDir, url.pathname));
    if (target.startsWith(ctx.publicDir + sep) || target === ctx.publicDir) {
      try {
        const s = await stat(target);
        if (s.isFile()) { await sendFile(res, target); return; }
      } catch { /* fallthrough */ }
    }
    respond(res, 404, { error: 'not found' });
    return;
  }

  respond(res, 404, { error: 'not found' });
}

function respond(res, code, body, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders };
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
}

async function sendFile(res, path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  await new Promise((resolvePipe, rejectPipe) => {
    const s = createReadStream(path);
    s.on('error', rejectPipe);
    s.on('end', resolvePipe);
    s.pipe(res, { end: true });
  });
}

/* ---------- data ---------- */

async function listRuns(store, limit) {
  // group by subject, newest-first by last-event ts.
  const map = new Map();
  for (const e of store.replay({})) {
    const subj = e.subject ?? '(none)';
    const cur = map.get(subj);
    if (!cur) {
      map.set(subj, { subject: subj, firstTs: e.ts, lastTs: e.ts, count: 1, lastName: e.name, lastId: e.id });
    } else {
      cur.count++;
      if (e.ts > cur.lastTs) { cur.lastTs = e.ts; cur.lastName = e.name; cur.lastId = e.id; }
      if (e.ts < cur.firstTs) cur.firstTs = e.ts;
    }
  }
  const out = [...map.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
  return out.slice(0, limit);
}

function streamEvents(req, res, store, subject) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let lastTs = '';
  const sinceParam = new URL(req.url, 'http://x').searchParams.get('since');
  if (sinceParam) lastTs = sinceParam;

  let closed = false;
  const onClose = () => { closed = true; };
  req.on('close', onClose);

  const tick = () => {
    if (closed) return;
    const filter = { subject };
    if (lastTs) filter.since = lastTs;
    let n = 0;
    for (const e of store.replay(filter)) {
      const data = JSON.stringify(e);
      res.write(`event: ${e.name.replace(/\./g, '-')}\ndata: ${data}\n\n`);
      if (e.ts > lastTs) lastTs = e.ts;
      n++;
      if (n >= 200) break;
    }
    setTimeout(tick, 1000);
  };
  tick();
}

function clampInt(raw, min, max, dflt) {
  if (raw === null || raw === undefined) return dflt;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}