// todo.write — the agent's task list. State lives in the event store via
// EVENTS.TODO_WRITTEN and is mirrored to .nexus/todo.json so the REPL can
// render it instantly. Zero runtime deps.
import { EVENTS } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ITEMS = 100;

export function todoTools({ dir = process.cwd() } = {}) {
  const file = join(dir, '.nexus', 'todo.json');
  return [
    {
      name: 'todo.write',
      description: 'Write the full task list (replaces the previous one). Items: {content, status: pending|in_progress|done}. Rendered in the UI; snapshot goes to the event store.',
      permission: 'todo.write',
      timeoutMs: 5_000,
      schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            maxItems: MAX_ITEMS,
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', maxLength: 500 },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        if (!Array.isArray(args.todos)) throw new Error('todos must be an array');
        if (args.todos.length > MAX_ITEMS) throw new Error(`max ${MAX_ITEMS} items`);
        for (const [i, t] of args.todos.entries()) {
          if (!t || typeof t.content !== 'string' || !t.content.trim()) throw new Error(`todos[${i}].content required`);
          if (!['pending', 'in_progress', 'done'].includes(t.status)) throw new Error(`todos[${i}].status must be pending|in_progress|done`);
        }
        const todos = args.todos.map((t) => ({ content: t.content.trim(), status: t.status }));
        mkdirSync(join(dir, '.nexus'), { recursive: true });
        writeFileSync(file, JSON.stringify({ updated: Date.now(), todos }, null, 2));
        if (ctx.bus) {
          ctx.bus.emit(makeEvent(EVENTS.TODO_WRITTEN, {
            todos,
            counts: {
              total: todos.length,
              done: todos.filter((t) => t.status === 'done').length,
              in_progress: todos.filter((t) => t.status === 'in_progress').length,
            },
          }, ctx.agentId ?? null));
        }
        return { todos: todos.length, file };
      },
    },
    {
      name: 'todo.read',
      description: 'Read the current task list.',
      permission: 'todo.write',
      timeoutMs: 5_000,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        if (!existsSync(file)) return { todos: [] };
        try {
          const doc = JSON.parse(readFileSync(file, 'utf8'));
          return { todos: Array.isArray(doc.todos) ? doc.todos : [] };
        } catch { return { todos: [] }; }
      },
    },
  ];
}

/** Render the list for the REPL status area. */
export function renderTodos(todos) {
  const icons = { pending: '[ ]', in_progress: '[~]', done: '[x]' };
  return todos.map((t) => `${icons[t.status] ?? '[ ]'} ${t.content}`);
}
