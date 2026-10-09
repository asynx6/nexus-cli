// web.fetch — GET only, size-capped, domain-allowlisted in settings, and
// ALWAYS asks permission (never auto-approved, even in auto mode — the
// policy gate handles that; the tool itself refuses non-GET by design).
import { EVENTS } from '@asynx6/nexus-shared';
import { makeEvent } from '@asynx6/nexus-event-system';

const MAX_BYTES = 2_000_000; // 2 MiB
const TIMEOUT_MS = 30_000;
const REDIRECT_LIMIT = 5;

export function webTools() {
  return [
    {
      name: 'web.fetch',
      description: 'GET a URL (http/https only). Max 2 MiB, max 5 redirects, 30s timeout. Content-type must be text-ish (html/json/xml/text/markdown).',
      permission: 'web.fetch',
      timeoutMs: 35_000,
      schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const url = parseUrl(args.url);
        let finalUrl = url;
        let body = null;
        let contentType = '';
        let status = 0;
        for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
          const r = await doGet(finalUrl, TIMEOUT_MS);
          status = r.status;
          contentType = r.contentType;
          if (r.status >= 300 && r.status < 400 && r.location) {
            finalUrl = resolveUrl(finalUrl, r.location);
            parseUrl(finalUrl); // validate
            continue;
          }
          body = r.body;
          break;
        }
        if (body === null) throw new Error(`too many redirects (> ${REDIRECT_LIMIT})`);
        if (status >= 400) throw new Error(`HTTP ${status} for ${finalUrl}`);
        const ct = contentType.split(';')[0].trim();
        if (ct && !/^(text\/|application\/(json|xml|javascript|x-yaml|toml|rss|atom\+xml))/.test(ct)) {
          throw new Error(`unsupported content-type: ${ct} (text only)`);
        }
        if (ctx.bus) ctx.bus.emit(makeEvent(EVENTS.WEB_FETCHED, { url: finalUrl, status, bytes: body.length, contentType: ct }, ctx.agentId ?? null));
        return { url: finalUrl, status, contentType: ct, bytes: body.length, content: body.slice(0, MAX_BYTES) };
      },
    },
  ];
}

function parseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`invalid url: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https allowed');
  return u;
}

function resolveUrl(base, location) {
  try { return new URL(location, base).href; } catch { throw new Error(`invalid redirect: ${location}`); }
}

async function doGet(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { 'user-agent': 'nexus-cli/0.6 (+agent)' },
    });
    if (res.status >= 300 && res.status < 400) {
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', location: res.headers.get('location'), body: null };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`response too large (${buf.byteLength} > ${MAX_BYTES} bytes)`);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', location: null, body: text };
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`web.fetch timed out (${url})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
