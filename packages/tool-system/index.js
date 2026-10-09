// @asynx6/tool-system — ToolRegistry + filesystem/terminal tools wired through
// permissions + events (plan P05). Public facade only (ARCHITECTURE.md rule 4).
export const NAME = '@asynx6/nexus-tool-system';
export { ToolRegistry } from './src/registry.js';
export { ToolExecutor } from './src/executor.js';
export { validateArgs } from './src/schema.js';
export { fsTools } from './src/tools/fs.js';
export { todoTools, renderTodos } from './src/tools/todo.js';
export { webTools } from './src/tools/web.js';
export { repoMapTools, extractSymbols } from './src/tools/repo-map.js';
export { unifiedDiff, splitLines } from './src/tools/diff.js';
export { Checkpointer } from './src/checkpoint.js';
export { terminalTools } from './src/tools/terminal.js';
export { imageTools } from './src/tools/image.js';

export { autoDiscoverTools, discoverToolFiles, discoverToolPackages } from './src/auto-discover.js';
