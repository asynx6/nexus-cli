// Webhook receiver (TASK-LEONARS-D2): subscribe an HTTP endpoint to the event
// bus and deliver matching events as signed POSTs. Zero deps.
//
// Two sides:
//   1. registry  — CRUD over Webhook objects (id, url, events filter, secret)
//   2. engine    - bus '*' listener -> filter -> HMAC-sign -> POST, with
//                  exponential-backoff retries and a per-attempt timeout.
//
// Design decisions:
//   - delivery is async fire-and-forget; the event log is never blocked by a
//     slow/dead receiver. Failures are recorded on the registration, not in
//     the event store (deliveries are side-effects, not facts).
//   - replay protection is a per-webhook delivered-event-id set: an event is
//     delivered at most once per webhook, even if the bus somehow replays it.
//   - URLs must be absolute http/https to a non-loopback host by default
//     (SSRF guard); pass allowLoopback to permit local testing.
//
// ponytail: retries use setTimeout in-process (no queue on disk). A receiver
// that is down when the process exits loses the retry; add a durable outbox
// table when that becomes a real SLA.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { newId } from '@asynx6/nexus-shared';

const SCHEME = /^https?:\/\//i;
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[?::1\]?)$/i;

const DEFAULT_MAX_ATTEMPTS = 5;   // 1 try + 4 backoffs
const BASE_BACKOFF_MS = 2_000;    // 2s, 4s, 8s, 16s
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DELIVERED_SET = 4_000;  // cap memory; oldest ids age out

export class WebhookRegistry {
  #map = new Map();

  /** Create a subscription. @returns {Webhook} */
  add({ url, events = null, secret = null, description = null }) {
    const wh = new Webhook({ id: newId('hook'), url, events, secret, description });
    this.#map.set(wh.id, wh);
    return wh;
  }

  get(id) { return this.#map.get(id) ?? null; }

  list() { return [...this.#map.values()].map((w) => w.snapshot()); }

  update(id, patch) {
    const wh = this.#map.get(id);
    if (!wh) return null;
    if (patch.url !== undefined) wh.setUrl(patch.url);
    if (patch.events !== undefined) wh.events = normalizeEvents(patch.events);
    if (patch.secret !== undefined) wh.secret = patch.secret;
    if (patch.description !== undefined) wh.description = patch.description;
    if (patch.paused !== undefined) wh.paused = !!patch.paused;
    return wh;
  }

  remove(id) { return this.#map.delete(id); }

  /** Active subscriptions, for the engine to iterate on every event. */
  active() { return [...this.#map.values()].filter((w) => !w.paused); }

  clear() { this.#map.clear(); }
}

export class Webhook {
  constructor({ id, url, events, secret, description }) {
    this.id = id;
    this.setUrl(url);
    this.events = normalizeEvents(events);
    this.secret = typeof secret === 'string' && secret.length > 0 ? secret : null;
    this.description = typeof description === 'string' ? description : null;
    this.paused = false;
    this.delivered = 0;
    this.failed = 0;
    this.lastStatus = null;
    this.lastError = null;
    this.lastDeliveredId = null;
    this.deliveredIds = new Set(); // dedupe: one delivery per event id
  }

  setUrl(url) {
    if (typeof url !== 'string' || !SCHEME.test(url)) {
      throw new TypeError('webhook url must be absolute http(s)://...');
    }
    this.url = url.trim();
  }

  /** Snapshot for API responses (never includes the secret). */
  snapshot() {
    return {
      id: this.id,
      url: this.url,
      events: this.events === null ? null : [...this.events],
      description: this.description,
      paused: this.paused,
      delivered: this.delivered,
      failed: this.failed,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      lastDeliveredId: this.lastDeliveredId,
      hasSecret: this.secret !== null,
    };
  }
}

/**
 * urlMustBePublic — reject loopback/private targets unless explicitly allowed.
 * @param {string} url
 * @param {{ allowLoopback?: boolean }} [opts]
 */
export function validateTarget(url, { allowLoopback = false } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new TypeError('webhook url must be absolute http(s)://...'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new TypeError('webhook url must be http or https');
  }
  const host = u.hostname.toLowerCase();
  if (!allowLoopback && (LOOPBACK.test(host) || host === '')) {
    throw new Error('webhook target must be a non-loopback host (pass allowLoopback for local testing)');
  }
  return true;
}

/** events: null/[] = all; otherwise a Set of names. */
function normalizeEvents(events) {
  if (events === null || events === undefined) return null;
  const arr = Array.isArray(events) ? events : [events];
  const set = new Set(arr.map(String).map((s) => s.trim()).filter(Boolean));
  return set.size > 0 ? set : null;
}

/**
 * HMAC-SHA256 signature of the exact body bytes, in the `sha256=<hex>` form
 * GitHub uses, so receivers can verify with a one-liner.
 */
export function signBody(secret, body) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  if (!secret) return null;
  return 'sha256=' + createHmac('sha256', secret).update(buf).digest('hex');
}

/** Constant-time signature check for the receiving side (used in tests). */
export function verifySignature(secret, body, signature) {
  if (!secret || typeof signature !== 'string') return false;
  const expected = signBody(secret, body);
  if (!expected) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Engine: subscribe a registry to the bus. Every matching, not-yet-delivered
 * event is POSTed to each active webhook with retries.
 *
 * @param {{ registry: WebhookRegistry, bus: { on: (name: string, fn: (ev: any) => void) => () => void },
 *   fetchImpl?: typeof fetch, scheduler?: (fn: () => void, ms: number) => object }} deps
 * @returns {{ stop: () => void, stats: () => object }}
 */
export function startDeliveryEngine({ registry, bus, fetchImpl, scheduler } = {}) {
  if (!registry) throw new TypeError('registry required');
  if (!bus) throw new TypeError('bus required');
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new TypeError('fetch unavailable (Node >= 18)');
  const schedule = scheduler ?? ((fn, ms) => setTimeout(fn, ms));
  const inflight = new Set();

  const off = bus.on('*', (ev) => {
    for (const wh of registry.active()) {
      const key = wh.id + ':' + ev.id;
      if (wh.deliveredIds.has(key)) continue;
      if (wh.events && !wh.events.has(ev.name)) continue;
      wh.deliveredIds.add(key);
      if (wh.deliveredIds.size > MAX_DELIVERED_SET) {
        const first = wh.deliveredIds.values().next().value;
        wh.deliveredIds.delete(first);
      }
      const p = deliver(wh, ev, doFetch, schedule).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });

  async function deliver(wh, ev, doFetch, schedule) {
    const body = JSON.stringify({
      id: ev.id, ts: ev.ts, name: ev.name, subject: ev.subject, data: ev.data,
      signature_hint: 'X-NEXUS-Signature = HMAC-SHA256(secret, raw body), sha256=<hex>',
    });
    const sig = signBody(wh.secret, body);
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'x-nexus-event': ev.name,
      'x-nexus-event-id': ev.id,
    };
    if (sig) headers['x-nexus-signature'] = sig;

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await doFetch(wh.url, {
          method: 'POST', body, headers,
          signal: timeoutSignal(REQUEST_TIMEOUT_MS),
        });
        if (res.status >= 200 && res.status < 300) {
          wh.lastStatus = res.status;   // success recorded last, so it is not
          wh.lastError = null;          // clobbered by a later failed attempt
          wh.delivered++;
          wh.lastDeliveredId = ev.id;
          return;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          wh.lastStatus = res.status;
          wh.failed++;
          wh.lastError = `receiver rejected with ${res.status}`;
          return; // permanent: bad request, auth, gone — retrying is spam
        }
        wh.lastStatus = res.status;
        throw new Error(`unexpected status ${res.status}`); // 5xx/429 -> retry
      } catch (err) {
        if (attempt >= DEFAULT_MAX_ATTEMPTS) {
          wh.failed++;
          wh.lastError = err.message ?? String(err);
          return;
        }
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        await new Promise((r) => schedule(r, backoff));
      }
    }
  }

  return {
    stop() { off(); },
    stats() {
      return {
        active: registry.active().length,
        total: registry.list().length,
        inflight: inflight.size,
      };
    },
    /** Wait for outstanding deliveries (tests / shutdown). */
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    _deliver: deliver,
  };
}

/** Abort after `ms` without a dependency on AbortSignal.timeout (Node >= 17.3). */
function timeoutSignal(ms) {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms).unref?.();
  return ac.signal;
}

export const WEBHOOK_LIMITS = Object.freeze({
  MAX_BODY_BYTES, MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS, BASE_BACKOFF_MS, REQUEST_TIMEOUT_MS,
});
