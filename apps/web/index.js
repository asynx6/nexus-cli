// @asynx6/web — facade (ARCHITECTURE.md rule 4): export contracts only.
// Server entry point lives in ./src/server.js; the static page in ./public/index.html.
export const NAME = '@asynx6/web';
export const DEFAULT_PORT = 3300;
export { createServer } from './src/server.js';