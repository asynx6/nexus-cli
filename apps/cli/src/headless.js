// Headless mode (Fase 3): `nexus -p "task"` — non-interactive, pipeable.
// --output-format text|json|stream-json, stdin appended to the task,
// --max-turns, --allowed-tools. Exit codes: 0 ok, 1 failure, 2 usage,
// 3 max steps reached.
import { buildRunCtx, closeCtx, AgentLoop } from './ctx.js';
import { newSessionId, recordSession, emitSessionEvents } from './session.js';
import { renderCliDefault } from '@asynx6/nexus-prompts';
import { newAgentId, newTaskId } from '@asynx6/nexus-shared';
import { makeEvent } from '@asynx6/nexus-event-system';

export async function runHeadless({ task, env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, flags = {} }) {
  // accept both streams and console.log/error-style functions
  const out = (m) => (typeof stdout === 'function' ? stdout(m) : stdout.write(m));
  const err = (m) => (typeof stderr === 'function' ? stderr(m) : stderr.write(m));
  if (!task || !task.trim()) {
    err('headless: a task is required (nexus -p "task")');
    return 2;
  }
  const format = flags['output-format'] ?? 'text';
  if (!['text', 'json', 'stream-json'].includes(format)) {
    err(`headless: --output-format must be text|json|stream-json (got ${format})`);
    return 2;
  }
  const modeFlag = flags['permission-mode'] ?? flags.permissionMode;
  if (modeFlag === 'auto' && !flags.dangerouslyAuto && !flags['dangerously-auto']) {
    err('headless: --permission-mode=auto requires --dangerously-auto');
    return 2;
  }

  // stdin: piped input becomes part of the task
  let stdinData = '';
  if (stdin && !stdin.isTTY) {
    stdinData = await new Promise((resolve) => {
      let data = '';
      stdin.setEncoding?.('utf8');
      stdin.on('data', (d) => data += d);
      stdin.on('end', () => resolve(data));
      stdin.on('error', () => resolve(''));
      // already-closed stdin
      if (stdin.readableEnded) resolve('');
      setTimeout(() => resolve(data), 500).unref?.();
    });
  }
  const fullTask = stdinData.trim()
    ? task + '\n\n--- stdin ---\n' + stdinData
    : task;

  const agentId = newAgentId();
  const ctx = await buildRunCtx({
    env, agentId, sandbox: 'host',
    permissionMode: modeFlag ?? 'accept-edits', // headless default: edits ok, no prompt possible
    onAsk: null,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  // --allowed-tools: filter the tool list the model sees (execute stays gated)
  let tools = ctx.tools;
  const allowed = flags['allowed-tools'] ?? flags.allowedTools;
  if (typeof allowed === 'string' && allowed.trim()) {
    const names = new Set(allowed.split(',').map((s) => s.trim().replace(/\./g, '_')).filter(Boolean));
    tools = {
      list: () => ctx.tools.list().filter((t) => names.has(t.name)),
      execute: ctx.tools.execute,
    };
  }

  const systemPrompt = renderCliDefault({
    cwd: process.cwd(), platform: process.platform, date: new Date().toISOString().slice(0, 10),
    sandboxMode: ctx.sandboxMode, tools: tools.list().map((t) => t.name).join(', '),
  });

  const sessionId = newSessionId();
  recordSession('.nexus/store', { id: sessionId, cwd: process.cwd(), subject: fullTask.slice(0, 80) });
  emitSessionEvents(ctx.bus, sessionId, { user: fullTask });

  const taskId = newTaskId();
  await ctx.store.append(makeEvent('task.started', { task: fullTask, taskId, agentId, headless: true }, taskId));

  const maxSteps = Number(flags['max-turns'] ?? flags.maxTurns ?? flags['max-steps'] ?? 16);
  const loop = new AgentLoop({ provider: ctx.provider, tools, bus: ctx.bus });

  const events = [];
  const onEvent = (e) => {
    events.push(e);
    if (format === 'stream-json') out(JSON.stringify(e) + '\n');
  };

  let exitCode = 0;
  let result = null;
  try {
    result = await loop.run(fullTask, {
      agentId,
      sandbox: ctx.sandboxId,
      runtime: ctx.runtime,
      hostRoot: ctx.hostRoot,
      sandboxId: ctx.sandboxId,
      maxSteps,
      env: ctx.env,
      system: systemPrompt,
      onEvent,
    });
    if (result?.done === true) {
      emitSessionEvents(ctx.bus, sessionId, { assistant: result.answer ?? '' });
      await ctx.store.append(makeEvent('task.ended', { taskId, agentId, ok: true, summary: (result.answer ?? '').slice(0, 500) }, taskId));
      if (format === 'text') out(result.answer ?? '');
      if (format === 'json') out(JSON.stringify({ task: fullTask, answer: result.answer, steps: result.steps, session: sessionId }));
      exitCode = 0;
    } else {
      await ctx.store.append(makeEvent('task.ended', { taskId, agentId, ok: false, reason: 'max_steps', steps: result?.steps }, taskId));
      if (format === 'text') err(`headless: stopped at ${result?.steps} steps (max)`);
      if (format === 'json') out(JSON.stringify({ task: fullTask, answer: null, steps: result?.steps, error: 'max_steps', session: sessionId }));
      exitCode = 3;
    }
  } catch (e) {
    await ctx.store.append(makeEvent('task.ended', { taskId, agentId, ok: false, error: String(e?.message ?? e) }, taskId)).catch(() => {});
    if (format === 'text') err(`headless: ${e?.message ?? e}`);
    if (format === 'json') out(JSON.stringify({ task: fullTask, answer: null, error: String(e?.message ?? e), session: sessionId }));
    exitCode = 1;
  } finally {
    await closeCtx(ctx);
  }
  return exitCode;
}
