// REPL (Fase 3): `nexus` with no args in a TTY. Zero-dep raw-mode UI:
// streaming render, ASCII spinner, status line, tool cards, slash commands,
// session continuity, Ctrl+C abort. NO_COLOR and non-ANSI fallback honored.
import { LineEditor, loadHistory, saveHistory } from './lineeditor.js';
import { compactHistory, shouldCompact, contextWindow } from './compact.js';
import { loadProjectDocs, findProjectDoc, scaffoldProjectDoc } from './project-doc.js';
import { renderSkillIndex, loadSkills } from './skills.js';
import { resolveSlash, loadCustomCommands, BUILTIN_SLASH } from './slash.js';
import { buildRunCtx, closeCtx, AgentLoop } from './ctx.js';
import { newSessionId, recordSession, findSession, emitSessionEvents, replaySessionHistory } from './session.js';
import { renderCliDefault } from '@nexus/prompts';
import { join, basename } from 'node:path';
import { newAgentId } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';

const SPINNER = ['|', '/', '-', '\\'];

function ansiEnabled(stdout) {
  return !process.env.NO_COLOR && stdout.isTTY && !process.env.TERM?.startsWith('dumb');
}

export function makeRenderer({ stdout, stderr }) {
  const ansi = ansiEnabled(stdout);
  const width = Math.min(stdout.columns ?? 80, 200);
  const c = (code) => ansi ? `\x1b[${code}m` : '';
  const B = c('1'), DIM = c('2'), R = c('0');
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let lastLineLen = 0;

  const clearLine = () => { if (ansi) stdout.write(`\r\x1b[2K`); else stdout.write('\r' + ' '.repeat(lastLineLen) + '\r'); };

  return {
    get ansi() { return ansi; },
    prompt(multiline) {
      clearLine();
      stdout.write(`${DIM}${multiline ? '...' : 'nexus'}>${R} `);
    },
    redraw(editor) {
      // single-line redraw of the editor buffer + cursor
      clearLine();
      const shown = editor.buffer.replace(/\n/g, '\\n');
      stdout.write(`${DIM}${editor.multiline ? '...' : 'nexus'}>${R} `);
      lastLineLen = shown.length + 7;
      if (ansi && editor.cursor < shown.length) {
        stdout.write(shown.slice(0, editor.cursor) + '\x1b7' + shown.slice(editor.cursor) + '\x1b8');
      } else {
        stdout.write(shown);
        lastLineLen = shown.length + 7;
      }
    },
    startSpinner(label = 'thinking') {
      this.stopSpinner();
      if (!ansi) { stdout.write(`[${label}]`); return; }
      spinnerTimer = setInterval(() => {
        clearLine();
        stdout.write(`${DIM}${SPINNER[spinnerFrame++ % SPINNER.length]} ${label}${R}`);
      }, 120);
    },
    stopSpinner() {
      if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
      clearLine();
    },
    text(delta) {
      this.stopSpinner();
      stdout.write(delta);
    },
    newline() { stdout.write('\n'); lastLineLen = 0; },
    toolCard(name, summary) {
      this.stopSpinner();
      stdout.write(`\n${B}[tool]${R} ${name}${summary ? ' ' + DIM + summary.slice(0, width - name.length - 10) + R : ''}\n`);
    },
    toolResult(ok, summary, ms) {
      stdout.write(`${DIM}  ${ok ? 'ok' : 'FAIL'} ${ms}ms${summary ? ' ' + String(summary).slice(0, 60) : ''}${R}\n`);
    },
    statusLine({ model, mode, tokens }) {
      if (!ansi) { stdout.write(`[${model} | ${mode}${tokens ? ' | ' + tokens + ' tok' : ''}]\n`); return; }
      stdout.write(`${DIM}${model} | ${mode}${tokens ? ' | ' + tokens + ' tok' : ''}${R}\n`);
    },
    info(msg) { stdout.write(`${DIM}${msg}${R}\n`); },
    error(msg) { stderr.write(`error: ${msg}\n`); },
    banner({ model, mode, session }) {
      stdout.write(`nexus repl — ${model} | mode: ${mode} | session: ${session}\n`);
      stdout.write(`${DIM}type /help for commands, Ctrl+C twice to exit${R}\n`);
    },
  };
}

const SLASH_HELP = `commands:
  /help              show this help
  /clear             reset the conversation (new session)
  /model [NAME]      show or switch model
  /compact [note]    summarize old turns (auto at 80% context window)
  /memory [k[=v]]    project memory: list / show / remember
  /plan              toggle plan mode (read-only)
  /permissions       show permission mode + rules
  /cost              token usage so far
  /status            session, model, mode, steps
  /resume [ID]       resume a session
  /rewind            rewind to a checkpoint (Fase 6)
  /doctor            run the doctor
  /init              scaffold NEXUS.md
  /exit              leave the repl
custom: .nexus/commands/*.md become /<name> ($ARGUMENTS substituted)`;

/** One agent turn inside the REPL. Returns the answer or null on abort. */
async function agentTurn({ ctx, loop, renderer, task, sessionId, history, signal, onEvent }) {
  emitSessionEvents(ctx.bus, sessionId, { user: task });
  let tokens = 0;
  const ev = (e) => {
    if (e.type === 'text_delta') renderer.text(e.delta);
    else if (e.type === 'usage') tokens = e.usage?.total_tokens ?? tokens;
    onEvent?.(e);
  };
  // tool cards from the bus
  const onToolCalled = (e) => {
    if (e.name !== 'agent.tool_called') return;
    const args = e.data?.args ?? {};
    const summary = args.path ?? args.command ?? '';
    renderer.toolCard(e.data?.tool ?? '?', String(summary));
  };
  const onToolFinished = (e) => {
    if (e.name !== 'agent.tool_finished') return;
    const r = e.data?.result ?? {};
    const summary = r.stdout ?? r.content ?? r.created ? JSON.stringify(r).slice(0, 60) : '';
    renderer.toolResult(e.data?.ok, summary, e.data?.duration_ms);
  };
  ctx.bus.on('agent.tool_called', onToolCalled);
  ctx.bus.on('agent.tool_finished', onToolFinished);
  try {
    const result = await loop.run(task, {
      agentId: ctx.agentId,
      sandbox: ctx.sandboxId,
      runtime: ctx.runtime,
      hostRoot: ctx.hostRoot,
      sandboxId: ctx.sandboxId,
      maxSteps: 32,
      env: ctx.env,
      system: ctx.systemPrompt,
      signal,
      onEvent: ev,
      ...(history?.length ? { history } : {}),
    });
    if (result?.done && result.answer) emitSessionEvents(ctx.bus, sessionId, { assistant: result.answer });
    return { result, tokens };
  } finally {
    ctx.bus.off?.('agent.tool_called', onToolCalled);
    ctx.bus.off?.('agent.tool_finished', onToolFinished);
  }
}

export async function runRepl({ env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, startMode = null, resumeId = null } = {}) {
  // accept console.log/error-style functions too (runNexusCli passes those)
  if (typeof stdout === 'function') {
    const fn = stdout;
    stdout = { write: (m) => fn(String(m).replace(/\n$/, '')), isTTY: process.stdout.isTTY, columns: process.stdout.columns };
  }
  if (typeof stderr === 'function') {
    const fn = stderr;
    stderr = { write: (m) => fn(String(m).replace(/\n$/, '')), isTTY: process.stderr.isTTY };
  }
  const renderer = makeRenderer({ stdout, stderr });
  if (!stdin?.isTTY) {
    stderr.write('repl: needs a TTY (non-interactive? use `nexus run "task"` or `nexus -p "task"`)\n');
    return 2;
  }

  const agentId = newAgentId();
  const ctx = await buildRunCtx({
    env, agentId, sandbox: 'host',
    permissionMode: startMode ?? undefined,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  ctx.agentId = agentId;
  const buildSystemPrompt = (c) => {
    const base = renderCliDefault({
      cwd: process.cwd(), platform: process.platform, date: new Date().toISOString().slice(0, 10),
      sandboxMode: c.sandboxMode, tools: c.registry.list().map((t) => t.name).join(', '),
    });
    let out = base;
    const docs = loadProjectDocs(process.cwd());
    if (docs.text) {
      c.info?.(`project instructions: ${docs.files.map((f) => basename(f)).join(', ')}${docs.truncated ? ' (truncated)' : ''}`);
      out += '\n\n' + docs.text;
    }
    const skillIdx = renderSkillIndex(c.skills ?? {});
    if (skillIdx) out += '\n\n' + skillIdx;
    const agents = c.agentDefs ?? {};
    const agentNames = Object.keys(agents);
    if (agentNames.length) {
      out += '\n\n## subagents\nUse agent.spawn with one of: ' + agentNames.map((n) => `${n} (${agents[n].description.slice(0, 60)})`).join('; ');
    }
    return out;
  };
  ctx.info = (m) => renderer.info(m);
  ctx.systemPrompt = buildSystemPrompt(ctx);

  // session: --continue / --resume or fresh
  let sessionId = newSessionId();
  let history = [];
  if (resumeId) {
    const found = findSession('.nexus/store', { id: resumeId });
    if (found) {
      sessionId = found.id;
      history = await replaySessionHistory(ctx.store, sessionId);
      renderer.info(`resumed ${sessionId} (${history.length} messages)`);
    } else renderer.error(`no session matches ${resumeId} — starting fresh`);
  }
  recordSession('.nexus/store', { id: sessionId, cwd: process.cwd(), subject: 'repl' });

  const customCommands = loadCustomCommands();
  const loop = new AgentLoop({ provider: ctx.provider, tools: ctx.tools, bus: ctx.bus });
  let mode = ctx.permissionMode;
  let model = env.NEXUS_GATEWAY_MODELS?.split(',')[0] ?? 'default';
  let totalTokens = 0;
  let steps = 0;

  renderer.banner({ model, mode, session: sessionId });

  const history_ = loadHistory();
  const editor = new LineEditor({
    history: history_,
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => {},
  });

  const wasRaw = stdin.isRaw ?? false;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();

  const abort = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) { renderer.newline(); renderer.info('(aborting turn — Ctrl+C again to exit)'); abort.abort(); }
    else { cleanup(); process.exit(130); }
  };
  process.once('SIGINT', onSigint);

  let running = false;
  let exitCode = 0;

  function cleanup() {
    process.removeListener('SIGINT', onSigint);
    if (stdin.setRawMode) { try { stdin.setRawMode(wasRaw); } catch { /* already restored */ } }
    stdin.pause();
    saveHistory(editor.history);
  }

  await new Promise((resolve) => {
    const submit = async (line) => {
      if (!line.trim()) { renderer.prompt(false); return; }
      saveHistory(editor.history);

      // slash command?
      if (line.trim().startsWith('/')) {
        const resolved = resolveSlash(line, customCommands);
        if (!resolved) {
          renderer.error(`unknown command: ${line.trim().split(' ')[0]} (try /help)`);
          renderer.prompt(false);
          return;
        }
        if (resolved.kind === 'custom') {
          renderer.info(`running ${resolved.cmd}...`);
          await turn(resolved.prompt);
          return;
        }
        const code = await handleBuiltin(resolved.cmd, resolved.args);
        if (code === 'exit') { stdin.removeListener('data', onData); cleanup(); resolve(); return; }
        renderer.prompt(false);
        return;
      }

      await turn(line);
    };

    const turn = async (task) => {
      // Fase 5: auto-compact when the context budget is running out
      const budget = shouldCompact(history, env);
      if (budget.compact && history.length) {
        renderer.info(`context ${budget.tokens}/${budget.window} tokens — auto-compacting...`);
        try {
          const res = await compactHistory({
            messages: history, provider: ctx.provider, sessionId, bus: ctx.bus, model,
          });
          if (res.compacted) {
            history = res.messages;
            renderer.info(`auto-compacted: ${res.oldCount} old -> summary, kept ${res.keptCount}`);
          }
        } catch (e) { renderer.error(`auto-compact failed: ${e.message} (continuing)`); }
      }
      running = true;
      renderer.newline();
      renderer.startSpinner('thinking');
      const turnAbort = new AbortController();
      const onAbortSignal = () => turnAbort.abort();
      abort.signal.addEventListener('abort', onAbortSignal, { once: true });
      try {
        const { result, tokens } = await agentTurn({
          ctx, loop, renderer, task, sessionId, history,
          signal: turnAbort.signal,
        });
        totalTokens += tokens;
        steps += result?.steps ?? 0;
        renderer.stopSpinner();
        renderer.newline();
        if (result?.done) {
          history = await replaySessionHistory(ctx.store, sessionId);
        } else {
          renderer.error(`stopped at ${result?.steps} steps (max)`);
        }
      } catch (e) {
        renderer.stopSpinner();
        renderer.newline();
        if (/abort/i.test(String(e?.message))) renderer.info('(turn aborted)');
        else renderer.error(String(e?.message ?? e));
      } finally {
        abort.signal.removeEventListener('abort', onAbortSignal);
        running = false;
      }
      renderer.statusLine({ model, mode, tokens: totalTokens });
      renderer.prompt(false);
    };

    const handleBuiltin = async (cmd, args) => {
      switch (cmd) {
        case '/help':
          stdout.write(SLASH_HELP + '\n');
          if (Object.keys(customCommands).length) stdout.write(`custom: ${Object.keys(customCommands).join(' ')}\n`);
          return 0;
        case '/exit':
          return 'exit';
        case '/clear':
          sessionId = newSessionId();
          history = [];
          recordSession('.nexus/store', { id: sessionId, cwd: process.cwd(), subject: 'repl' });
          renderer.info('conversation cleared (new session)');
          return 0;
        case '/model':
          if (args) { model = args; loop.setModel(args); renderer.info(`model: ${model}`); }
          else renderer.info(`model: ${model}`);
          return 0;
        case '/plan': {
          if (mode === 'plan') {
            // leaving plan mode requires approval (Fase 6f)
            renderer.info('plan mode: to exit, run /plan approve (after reviewing the plan)');
            const sub = (args ?? '').trim();
            if (sub === 'approve') {
              mode = 'ask';
              ctx.executor.setPolicyMode?.(mode);
              renderer.info('plan approved — mode: ask');
            }
            return 0;
          }
          mode = 'plan';
          ctx.executor.setPolicyMode?.(mode);
          renderer.info('mode: plan (read-only; the agent will draft a plan to .nexus/plans/)');
          return 0;
        }
        case '/permissions':
          renderer.info(`mode: ${mode}`);
          renderer.info(`rules: ${JSON.stringify(ctx.policySettings?.permissions ?? {})}`);
          return 0;
        case '/cost': {
          // Fase 6g: pricing table optional — tokens only when absent
          const pricingPath = join(process.cwd(), '.nexus', 'pricing.json');
          let cost = null;
          try {
            const { readFileSync: rf } = await import('node:fs');
            const table = JSON.parse(rf(pricingPath, 'utf8'));
            const p = table[model];
            if (p && Number.isFinite(p.per_mtok_input) && Number.isFinite(p.per_mtok_output)) {
              cost = (totalTokens / 1_000_000) * (p.per_mtok_input + p.per_mtok_output) / 2; // ponytail: split unknown — refine when usage separates in/out
            }
          } catch { /* no pricing table — tokens only */ }
          renderer.info(`tokens: ${totalTokens} (steps: ${steps})${cost !== null ? ` | est. cost: $${cost.toFixed(4)} (${model})` : ''}`);
          return 0;
        }
        case '/skills': {
          const skills = ctx.skills ?? {};
          const names = Object.keys(skills);
          renderer.info(names.length ? names.map((n) => `${n}: ${skills[n].description}`).join('\n') : '(no skills in .nexus/skills)');
          return 0;
        }
        case '/reload-skills': {
          ctx.skills = loadSkills(process.cwd());
          ctx.systemPrompt = buildSystemPrompt(ctx);
          renderer.info(`skills reloaded: ${Object.keys(ctx.skills).length}`);
          return 0;
        }
        case '/mcp': {
          if (!ctx.mcpClients?.length && !ctx.mcpErrors?.length) { renderer.info('no .nexus/mcp.json configured'); return 0; }
          for (const c of ctx.mcpClients ?? []) {
            renderer.info(`${c.name}: ready — ${c.tools.length} tools (${c.tools.slice(0, 5).map((t) => t.rawName).join(', ')}${c.tools.length > 5 ? '…' : ''})`);
          }
          for (const e of ctx.mcpErrors ?? []) renderer.error(`mcp: ${e}`);
          return 0;
        }
        case '/diff': {
          const { diff: gitDiff, isRepo } = await import('./git.js');
          if (!(await isRepo(process.cwd()))) { renderer.info('not a git repo'); return 0; }
          const d = await gitDiff(process.cwd());
          renderer.info(d ? d.slice(0, 4000) : '(working tree clean vs HEAD)');
          return 0;
        }
        case '/status':
          renderer.info(`session: ${sessionId} | model: ${model} | mode: ${mode} | steps: ${steps} | tokens: ${totalTokens}`);
          return 0;
        case '/resume': {
          const found = args ? findSession('.nexus/store', { id: args }) : findSession('.nexus/store', { cwd: process.cwd() });
          if (!found) { renderer.error('no session found'); return 0; }
          sessionId = found.id;
          history = await replaySessionHistory(ctx.store, sessionId);
          renderer.info(`resumed ${sessionId} (${history.length} messages)`);
          return 0;
        }
        case '/compact': {
          if (!history.length) { renderer.info('nothing to compact'); return 0; }
          renderer.startSpinner('compacting');
          try {
            const res = await compactHistory({
              messages: history, provider: ctx.provider, sessionId, bus: ctx.bus,
              instructions: args || '', model,
            });
            if (res.compacted) {
              history = res.messages;
              renderer.info(`compacted: ${res.oldCount} old messages -> summary (${res.summary.length} chars), kept ${res.keptCount}`);
            } else renderer.info(res.reason);
          } catch (e) {
            renderer.error(`compact failed: ${e.message}`);
          } finally { renderer.stopSpinner(); }
          return 0;
        }
        case '/memory': {
          const { MemoryManager, JsonlStorage } = await import('@nexus/memory');
          const mm = new MemoryManager({
            storage: new JsonlStorage(join(process.cwd(), '.nexus', 'memory', 'project.jsonl')),
            emit: (e) => ctx.bus.emit(makeEvent(e.name, e.data, sessionId)),
          });
          await mm.init();
          const arg = (args ?? '').trim();
          try {
            if (!arg) {
              const list = await mm.recall({ kind: 'project' });
              renderer.info(list.length ? list.map((r) => `- ${r.key}: ${JSON.stringify(r.value).slice(0, 120)}`).join('\n') : '(no project memories)');
            } else if (arg.includes('=')) {
              const i = arg.indexOf('=');
              const k = arg.slice(0, i).trim();
              const v = arg.slice(i + 1).trim();
              if (!k) { renderer.error('usage: /memory <key> = <value>'); return 0; }
              let parsed = v;
              try { parsed = JSON.parse(v); } catch { /* keep string */ }
              await mm.rememberProject(k, parsed, { subject: sessionId });
              renderer.info(`remembered: ${k}`);
            } else {
              const rec = await mm.recallOne('project', arg);
              renderer.info(rec ? `${rec.key} = ${JSON.stringify(rec.value)}` : `(no memory for "${arg}")`);
            }
          } finally { await mm.close(); }
          return 0;
        }
        case '/rewind': {
          const cps = ctx.checkpointer?.list() ?? [];
          if (!cps.length) { renderer.info('no checkpoints yet (they appear before file-writing tools run)'); return 0; }
          renderer.info('checkpoints (newest first):');
          for (const c of cps.slice(0, 15)) {
            const names = c.files.map((f) => basename(typeof f === 'string' ? f : f.path));
            renderer.info(`  #${c.seq} ${c.tool} ${names.join(',')} (${c.ts.slice(11, 19)})`);
          }
          renderer.info('usage: /rewind <n> [code|conversation|both] — default both');
          renderer.info('note: terminal.exec side effects (rm, npm install) cannot be restored');
          const m = /^\/(\S+)\s+(\d+)\s*(\S*)/.exec(`${cmd} ${args ?? ''}`.trim());
          if (!m) return 0;
          const seq = Number(m[2]);
          const what = (m[3] || 'both').toLowerCase();
          const cp = cps.find((c) => c.seq === seq);
          if (!cp) { renderer.error(`no checkpoint #${seq}`); return 0; }
          if (what !== 'conversation') {
            const restored = await ctx.checkpointer.restore(seq, { runtime: ctx.runtime, sandboxId: ctx.sandboxId });
            renderer.info(`code restored: ${restored.join(', ')}`);
          }
          if (what !== 'code') {
            // conversation: replay events up to the checkpoint ts, branch off
            const events = [];
            const iter = await ctx.store.replay({ subject: sessionId });
            for await (const e of iter) { if (e.ts <= cp.ts) events.push(e); else break; }
            history = await replaySessionHistory(ctx.store, sessionId).then((all) => {
              const cut = all.filter((msg, i) => i < Math.max(0, all.length)); // full replay then trim below
              return cut;
            });
            // trim history to messages before checkpoint ts
            const msgEvents = events.filter((e) => e.name === 'session.user_message' || e.name === 'session.assistant_message');
            history = msgEvents.map((e) => ({
              role: e.name === 'session.user_message' ? 'user' : 'assistant',
              content: e.data?.text ?? e.data?.message ?? '',
            }));
            const branch = newSessionId();
            ctx.bus.emit(makeEvent('session.rewound', { from: sessionId, to_seq: seq, branch, restored: what }, branch));
            sessionId = branch;
            recordSession('.nexus/store', { id: sessionId, cwd: process.cwd(), subject: 'repl' });
            renderer.info(`conversation rewound to #${seq} — new branch ${sessionId}`);
          }
          return 0;
        }
        case '/doctor': {
          const { runDoctor } = await import('./doctor.js');
          await runDoctor({ stdout, stderr });
          return 0;
        }
        case '/init': {
          // scan the repo and scaffold NEXUS.md (does not overwrite)
          const existing = findProjectDoc(process.cwd());
          if (existing) { renderer.info(`already present: ${existing.path}`); return 0; }
          const { extractSymbols } = await import('@nexus/tool-system');
          const { readdirSync, writeFileSync, readFileSync } = await import('node:fs');
          const files = [];
          const walk = (d, prefix = '') => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
              if (e.name.startsWith('.') || e.name === 'node_modules') continue;
              const rel = prefix ? prefix + '/' + e.name : e.name;
              if (e.isDirectory()) walk(join(d, e.name), rel);
              else files.push(rel);
              if (files.length >= 500) return;
            }
          };
          walk(process.cwd());
          const symbols = {};
          for (const f of files.slice(0, 200)) {
            if (!/\.(js|mjs|cjs|ts|py|go|rs|pwn|inc)$/.test(f)) continue;
            try { symbols[f] = extractSymbols(f.split('/').pop(), readFileSync(join(process.cwd(), f), 'utf8')); } catch { /* unreadable */ }
          }
          const doc = scaffoldProjectDoc({ files, symbols, projectName: basename(process.cwd()) });
          writeFileSync(join(process.cwd(), 'NEXUS.md'), doc);
          renderer.info(`NEXUS.md created (${files.length} files scanned) — edit it to fill in the TODOs`);
          return 0;
        }
        default:
          renderer.error(`unhandled: ${cmd}`);
          return 0;
      }
    };

    editor.onSubmit = submit;
    editor.onExit = () => { stdin.removeListener('data', onData); cleanup(); resolve(); };
    editor.onCancel = () => { renderer.newline(); renderer.prompt(false); };

    const onData = (chunk) => {
      if (running) return; // input during a turn is ignored (Ctrl+C via SIGINT)
      const r = editor.handleKey(chunk);
      if (r === 'submit') return; // submit() drives the next render
      renderer.redraw(editor);
    };
    stdin.on('data', onData);

    renderer.prompt(false);
  });

  await closeCtx(ctx);
  return exitCode;
}
