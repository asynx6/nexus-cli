// @asynx6/api — REST control plane (agents/sandboxes/tasks/events/logs/models)
// public facade: export ONLY contracts here (see docs/ARCHITECTURE.md rule 4)
export const NAME = '@asynx6/nexus-api';
export { buildApp, serve, closeApp } from './src/server.js';
export { TaskStore } from './src/state.js';
export { createRouter, sendJson, safeStringEqual } from './src/router.js';
export { bearerAuth, compose } from './src/auth.js';
export { makeHandlers } from './src/handlers.js';
