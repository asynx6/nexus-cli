// @asynx6/prompts — named system-prompt registry with content-addressed
// versioning (A4). Public facade only (ARCHITECTURE.md rule 4).
export const NAME = '@asynx6/nexus-prompts';
export { PromptRegistry } from './src/registry.js';
export { sha256Hex } from './src/hash.js';
export { DEFAULT_PROMPTS, seedDefaults, renderCliDefault } from './src/defaults.js';
