// terminal.exec — run a command inside the sandbox via SandboxRuntime.exec.
// Secrets (ctx.env) are injected at exec time only (P04 isolation): they
// reach the process environment, never args, events, or disk.
import { EVENTS } from '@asynx6/nexus-shared';
import { makeEvent } from '@asynx6/nexus-event-system';
import { requireSandbox } from './_sandbox.js';
import { hostPath } from '@asynx6/nexus-sandbox-runtime';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MAX_OUTPUT = 30_000; // model-facing cap; full output stays in the event store

function clip(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const head = Math.floor(MAX_OUTPUT * 0.7);
  const tail = MAX_OUTPUT - head;
  return s.slice(0, head) + `\n[... clipped ${s.length - MAX_OUTPUT} chars; full output in event store]\n` + s.slice(-tail);
}

export function terminalTools() {
  return [
    {
      name: 'terminal.exec',
      description: 'Execute a command inside the sandbox. Returns exit code, stdout, stderr.',
      permission: 'terminal.exec',
      timeoutMs: 120_000,
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'program to run (argv style, no shell interpolation unless using sh -c)' },
          args: { type: 'array', items: { type: 'string' } },
          workdir: { type: 'string' },
          timeoutMs: { type: 'integer', description: 'hard cap, defaults to the tool timeout' },
          shell: { type: 'boolean', description: 'run via sh -c (needs stricter permission: always asks)' },
          run_in_background: { type: 'boolean', description: 'start detached; returns a bg_id, poll with terminal.output' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const bus = ctx.bus;
        const subject = ctx.agentId ?? null;

        if (args.run_in_background) {
          const bg = backgroundRegistry();
          const bgId = bg.start(runtime, sandboxId, args, { hostRoot, env: ctx.env });
          if (bus) bus.emit(makeEvent(EVENTS.TERMINAL_STARTED, { command: args.command, background: true, bg_id: bgId, sandboxId }, subject));
          return { background: true, bg_id: bgId, hint: 'poll with terminal.output, stop with terminal.kill' };
        }

        // The model sends a command STRING; runtimes take argv. Tokenize
        // quote-aware (single/double quotes, no shell interpolation).
        // shell:true routes through sh -c — the policy gate asks separately.
        const argv = args.shell
          ? ['sh', '-c', [args.command, ...(args.args ?? [])].join(' ')]
          : (() => { const cmd = [args.command, ...(args.args ?? [])]; return cmd.length === 1 ? tokenizeCommand(cmd[0]) : cmd; })();
        const display = args.shell ? `sh -c ${args.command}` : [args.command, ...(args.args ?? [])].join(' ');
        if (bus) bus.emit(makeEvent(EVENTS.TERMINAL_STARTED, { command: display, sandboxId }, subject));
        const r = await runtime.exec(sandboxId, argv, {
          timeoutMs: Number.isInteger(args.timeoutMs) ? Math.min(args.timeoutMs, 120_000) : undefined,
          workdir: hostRoot && args.workdir && !args.workdir.startsWith('/') ? hostPath(hostRoot, args.workdir) : args.workdir,
          env: ctx.env,
        });
        if (bus) bus.emit(makeEvent(EVENTS.TERMINAL_FINISHED, { command: display, exit_code: r.exitCode, timed_out: r.timedOut }, subject));
        if (r.timedOut) throw new Error(`command timed out (${display})`);
        return { exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr), timedOut: r.timedOut };
      },
    },
    {
      name: 'terminal.output',
      description: 'Read new output of a background terminal (terminal.exec with run_in_background).',
      permission: 'fs.read',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: { bg_id: { type: 'string' }, wait: { type: 'number', description: 'seconds to wait for more output (default 0)' } },
        required: ['bg_id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const bg = backgroundRegistry();
        const info = bg.get(args.bg_id);
        if (!info) throw new Error(`unknown bg_id: ${args.bg_id}`);
        const wait = Math.min(10, Math.max(0, Number(args.wait) || 0));
        if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
        return {
          bg_id: info.id, running: bg.running(info.id),
          exitCode: bg.running(info.id) ? null : info.exitCode,
          new_output: clip(bg.drain(info.id)),
          total_output: info.total,
        };
      },
    },
    {
      name: 'terminal.kill',
      description: 'Stop a background terminal by bg_id.',
      permission: 'terminal.exec',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: { bg_id: { type: 'string' } },
        required: ['bg_id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const bg = backgroundRegistry();
        const info = bg.get(args.bg_id);
        if (!info) throw new Error(`unknown bg_id: ${args.bg_id}`);
        const killed = bg.kill(args.bg_id);
        if (ctx.bus) ctx.bus.emit(makeEvent(EVENTS.TERMINAL_FINISHED, { bg_id: args.bg_id, killed }, ctx.agentId ?? null));
        return { bg_id: args.bg_id, killed };
      },
    },
  ];
}

// ---- background process registry (per CLI process) ------------------------
// Lazy singleton keyed by nothing (one registry per process is enough for a
// CLI). Streams are drained by terminal.output; kill uses tree-kill via
// process.kill(-pid) when the child is detached.
const BG = { seq: 0, map: new Map() };

export function backgroundRegistry() {
  return {
    start(runtime, sandboxId, args, { hostRoot, env } = {}) {
      const argv = args.shell
        ? ['sh', '-c', [args.command, ...(args.args ?? [])].join(' ')]
        : (() => { const cmd = [args.command, ...(args.args ?? [])]; return cmd.length === 1 ? tokenizeCommand(cmd[0]) : cmd; })();
      const id = 'bg-' + (++BG.seq);
      const child = spawnDetached(runtime, sandboxId, argv, { hostRoot, env, workdir: args.workdir });
      const info = { id, pid: child.pid, command: args.command, started: Date.now(), exitCode: null, total: 0, pending: '', child };
      BG.map.set(id, info);
      child.stdout.on('data', (d) => { info.pending += d.toString('utf8'); info.total += d.length; });
      child.stderr.on('data', (d) => { info.pending += d.toString('utf8'); info.total += d.length; });
      child.on('exit', (code) => { info.exitCode = code ?? -1; });
      return id;
    },
    get(id) { return BG.map.get(id) ?? null; },
    running(id) { const i = BG.map.get(id); return !!i && i.exitCode === null; },
    drain(id) {
      const i = BG.map.get(id);
      if (!i) return '';
      const out = i.pending;
      i.pending = '';
      return out;
    },
    kill(id) {
      const i = BG.map.get(id);
      if (!i || i.exitCode !== null) return false;
      try { process.kill(-i.pid, 'SIGKILL'); } catch { try { i.child.kill('SIGKILL'); } catch { /* already gone */ } }
      return true;
    },
  };
}

/** Docker: exec detached is complex; host: spawn detached with pipes. */
function spawnDetached(runtime, sandboxId, argv, { hostRoot, env, workdir } = {}) {
  if (runtime && typeof runtime.spawnDetached === 'function') {
    return runtime.spawnDetached(sandboxId, argv, { env, workdir });
  }
  // host runtime path — replicate HostRuntime env filtering is overkill for a
  // background job; run with a minimal env (PATH, HOME) so secrets stay out.
  const { spawn } = require('node:child_process');
  const cwd = hostRoot && workdir && !workdir.startsWith('/') ? hostPath(hostRoot, workdir) : (hostRoot ?? process.cwd());
  return spawn(argv[0], argv.slice(1), {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

/** Quote-aware tokenizer: "python -c \"print(1)\"" -> ["python","-c","print(1)"].
 *  No shell semantics (no $(), no backticks) — those are shell features the
 *  sandbox deliberately does not provide. */
export function tokenizeCommand(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < input.length) { cur += input[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}
