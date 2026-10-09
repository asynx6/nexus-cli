// Bearer-token auth wired to @asynx6/security SecretStore. The token is
// never logged (P04 secret isolation). On miss we send 401 with a generic
// reason — no details that help an attacker distinguish bad vs missing token.
import { safeStringEqual } from './router.js';

/**
 * @param {{ secrets: import('@asynx6/nexus-security').SecretStore, name?: string }} opts
 *   name: secret name to look up. Default: 'NEXUS_API_TOKEN'.
 */
export function bearerAuth({ secrets, name = 'NEXUS_API_TOKEN' } = {}) {
  if (!secrets) throw new TypeError('secrets (SecretStore) required');
  if (!secrets.has(name)) {
    // No token configured -> auth disabled (dev mode). Caller decides policy.
    return (req, res, next) => next();
  }
  const expected = secrets.inject([name])[name]; // never logged, never persisted
  return (req, res, next) => {
    const h = req.headers['authorization'];
    if (typeof h !== 'string' || !h.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const presented = h.slice('Bearer '.length).trim();
    if (!safeStringEqual(presented, expected)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    next();
  };
}

/** Compose middlewares: run each, stop on response written. */
export function compose(...mw) {
  return (req, res, next) => {
    let i = 0;
    const run = () => {
      if (res.writableEnded) return;
      if (i >= mw.length) return next();
      const m = mw[i++];
      try { m(req, res, run); } catch { /* let the outer handler send 500 */ next(); }
    };
    run();
  };
}
