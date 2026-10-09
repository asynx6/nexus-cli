// HTTP handlers for the webhook registry (TASK-LEONARS-D2):
//   GET    /webhooks                 -> list registrations (secrets never sent)
//   POST   /webhooks                 -> 201 + {id}  (url + optional events[] + secret)
//   GET    /webhooks/:id             -> 200 | 404
//   PATCH  /webhooks/:id             -> 200 | 404  (url/events/secret/description/paused)
//   DELETE /webhooks/:id             -> 204 | 404
//   POST   /webhooks/:id/test        -> 202  emit a synthetic webhook.test event
//   GET    /webhooks/:id/deliveries  -> delivery counters (no bodies)
//
// Secret handling: the signing secret is accepted on write, stored only in
// memory (SecretStore isolation), and never echoed back. The API token gate
// (auth.js) still applies; webhook secrets are a separate concern.

import { sendJson } from './router.js';
import { validateTarget } from './webhooks.js';

const EVENTS_TOO_BIG = 'events filter must be an array of strings or null';

function isStr(v) { return typeof v === 'string' && v.length > 0; }

/**
 * @param {{ registry, secrets, engine, bus, logger }} deps
 */
export function makeWebhookHandlers(deps) {
  const { registry, secrets, engine, logger } = deps;
  if (!registry) throw new TypeError('registry required');
  if (!secrets) throw new TypeError('secrets required');

  /** Secret name per webhook: NEXUS_WEBHOOK_SECRET_<UPPER_ID>. */
  function secretName(id) { return 'NEXUS_WEBHOOK_SECRET_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_'); }

  return {
    listWebhooks(ctx) {
      sendJson(ctx.res, 200, { webhooks: registry.list() });
    },

    async createWebhook(ctx) {
      const b = ctx.body ?? {};
      if (!isStr(b.url)) {
        return sendJson(ctx.res, 400, { error: 'bad_request', message: 'url (absolute http(s) string) required' });
      }
      let events = null;
      if (b.events !== null && b.events !== undefined) {
        if (!Array.isArray(b.events) || b.events.some((e) => typeof e !== 'string' || !e.includes('.'))) {
          return sendJson(ctx.res, 400, { error: 'bad_request', message: EVENTS_TOO_BIG });
        }
        events = b.events.map((e) => e.trim()).filter(Boolean);
      }
      try { validateTarget(b.url, { allowLoopback: process.env.NEXUS_WEBHOOK_ALLOW_LOOPBACK === '1' }); }
      catch (e) { return sendJson(ctx.res, 400, { error: 'bad_request', message: e.message }); }

      const secret = isStr(b.secret) ? b.secret : null;
      const wh = registry.add({
        url: b.url, events, secret,
        description: typeof b.description === 'string' ? b.description : null,
      });
      if (secret) secrets.set(secretName(wh.id), secret);
      logger?.info?.('webhook registered', { id: wh.id, url: wh.url, filtered: events !== null });
      sendJson(ctx.res, 201, { id: wh.id, ...wh.snapshot() });
    },

    getWebhook(ctx) {
      const wh = registry.get(ctx.params.id);
      if (!wh) return sendJson(ctx.res, 404, { error: 'not_found' });
      sendJson(ctx.res, 200, wh.snapshot());
    },

    async updateWebhook(ctx) {
      const wh = registry.get(ctx.params.id);
      if (!wh) return sendJson(ctx.res, 404, { error: 'not_found' });
      const b = ctx.body ?? {};
      if (b.url !== undefined) {
        if (!isStr(b.url)) return sendJson(ctx.res, 400, { error: 'bad_request', message: 'url must be a string' });
        try { validateTarget(b.url, { allowLoopback: process.env.NEXUS_WEBHOOK_ALLOW_LOOPBACK === '1' }); }
        catch (e) { return sendJson(ctx.res, 400, { error: 'bad_request', message: e.message }); }
      }
      if (b.events !== null && b.events !== undefined) {
        if (!Array.isArray(b.events) || b.events.some((e) => typeof e !== 'string' || !e.includes('.'))) {
          return sendJson(ctx.res, 400, { error: 'bad_request', message: EVENTS_TOO_BIG });
        }
      }
      if (b.secret !== undefined && b.secret !== null && !isStr(b.secret)) {
        return sendJson(ctx.res, 400, { error: 'bad_request', message: 'secret must be a non-empty string' });
      }
      const updated = registry.update(ctx.params.id, b);
      if (b.secret !== undefined) {
        const name = secretName(wh.id);
        if (b.secret === null) secrets.delete(name);
        else secrets.set(name, b.secret);
      }
      logger?.info?.('webhook updated', { id: wh.id });
      sendJson(ctx.res, 200, updated.snapshot());
    },

    deleteWebhook(ctx) {
      const wh = registry.get(ctx.params.id);
      if (!wh) return sendJson(ctx.res, 404, { error: 'not_found' });
      secrets.delete(secretName(wh.id));
      registry.remove(ctx.params.id);
      logger?.info?.('webhook deleted', { id: ctx.params.id });
      ctx.res.writeHead(204);
      ctx.res.end();
    },

    /** Emit a synthetic event so the owner can verify the pipe end-to-end. */
    async testWebhook(ctx) {
      const wh = registry.get(ctx.params.id);
      if (!wh) return sendJson(ctx.res, 404, { error: 'not_found' });
      const { makeEvent } = await import('@asynx6/nexus-event-system');
      const ev = makeEvent('webhook.test', { webhookId: wh.id, url: wh.url, at: new Date().toISOString() }, null);
      deps.bus.emit(ev);
      sendJson(ctx.res, 202, { id: wh.id, eventId: ev.id, status: 'sent' });
    },

    getDeliveries(ctx) {
      const wh = registry.get(ctx.params.id);
      if (!wh) return sendJson(ctx.res, 404, { error: 'not_found' });
      const snap = wh.snapshot();
      sendJson(ctx.res, 200, {
        id: snap.id, delivered: snap.delivered, failed: snap.failed,
        lastStatus: snap.lastStatus, lastError: snap.lastError, lastDeliveredId: snap.lastDeliveredId,
        engine: engine ? engine.stats() : null,
      });
    },
  };
}
