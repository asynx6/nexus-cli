// @asynx6/shared — cross-package contracts. This is the ONLY place shared
// shapes live (ARCHITECTURE.md rule 1). Other packages import down, never up.
export const NAME = '@asynx6/nexus-shared';

export { EVENTS, EVENT_SCHEMA_VERSION } from './events.js';
export { newAgentId, newSandboxId, newTaskId, newEventId, newId } from './ids.js';
export { loadEnv } from './env.js';
export { makeLogger } from './log.js';
export { DEFAULT_GATEWAY_BASE } from './gateway.js';
