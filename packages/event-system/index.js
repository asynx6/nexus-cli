// @asynx6/event-system — EventBus + append-only EventStore (JSONL + node:sqlite index), replay iterator.
// Event contracts come from @asynx6/shared; re-exported here for convenience.
// public facade: export ONLY contracts here (see docs/ARCHITECTURE.md rule 4)
export const NAME = '@asynx6/nexus-event-system';
export { EVENTS, EVENT_SCHEMA_VERSION, makeEvent, isEnvelope } from './src/events.js';
export { EventBus } from './src/bus.js';
export { EventStore } from './src/store.js';
export { compact, snapshot } from './src/snapshot.js';
export { diffRuns, diffPayload, keyFor, summarize } from './src/diff.js';

// Optional DB adapters (D3): SQLite default, PG/MySQL/Mongo via NEXUS_DB_URL.
// Driver modules are loaded lazily — installing optional deps is opt-in.
export {
  createDbAdapter,
  parseDbUrl,
  listSupportedSchemes,
} from './src/db/factory.js';
