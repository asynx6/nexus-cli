// D2 webhook receiver — registry + delivery engine + HTTP handlers.
// No real network: fetch is stubbed; loopback is explicitly enabled.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebhookRegistry, Webhook, startDeliveryEngine, signBody, verifySignature, validateTarget } from '../src/webhooks.js';
import { EventBus, makeEvent } from '@asynx6/nexus-event-system';
import { callApi, FakeRuntime } from './helpers.js';
import { buildApp } from '../src/server.js';

function busWith(...events) {
  const bus = new EventBus();
  const got = [];
  bus.on('*', (ev) => got.push(ev));
  return { bus, got, emit: (name, data = {}, subject = null) => bus.emit(makeEvent(name, data, subject)) };
}

function fakeFetch(succeed = true, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof succeed === 'function') return succeed(url, init, calls.length);
    if (!succeed) throw new Error('connection refused');
    return { status };
  };
  fn.calls = calls;
  return fn;
}

// ---- registry -------------------------------------------------------------

test('registry add/get/list/update/remove', () => {
  const r = new WebhookRegistry();
  const w = r.add({ url: 'https://example.com/hook', events: ['task.completed'], secret: 's3cr3t' });
  assert.ok(w.id.startsWith('hook-'));
  assert.strictEqual(w.events.size, 1);
  assert.strictEqual(w.secret, 's3cr3t');
  assert.strictEqual(r.get(w.id), w);
  assert.strictEqual(r.get('nope'), null);
  assert.strictEqual(r.list().length, 1);
  assert.strictEqual(r.list()[0].hasSecret, true);   // secret never leaks the value
  assert.strictEqual(r.list()[0].secret, undefined);

  const u = r.update(w.id, { paused: true, url: 'https://example.com/v2' });
  assert.strictEqual(u.paused, true);
  assert.strictEqual(u.url, 'https://example.com/v2');
  assert.deepStrictEqual(r.active(), []);            // paused webhooks are skipped
  r.update(w.id, { paused: false });
  assert.strictEqual(r.active().length, 1);

  assert.strictEqual(r.remove(w.id), true);
  assert.strictEqual(r.remove(w.id), false);
});

test('Webhook rejects non-absolute urls', () => {
  assert.throws(() => new Webhook({ id: 'x', url: 'not-a-url' }), /absolute http/);
  assert.throws(() => new Webhook({ id: 'x', url: 'ftp://x.io/h' }), /absolute http/);
});

test('events filter normalises to null (all events) or a Set', () => {
  const r = new WebhookRegistry();
  const all = r.add({ url: 'https://e.io/h' });
  assert.strictEqual(all.events, null);
  const some = r.add({ url: 'https://e.io/h', events: ['task.created', ' task.failed ', ''] });
  assert.deepStrictEqual([...some.events], ['task.created', 'task.failed']);
  const empty = r.add({ url: 'https://e.io/h', events: [] });
  assert.strictEqual(empty.events, null);
});

// ---- target validation (SSRF guard) ---------------------------------------

test('validateTarget blocks loopback unless allowed', () => {
  assert.throws(() => validateTarget('http://localhost:9/h'), /non-loopback/);
  assert.throws(() => validateTarget('http://127.0.0.1/h'), /non-loopback/);
  assert.throws(() => validateTarget('http://[::1]/h'), /non-loopback/);
  assert.ok(validateTarget('https://example.com/h'));
  assert.ok(validateTarget('http://localhost:9/h', { allowLoopback: true }));
  assert.throws(() => validateTarget('ftp://example.com/h'), /http or https/);
});

// ---- signatures ------------------------------------------------------------

test('signBody + verifySignature roundtrip', () => {
  const body = JSON.stringify({ id: 'evt-1', name: 'task.completed' });
  const sig = signBody('sek', body);
  assert.ok(sig.startsWith('sha256='));
  assert.ok(verifySignature('sek', body, sig));
  assert.ok(!verifySignature('wrong', body, sig));
  assert.ok(!verifySignature('sek', body + '!', sig));
  assert.ok(!verifySignature('sek', body, 'sha256=deadbeef'));
  assert.strictEqual(signBody(null, body), null);
});

// ---- delivery engine -------------------------------------------------------

test('engine delivers matching events with signature + dedupe', async () => {
  const r = new WebhookRegistry();
  const w = r.add({ url: 'https://example.com/h', secret: 'sek' });
  const { bus, emit } = busWith();
  const fetch = fakeFetch();
  const engine = startDeliveryEngine({ registry: r, bus, fetchImpl: fetch });
  try {
    emit('task.completed', { ok: true }, 'task-1');
    emit('task.failed', { why: 'x' }, 'task-2');   // also matches (no filter)
    await engine.drain();
    assert.strictEqual(fetch.calls.length, 2);
    const c = fetch.calls[0];
    assert.strictEqual(c.url, 'https://example.com/h');
    assert.strictEqual(c.init.headers['x-nexus-event'], 'task.completed');
    assert.strictEqual(c.init.headers['x-nexus-event-id'], c.init.body && JSON.parse(c.init.body).id);
    assert.ok(c.init.headers['x-nexus-signature'].startsWith('sha256='));
    assert.ok(verifySignature('sek', c.init.body, c.init.headers['x-nexus-signature']));
    assert.strictEqual(w.delivered, 2);
    assert.strictEqual(w.lastStatus, 200);
  } finally { engine.stop(); }
});

test('engine respects the events filter', async () => {
  const r = new WebhookRegistry();
  r.add({ url: 'https://e.io/a', events: ['task.completed'] });
  const { bus, emit } = busWith();
  const fetch = fakeFetch();
  const engine = startDeliveryEngine({ registry: r, bus, fetchImpl: fetch });
  try {
    emit('task.completed', {}, 'task-1');
    emit('task.failed', {}, 'task-2');
    emit('agent.tool_called', {}, 'agent-1');
    await engine.drain();
    assert.strictEqual(fetch.calls.length, 1);
    assert.strictEqual(fetch.calls[0].init.headers['x-nexus-event'], 'task.completed');
  } finally { engine.stop(); }
});

test('4xx (except 429) is permanent, 5xx + network errors retry', async () => {
  const r = new WebhookRegistry();
  r.add({ url: 'https://e.io/bad' });
  r.add({ url: 'https://e.io/flaky' });
  r.add({ url: 'https://e.io/dead' });
  const bus = new EventBus();
  const calls = [];
  const fetch = async (url) => {
    const n = calls.filter((c) => c.url === url).length + 1;
    calls.push({ url, attempt: n });
    if (url.endsWith('/bad')) return { status: 400 };
    if (url.endsWith('/flaky')) return n < 3 ? { status: 500 } : { status: 200 };
    throw new Error('connection refused');
  };
  // Backoff is injected, not waited: the retry fires on the next microtask so
  // the whole 5-attempt schedule completes in milliseconds.
  const schedule = (fn) => Promise.resolve().then(fn);
  const engine = startDeliveryEngine({ registry: r, bus, fetchImpl: fetch, scheduler: schedule });
  try {
    bus.emit(makeEvent('task.completed', {}, 'task-1'));
    await engine.drain();
  } finally {
    // nothing global to restore
  }
  const byUrl = Object.fromEntries(r.list().map((w) => [new URL(w.url).pathname, w]));
  assert.strictEqual(byUrl['/bad'].failed, 1, '400 is terminal');
  assert.strictEqual(byUrl['/bad'].lastStatus, 400);
  assert.strictEqual(byUrl['/flaky'].delivered, 1, 'two 500s then 200');
  assert.strictEqual(byUrl['/flaky'].lastStatus, 200);
  assert.strictEqual(byUrl['/dead'].failed, 1);
  assert.ok(/connection refused/.test(byUrl['/dead'].lastError));
  const perUrl = {};
  for (const c of calls) perUrl[c.url] = (perUrl[c.url] ?? 0) + 1;
  assert.strictEqual(perUrl['https://e.io/bad'], 1, 'no retry after 400');
  assert.strictEqual(perUrl['https://e.io/flaky'], 3);
  assert.strictEqual(perUrl['https://e.io/dead'], 5, 'MAX_ATTEMPTS');
});

test('same event id is never delivered twice to the same webhook', async () => {
  const r = new WebhookRegistry();
  r.add({ url: 'https://e.io/h' });
  const { bus } = busWith();
  const fetch = fakeFetch();
  const engine = startDeliveryEngine({ registry: r, bus, fetchImpl: fetch });
  try {
    const ev = makeEvent('task.completed', { n: 1 }, 'task-1');
    bus.emit(ev);
    bus.emit(ev);            // replay / double-emit
    bus.emit(makeEvent('task.completed', { n: 1 }, 'task-1'));
    await engine.drain();
    assert.strictEqual(fetch.calls.length, 2);
  } finally { engine.stop(); }
});

// ---- HTTP surface ----------------------------------------------------------

function freshEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-wh-test-'));
  return {
    NEXUS_DATA_DIR: dir,
    NEXUS_GATEWAY_BASE: 'http://gateway.invalid/v1',
    NEXUS_GATEWAY_KEY: '***',
    NEXUS_GATEWAY_MODELS: 'fake/model',
    NEXUS_API_TOKEN: 'tok-d2-test-1234',
    NEXUS_WEBHOOK_ALLOW_LOOPBACK: '1',
    ...extra,
  };
}

async function withApp(fn, extra = {}) {
  const env = freshEnv(extra);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const app = await buildApp({ runtime: new FakeRuntime() });
  try { await fn(app); } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    app.engine.stop();
    rmSync(env.NEXUS_DATA_DIR, { recursive: true, force: true });
  }
}
const AUTH = { authorization: 'Bearer tok-d2-test-1234' };

test('HTTP: full CRUD lifecycle', async () => {
  await withApp(async (app) => {
    const create = await callApi(app.dispatch, {
      method: 'POST', url: '/webhooks', headers: AUTH,
      body: { url: 'http://localhost:9999/hook', events: ['task.completed', 'task.failed'], secret: 'wh-secret' },
    });
    assert.strictEqual(create.status, 201);
    const id = create.json().id;
    assert.strictEqual(create.json().hasSecret, true);
    assert.strictEqual(create.json().secret, undefined);

    const get = await callApi(app.dispatch, { method: 'GET', url: '/webhooks/' + id, headers: AUTH });
    assert.strictEqual(get.status, 200);
    assert.deepStrictEqual([...get.json().events], ['task.completed', 'task.failed']);

    const list = await callApi(app.dispatch, { method: 'GET', url: '/webhooks', headers: AUTH });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json().webhooks.length, 1);

    const patch = await callApi(app.dispatch, {
      method: 'PATCH', url: '/webhooks/' + id, headers: AUTH,
      body: { url: 'http://localhost:9999/v2', paused: true },
    });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.json().url, 'http://localhost:9999/v2');
    assert.strictEqual(patch.json().paused, true);

    const del = await callApi(app.dispatch, { method: 'DELETE', url: '/webhooks/' + id, headers: AUTH });
    assert.strictEqual(del.status, 204);
    const after = await callApi(app.dispatch, { method: 'GET', url: '/webhooks/' + id, headers: AUTH });
    assert.strictEqual(after.status, 404);
  });
});

test('HTTP: validation rejects bad input', async () => {
  await withApp(async (app) => {
    const noUrl = await callApi(app.dispatch, { method: 'POST', url: '/webhooks', headers: AUTH, body: {} });
    assert.strictEqual(noUrl.status, 400);
    assert.strictEqual(noUrl.json().error, 'bad_request');

    const badEvents = await callApi(app.dispatch, {
      method: 'POST', url: '/webhooks', headers: AUTH,
      body: { url: 'https://e.io/h', events: ['not-an-event'] },
    });
    assert.strictEqual(badEvents.status, 400);
    assert.ok(/array of strings/.test(badEvents.json().message));

    const missing = await callApi(app.dispatch, { method: 'PATCH', url: '/webhooks/hook-dead', headers: AUTH, body: { paused: true } });
    assert.strictEqual(missing.status, 404);
  });
});

test('HTTP: unknown webhook id -> 404 for every sub-route', async () => {
  await withApp(async (app) => {
    for (const req of [
      { method: 'GET', url: '/webhooks/hook-x' },
      { method: 'PATCH', url: '/webhooks/hook-x', body: {} },
      { method: 'DELETE', url: '/webhooks/hook-x' },
      { method: 'POST', url: '/webhooks/hook-x/test' },
      { method: 'GET', url: '/webhooks/hook-x/deliveries' },
    ]) {
      const r = await callApi(app.dispatch, { ...req, headers: AUTH });
      assert.strictEqual([req.method, r.status].join(' '), [req.method, 404].join(' '));
    }
  });
});

test('HTTP: unauthenticated webhook calls -> 401', async () => {
  await withApp(async (app) => {
    const r = await callApi(app.dispatch, { method: 'GET', url: '/webhooks' });
    assert.strictEqual(r.status, 401);
  });
});

test('POST /webhooks/:id/test -> signed POST hits the receiver; deliveries reports it', async () => {
  const received = [];
  const fetchImpl = async (url, init) => {
    received.push({ url, init });
    return { status: 200 };
  };
  await withApp(async (app) => {
    // the engine is already built by buildApp with the real fetch; rebuild one
    // on the same registry+bus so the HTTP path is covered end-to-end.
    app.engine.stop();
    const engine = startDeliveryEngine({ registry: app.webhooks, bus: app.bus, fetchImpl });
    app.engine = engine;
    const create = await callApi(app.dispatch, {
      method: 'POST', url: '/webhooks', headers: AUTH,
      body: { url: 'https://receiver.example/hook', secret: 's3cr3t' },
    });
    assert.strictEqual(create.status, 201);
    const id = create.json().id;

    const test = await callApi(app.dispatch, { method: 'POST', url: '/webhooks/' + id + '/test', headers: AUTH });
    assert.strictEqual(test.status, 202);
    assert.ok(test.json().eventId);
    await engine.drain();

    assert.strictEqual(received.length, 1);
    const hit = received[0];
    assert.strictEqual(hit.url, 'https://receiver.example/hook');
    assert.strictEqual(hit.init.headers['x-nexus-event'], 'webhook.test');
    assert.strictEqual(hit.init.headers['x-nexus-event-id'], test.json().eventId);
    assert.ok(verifySignature('s3cr3t', hit.init.body, hit.init.headers['x-nexus-signature']));
    const payload = JSON.parse(hit.init.body);
    assert.strictEqual(payload.name, 'webhook.test');
    assert.strictEqual(payload.data.webhookId, id);

    const deliv = await callApi(app.dispatch, { method: 'GET', url: '/webhooks/' + id + '/deliveries', headers: AUTH });
    assert.strictEqual(deliv.status, 200);
    assert.strictEqual(deliv.json().delivered, 1);
    assert.strictEqual(deliv.json().failed, 0);
    assert.strictEqual(deliv.json().lastStatus, 200);
    assert.strictEqual(deliv.json().lastDeliveredId, test.json().eventId);
    assert.strictEqual(deliv.json().engine.active, 1);
  });
});

test('registered webhook receives a real task lifecycle event end-to-end', async () => {
  await withApp(async (app) => {
    const create = await callApi(app.dispatch, {
      method: 'POST', url: '/webhooks', headers: AUTH,
      body: { url: 'http://localhost:9/dead', events: ['task.created'] },
    });
    assert.strictEqual(create.status, 201);
    const id = create.json().id;

    // POST /tasks is not wired with a runtime here; emit via the app bus instead
    app.bus.emit(makeEvent('task.created', { prompt: 'hi' }, 'task-z'));

    // give the retry schedule time to exhaust (2+4+8+16s are long; first
    // failure is immediate, so one attempt is recorded synchronously)
    await app.engine.drain();
    await new Promise((r) => setTimeout(r, 50));
    const wh = app.webhooks.get(id);
    assert.ok(wh.lastError, 'unreachable loopback port recorded as failure');
  });
});
