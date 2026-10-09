// Audit trail: every permission decision becomes an event on the EventBus
// (plan sec 6: "Setiap tool invocation harus dapat menghasilkan audit event").
// Uses the approved custom-type convention (dot.separated_kind), security.* namespace.
import { makeEvent } from '@asynx6/nexus-event-system';

const SECRET_RE = /(token|secret|password|passwd|api[-_]?key|authorization)/i;
// a secret-looking ASSIGNMENT line: "password: x", "api_key=y", "Bearer xyz"
const SECRET_LINE_RE = /^\s*(token|secret|password|passwd|api[-_]?key|authorization)\b\s*[:=]\s*\S+/i;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/;

function redactString(s) {
  // multi-line text (file output): redact assignment lines + bearer tokens in place
  if (s.includes('\n')) {
    return s
      .split('\n')
      .map((line) => {
        let out = line;
        if (SECRET_LINE_RE.test(line)) out = line.replace(/^(\s*\S+\s*[:=]\s*).*/, '$1[redacted]');
        out = out.replace(BEARER_RE, '$1 [redacted]');
        return out;
      })
      .join('\n');
  }
  // single short line that IS a secret value -> whole string redacted
  if (s.length <= 200 && SECRET_RE.test(s)) return '[redacted]';
  return s.replace(BEARER_RE, '$1 [redacted]');
}

export function redact(obj) {
  if (obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' ? redactString(obj) : obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_RE.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

export class AuditTrail {
  #bus;
  #runId;

  /**
   * @param {{ bus: import('@asynx6/nexus-event-system').EventBus, runId: string }} opts
   */
  constructor({ bus, runId }) {
    if (!bus || typeof bus.emit !== 'function') throw new TypeError('bus with emit required');
    if (typeof runId !== 'string' || !runId) throw new TypeError('runId required');
    this.#bus = bus;
    this.#runId = runId;
  }

  /** Log one PermissionManager.check() decision. Returns the stored event. */
  logDecision(decision) {
    if (!decision || typeof decision.allowed !== 'boolean') {
      throw new TypeError('decision must come from PermissionManager.check()');
    }
    const ev = makeEvent('security.permission_checked', {
      agentId: decision.agentId,
      tool: decision.tool,
      allowed: decision.allowed,
      reason: decision.reason,
      args: redact(decision.args),
    }, this.#runId);
    this.#bus.emit(ev);
    return ev;
  }

  /** Log a security-relevant occurrence that is not a decision (e.g. secret access). */
  logEvent(type, payload = {}) {
    const ev = makeEvent(type, redact(payload), this.#runId);
    this.#bus.emit(ev);
    return ev;
  }
}
