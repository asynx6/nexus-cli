// @asynx6/event-system replay-server — tiny static HTTP server for the
// browser-based event timeline UI. Zero deps (Node http + fs + path only).
//
// Endpoints:
//   GET  /                          -> public/index.html (or directory listing fallback)
//   GET  /<file>                    -> static file from publicDir (whitelisted extensions)
//   GET  /api/events?subject=&since=&limit=&follow=1
//       -> JSON array of events; with follow=1, server-sent events stream (text/event-stream)
//   GET  /api/events/raw           -> newline-delimited JSON of all stored events
//   GET  /api/healthz              -> { ok: true, count, since }
//   GET  /api/ping                 -> pong
//   GET  /api/subjects             -> [{ subject, count, last }] distinct runs (diff picker)
//   GET  /api/diff?left=&right=&limit=N
//       -> { left, right, summary, ops } run-to-run diff (TASK-LEONARS-B3)
//
// Construction:
//   const { createReplayServer } = require('./replay-server.js');
//   const srv = createReplayServer({ store, publicDir, host, port });
//   await srv.listen();
//   await srv.close();
//
// `store` must expose an async iterable replay({ subject, since, limit }) plus
// count() — EventStore satisfies this directly.
import { createServer } from 'node:http';
import { statSync, createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { diffRuns, summarize } from './src/diff.js';

const STATIC_EXTS = new Set(['.html', '.js', '.css', '.svg', '.png', '.ico', '.json', '.txt', '.map']);
const MAX_BODY = 1 << 20; // 1 MiB cap on request lines; we never accept bodies anyway

const DEFAULT_DIFF_LIMIT = 20000;

/** Read up to `limit` events of one subject (subject-filtered, seq order). */
function readRun(store, subject, limit) {
  const out = [];
  for (const env of store.replay({ subject, limit })) {
    out.push(env);
    if (out.length >= limit) break;
  }
  return out;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

/** Parse a URL search string into an object. Duplicate keys collapse to last value. */
export function parseSearch(url) {
  const q = url.indexOf('?');
  if (q === -1) return {};
  const out = {};
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch { /* ignore malformed */ }
  }
  return out;
}

/** Route a single HTTP request. Exported for unit tests. */
export async function handle(req, res, { store, publicDir, closeHooks = new Set() } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'allow': 'GET, HEAD', 'content-type': 'text/plain' }, 'method not allowed');
  }
  const path = (req.url || '/').split('?')[0] || '/';
  const q = parseSearch(req.url || '/');

  if (path === '/api/subjects') {
    // distinct subject ids for the diff picker (TASK-LEONARS-B3)
    const seen = new Map();
    for await (const env of store.replay({ limit: DEFAULT_DIFF_LIMIT })) {
      if (env.subject == null) continue;
      if (!seen.has(env.subject)) seen.set(env.subject, { subject: env.subject, count: 0, last: env.seq ?? 0 });
      const rec = seen.get(env.subject);
      rec.count += 1;
      rec.last = Math.max(rec.last, env.seq ?? 0);
    }
    return json(res, 200, [...seen.values()].sort((x, y) => y.last - x.last));
  }

  if (path === '/api/healthz') {
    return json(res, 200, { ok: true, count: store.count(), since: q.since ?? null });
  }
  // Kubernetes-style split: liveness proves the process answers; readiness
  // proves it can serve real requests (store open + configured). Orchestrators
  // should only route traffic when /ready is 200.
  if (path === '/live') return json(res, 200, { ok: true });
  if (path === '/ready') {
    try {
      const count = store.count();
      return json(res, 200, { ok: true, count, ready: true });
    } catch (e) {
      return json(res, 503, { ok: false, ready: false, error: String(e.message || e) });
    }
  }
  if (path === '/api/ping') return json(res, 200, { pong: true });

  if (path === '/api/events' || path === '/api/events/') {
    const filter = {};
    if (q.subject) filter.subject = q.subject;
    if (q.since !== undefined) {
      const n = Number(q.since);
      if (Number.isFinite(n)) filter.since = n;
    }
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (Number.isFinite(n)) filter.limit = n;
    }

    if (q.follow === '1' || q.follow === 'true') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
      // exitSignal: resolved when the client goes away or the server closes,
      // so the follow loop never strands a pending timer (which would keep the
      // node event loop alive and hang `npm test`).
      let exited = false;
      const exitSignal = new Promise((resolve) => {
        const done = () => { if (!exited) { exited = true; resolve(); } };
        req.socket.on('close', done);
        req.socket.on('error', done);
        closeHooks.add(done);
        // socket timeout (slowloris guard) also terminates the stream
        req.socket.on('timeout', () => { try { req.socket.destroy(); } catch {} done(); });
      });
      let cursor = filter.since ?? 0;
      try {
        for (;;) {
          const batch = [];
          for await (const env of store.replay({ ...filter, since: cursor })) {
            batch.push(env);
            cursor = (env.seq ?? cursor) + 1;
          }
          for (const env of batch) res.write(`data: ${JSON.stringify(env)}\n\n`);
          if (batch.length === 0) res.write(`: idle\n\n`);
          await Promise.race([new Promise((r) => setTimeout(r, 1000)), exitSignal]);
          if (exited) break;
        }
      } catch (e) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message ?? String(e) })}\n\n`); } catch {}
      } finally {
        clearInterval(ping);
        for (const fn of closeHooks) { try { fn(); } catch {} }
        try { res.end(); } catch {}
      }
      return;
    }
    const out = [];
    for await (const env of store.replay(filter)) out.push(env);
    return json(res, 200, out);
  }

  // TASK-LEONARS-B3: replay diff endpoint, aligned in the browser UI.
  // GET /api/diff?left=SUBJ&right=SUBJ&limit=N -> { left, right, summary, ops }
  if (path === '/api/diff' || path === '/api/diff/') {
    const left = q.left, right = q.right;
    if (!left || !right) return json(res, 400, { error: 'left and right subjects required' });
    const parsedLimit = q.limit === undefined ? DEFAULT_DIFF_LIMIT : Number(q.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_DIFF_LIMIT;
    try {
      const a = readRun(store, left, limit), b = readRun(store, right, limit);
      if (a.length === 0) return json(res, 404, { error: `no events for subject ${left}` });
      if (b.length === 0) return json(res, 404, { error: `no events for subject ${right}` });
      const ops = diffRuns(a, b);
      return json(res, 200, { left, right, summary: summarize(ops), ops });
    } catch (e) {
      return json(res, 500, { error: e?.message ?? String(e) });
    }
  }

  if (path === '/api/events/raw' || path === '/api/events/raw/') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    try {
      for await (const env of store.replay({})) res.write(JSON.stringify(env) + '\n');
    } finally { try { res.end(); } catch {} }
    return;
  }

  // static files
  let rel = path === '/' ? '/index.html' : path;
  if (rel.includes('..')) return send(res, 400, { 'content-type': 'text/plain' }, 'bad path');
  const safe = normalize(rel).replace(/^[/\\]+/, '');
  const root = resolve(publicDir);
  const abs = resolve(join(root, safe));
  // normalize separators so the containment check works on Windows too
  const nAbs = abs.replace(/\\/g, '/');
  const nRoot = root.replace(/\\/g, '/');
  if (!nAbs.startsWith(nRoot + '/') && nAbs !== nRoot) {
    return send(res, 400, { 'content-type': 'text/plain' }, 'bad path');
  }
  const ext = extname(abs).toLowerCase();
  if (!STATIC_EXTS.has(ext)) return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.txt':  'text/plain; charset=utf-8',
    '.map':  'application/json; charset=utf-8',
  };
  if (req.method === 'HEAD') return send(res, 200, { 'content-type': types[ext] ?? 'application/octet-stream', 'content-length': statSync(abs).size }, '');
  res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'content-length': statSync(abs).size });
  createReadStream(abs).pipe(res);
  return undefined;
}

/** Create a running http.Server bound to {host, port}. */
export function createReplayServer({ store, publicDir, host = '127.0.0.1', port = 9090 } = {}) {
  if (!store) throw new TypeError('store required');
  if (!publicDir) throw new TypeError('publicDir required');
  // follow-loop exit registrations; fired on server close so no SSE handler
  // strands a pending timer and keeps the event loop alive.
  const closeHooks = new Set();
  const server = createServer((req, res) => {
    // guard against slowloris-style stalls
    req.socket.setTimeout(60_000);
    handle(req, res, { store, publicDir, closeHooks }).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err?.message ?? String(err) });
      else try { res.end(); } catch {}
    });
  });
  return {
    server,
    host, port,
    listen() {
      return new Promise((resolveFn, reject) => {
        const onErr = (e) => reject(e);
        server.once('error', onErr);
        server.listen(port, host, () => { server.off('error', onErr); resolveFn(server.address()); });
      });
    },
    close() {
      return new Promise((resolveFn, reject) => {
        for (const fn of closeHooks) { try { fn(); } catch {} }
        server.close((e) => e ? reject(e) : resolveFn());
      });
    },
  };
}
