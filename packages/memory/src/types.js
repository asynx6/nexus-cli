// Memory record contract. Three kinds map to plan-nexus.md §10:
// short-term (conversation context, tool results — volatile, per-session),
// long-term (important facts, previous decisions — durable across sessions),
// project (project information, generated artifacts — scoped to a project id).
import { newId } from '@asynx6/nexus-shared';

export const MemoryKind = Object.freeze({
  SHORT: 'short',
  LONG: 'long',
  PROJECT: 'project',
});

/** Frozen record shape: { id, kind, key, value, subject, ts, meta }. */
export function isMemoryRecord(r) {
  return !!r && typeof r === 'object'
    && typeof r.id === 'string' && r.id.length > 0
    && Object.values(MemoryKind).includes(r.kind)
    && typeof r.key === 'string' && r.key.length > 0
    && Object.prototype.hasOwnProperty.call(r, 'value')
    && (r.subject === null || typeof r.subject === 'string')
    && typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts))
    && !!r.meta && typeof r.meta === 'object'
    && !Array.isArray(r.meta);
}

/**
 * Build a well-formed memory record.
 * @param {keyof typeof MemoryKind} kind
 * @param {string} key        lookup key, e.g. 'conversation:current' or 'fact:db-url'
 * @param {unknown} value     arbitrary JSON-serialisable payload
 * @param {{ subject?: string|null, meta?: Record<string, unknown>, id?: string, ts?: string }} [opts]
 */
export function makeMemory(kind, key, value, opts = {}) {
  if (!Object.values(MemoryKind).includes(kind)) {
    throw new TypeError(`invalid memory kind "${kind}"`);
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('memory key must be a non-empty string');
  }
  const rec = {
    id: opts.id ?? newId('mem'),
    kind,
    key,
    value,
    subject: opts.subject ?? null,
    ts: opts.ts ?? new Date().toISOString(),
    meta: opts.meta ?? {},
  };
  if (!isMemoryRecord(rec)) throw new TypeError('constructed record failed isMemoryRecord');
  return rec;
}
