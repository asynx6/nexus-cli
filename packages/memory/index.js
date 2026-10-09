// @asynx6/memory — short/long/project memory abstraction with pluggable storage.
// Contracts (ARCHITECTURE.md rule 4): this index.js exports ONLY interfaces and
// types — concrete storage backends live in ./src/storages.js.
export { NAME } from './src/constants.js';
export {
  MemoryKind,
  isMemoryRecord,
  makeMemory,
} from './src/types.js';
export { MemoryManager } from './src/manager.js';
export { JsonlStorage, MemoryStorage } from './src/storages.js';
export { EventRecall, openEventRecall } from './src/event-recall.js';
