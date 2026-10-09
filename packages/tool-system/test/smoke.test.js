import { test } from 'node:test';
import assert from 'node:assert';
import { NAME, ToolRegistry, ToolExecutor, fsTools, terminalTools, todoTools, webTools, repoMapTools } from '../index.js';

test('tool-system facade exports', () => {
  assert.strictEqual(NAME, '@nexus/tool-system');
  assert.strictEqual(typeof ToolRegistry, 'function');
  assert.strictEqual(typeof ToolExecutor, 'function');
  assert.strictEqual(fsTools().length, 8);
  assert.strictEqual(terminalTools().length, 3);
  assert.strictEqual(todoTools().length, 2);
  assert.strictEqual(webTools().length, 1);
  assert.strictEqual(repoMapTools().length, 1);
});

test('built-in tools pass their own definition rules', () => {
  const r = new ToolRegistry();
  for (const t of [...fsTools(), ...terminalTools(), ...todoTools(), ...webTools(), ...repoMapTools()]) r.register(t);
  assert.deepStrictEqual(r.list().map((t) => t.name), [
    'fs.read', 'fs.write', 'fs.edit', 'fs.download', 'fs.upload', 'fs.glob', 'fs.grep', 'fs.list',
    'terminal.exec', 'terminal.output', 'terminal.kill',
    'todo.write', 'todo.read', 'web.fetch', 'repo.map',
  ]);
});
