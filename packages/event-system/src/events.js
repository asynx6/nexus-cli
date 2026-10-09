// Contract glue only — the event envelope and taxonomy live in @asynx6/shared
// (ARCHITECTURE.md rule 1: shared is the single source of contracts).
// This module adds nothing to the shape; it just wraps construction so callers
// get a frozen-envelope event with an id/ts defaulted.
import { EVENTS, EVENT_SCHEMA_VERSION, newEventId } from '@asynx6/nexus-shared';

/** Frozen envelope shape: { id, ts, name, subject, data } (+ seq assigned by the store). */
export function isEnvelope(e) {
  return !!e && typeof e === 'object'
    && typeof e.id === 'string' && e.id.length > 0
    && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts))
    && typeof e.name === 'string' && e.name.includes('.')
    && (e.subject === null || typeof e.subject === 'string')
    && !!e.data && typeof e.data === 'object';
}

/**
 * Build a well-formed event from the shared taxonomy. Custom dot.separated
 * names are allowed (escape hatch); canonical ones come from EVENTS.
 * `seq` is assigned by the store on append.
 * @param {string} name  one of Object.values(EVENTS) or custom `ns.kind`
 * @param {Record<string, unknown>} [data]
 * @param {string|null} [subject] primary entity id (agent-…/sandbox-…/task-…)
 * @param {{ id?: string, ts?: string }} [meta]
 */
export function makeEvent(name, data = {}, subject = null, meta = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('event name must be a non-empty string');
  }
  if (!Object.values(EVENTS).includes(name) && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) {
    throw new TypeError(`invalid event name "${name}" (expected EVENTS value or dot.separated)`);
  }
  if (subject !== null && typeof subject !== 'string') {
    throw new TypeError('subject must be a string or null');
  }
  return {
    id: meta.id ?? newEventId(),
    ts: meta.ts ?? new Date().toISOString(),
    name,
    subject,
    data,
  };
}

export { EVENTS, EVENT_SCHEMA_VERSION };
