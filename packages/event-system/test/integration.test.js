import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/bus.js';
import { EventStore } from '../src/store.js';
import { makeEvent } from '../src/events.js';
import { EVENTS } from '@asynx6/nexus-shared';

test('bus fan-out: live listeners + durable store, then replay matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-int-'));
  const bus = new EventBus();
  const store = new EventStore(join(dir, 'events.jsonl'));
  try {
    bus.on('*', (e) => store.append(e));
    const live = [];
    bus.on(EVENTS.AGENT_TOOL_CALLED, (e) => live.push(e));
    const script = [
      [EVENTS.AGENT_CREATED, { name: 'fib-runner' }, 'agent-fib'],
      [EVENTS.SANDBOX_CREATED, { image: 'python:3.12-slim' }, 'sandbox-1'],
      [EVENTS.AGENT_TOOL_CALLED, { tool: 'file.write', path: 'main.py' }, 'agent-fib'],
      [EVENTS.AGENT_TOOL_FINISHED, { tool: 'file.write', ok: true }, 'agent-fib'],
      [EVENTS.AGENT_TOOL_CALLED, { tool: 'terminal.exec', cmd: 'python main.py' }, 'agent-fib'],
      [EVENTS.AGENT_TOOL_FINISHED, { tool: 'terminal.exec', code: 0, stdout: '55' }, 'agent-fib'],
      [EVENTS.TASK_COMPLETED, { result: 55 }, 'task-fib'],
    ];
    script.forEach(([name, data, subject]) => bus.emit(makeEvent(name, data, subject)));
    assert.strictEqual(live.length, 2);
    const replayed = [...store.replay()];
    assert.strictEqual(replayed.length, script.length);
    assert.deepStrictEqual(replayed.map((e) => e.name), script.map(([n]) => n));
    assert.strictEqual(replayed.at(-1).data.result, 55);
    // tool-call inspection via name cursor
    const execs = [...store.replay({ name: EVENTS.AGENT_TOOL_CALLED })];
    assert.strictEqual(execs.length, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
