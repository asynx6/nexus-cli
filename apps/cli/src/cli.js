// ../vendor/cli/index.js dispatcher — parses argv, dispatches to subcommands.
// Zero deps. Returns exit code.

import { buildRunCtx, buildReplayCtx, closeCtx, AgentLoop } from './ctx.js';
import { loadEnv, DEFAULT_GATEWAY_BASE } from '@nexus/shared';
import { loadPlugins } from '@nexus/plugin-registry';
import { isTelemetryEnabled, setTelemetryEnabled } from '@nexus/telemetry';
import { renderCliDefault } from '@nexus/prompts';
import { runDoctor, runDoctorFix } from './doctor.js';
import { runSetup } from './setup.js';
import { runAudit } from './audit.js';
import { scaffoldProject, parseInitArgs, promptInitAnswers } from './init.js';
import { installGracefulShutdown as installCliGraceful } from './graceful.js';
import { makeEvent } from '@nexus/event-system';
import { newAgentId, newTaskId } from '@nexus/shared';
import { createReplayServer } from '@nexus/event-system/replay-server.js';
import { runReplayDiff } from './replaydiff.js';
import { runWebhooks, WEBHOOKS_HELP } from './webhooks.js';
import { PERMISSION_MODES } from '@nexus/security';
import { isValidMode, makePermissionPrompt } from './permissions-prompt.js';
import { newSessionId, recordSession, findSession, loadSessionIndex, saveSessionIndex, emitSessionEvents, replaySessionHistory } from './session.js';
import { runRepl } from './repl.js';
import { runHeadless } from './headless.js';
import { runSecrets, SECRETS_HELP } from './secrets.js';
import { runAsk } from './ask.js';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { runPrompts, PROMPTS_HELP } from './prompts.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Single source of truth: every command, its aliases, and its help line.
 *  Dispatch, known-command detection, and HELP all read this table. */
export const COMMANDS = [
  { name: 'run', aliases: [], help: 'run agent on a task', usage: 'nexus run "<task>" [--max-steps=N] [--model=NAME] [--sandbox=host|docker]' },
  { name: 'replay', aliases: [], help: 'replay events from store', usage: 'nexus replay [--subject=ID] [--since=SEQ] [--follow] | --port N | diff <a> <b>' },
  { name: 'webhooks', aliases: [], help: 'manage event subscriptions (control plane REST)', usage: 'nexus webhooks <list|add|get|pause|resume|rm|test>' },
  { name: 'secrets', aliases: [], help: 'per-project encrypted secret vault (E1)', usage: 'nexus secrets <init|set|get|list|rm|grant|revoke>' },
  { name: 'prompts', aliases: [], help: 'named, versioned system prompts (A4)', usage: 'nexus prompts <list|show|diff|rollback|edit>' },
  { name: 'events', aliases: [], help: 'event store maintenance', usage: 'nexus events compact [--keep-recent=N] [--store=PATH]' },
  { name: 'tasks', aliases: [], help: 'list recent task subjects', usage: 'nexus tasks' },
  { name: 'sessions', aliases: [], help: 'list sessions (C1)', usage: 'nexus sessions [--clear]' },
  { name: 'healthz', aliases: [], help: 'check gateway reachability', usage: 'nexus healthz' },
  { name: 'setup', aliases: [], help: 'interactive gateway config wizard', usage: 'nexus setup' },
  { name: 'plugins', aliases: [], help: 'list discovered tool plugins', usage: 'nexus plugins [--dir=PATH]' },
  { name: 'telemetry', aliases: [], help: 'opt-in usage metrics — OFF by default', usage: 'nexus telemetry [on|off]' },
  { name: 'ask', aliases: [], help: 'one-shot model Q&A, no sandbox or store', usage: 'nexus ask "<question>" [--model=NAME] [--raw]' },
  { name: 'doctor', aliases: [], help: 'full environment health check', usage: 'nexus doctor [--fix]' },
  { name: 'init', aliases: [], help: 'scaffold a new NEXUS project skeleton', usage: 'nexus init <name> [--yes]' },
  { name: 'audit', aliases: [], help: 'verify SHA-256 hash chain of an audit log', usage: 'nexus audit verify [--file=PATH]' },
  { name: 'license', aliases: [], help: 'license key management', usage: 'nexus license <activate|verify|issue>' },
];

export function isKnownCommand(c) {
  return COMMANDS.some((x) => x.name === c || x.aliases.includes(c));
}

const HELP = `nexus — AI Agent Operating Environment
Usage:
${COMMANDS.map((c) => `  ${c.usage}  ${c.help}`).join('\n')}
  nexus --help                                           show this message

Env (read from .env-gateway or process env):
  NEXUS_GATEWAY_BASE      gateway base URL
  NEXUS_GATEWAY_KEY       gateway API key
  NEXUS_GATEWAY_MODELS    comma-separated fallback models
  NEXUS_RATE_LIMIT_RPM    optional: max sustained model calls per minute
  NEXUS_RATE_LIMIT_BURST  optional: max instant calls before throttling (defaults to RPM)

Subcommand shortcuts:
  nexus <task text>       if first arg is not a subcommand, treated as 'nexus run <task>'
`;

/** Parse argv into {cmd, task, flags}.
 *  Boolean flags vs value flags per command; --k=v, --k v (value flags only),
 *  -- terminator, short flags (-p -m -c -h -v). Positional words join into task. */
export function parseArgs(argv) {
  const out = { cmd: 'help', task: '', flags: {}, argvEmpty: argv.length === 0 };
  const positional = [];
  // value flags: the next token is consumed as the flag's value
  const VALUE_FLAGS = new Set(['max-steps', 'maxSteps', 'model', 'prompt', 'sandbox',
    'subject', 'since', 'interval', 'port', 'host', 'dir', 'file', 'store',
    'keep-recent', 'keepRecent', 'limit', 'base', 'device', 'admin', 'output-format',
    'permission-mode', 'max-tokens', 'max-turns', 'resume', 'worktree']);
  const SHORT = { p: 'print', m: 'model', c: 'continue', h: 'help', v: 'verbose' };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name) && i + 1 < argv.length) { out.flags[name] = argv[++i]; continue; }
      out.flags[name] = true;
    } else if (a.startsWith('-') && a.length === 2 && SHORT[a[1]]) {
      const name = SHORT[a[1]];
      if (VALUE_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) { out.flags[name] = argv[++i]; }
      else out.flags[name] = true;
    } else positional.push(a);
  }
  out.helpFlag = out.flags.help === true || out.flags.h === true;
  // A bare, unknown first token is shorthand for `nexus run <task text>` —
  // e.g. `nexus "fix the bug"` and `nexus build feature X`. Only known
  // subcommands dispatch normally; anything else is treated as a task.
  const isHelpPositional = (c) => c === '-h' || c === 'help' || c === '--help';
  if (positional.length) {
    if (isHelpPositional(positional[0])) { out.cmd = 'help'; out.task = ''; }
    else out.cmd = isKnownCommand(positional[0]) ? positional[0] : 'nexus';
    if (out.cmd !== 'help') out.task = positional.slice(out.cmd === 'nexus' ? 0 : 1).join(' ');
  } else if (argv.length) {
    out.cmd = out.helpFlag ? 'help' : 'unknown';
    out.unknownArg = argv[0];
  }
  return out;
}

function readFlags(flags, ...keys) {
  for (const k of keys) {
    const v = flags[k];
    if (v === undefined || v === '') continue;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return undefined;
}

/** Stable machine id for license activation (best-effort, no deps). */
async function machineId() {
  try {
    const { execFileSync } = await import('node:child_process');
    const out = process.platform === 'darwin'
      ? execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
      : process.platform === 'win32'
        ? execFileSync('wmic', ['csproduct', 'get', 'UUID'], { encoding: 'utf8' })
        : execFileSync('cat', ['/etc/machine-id'], { encoding: 'utf8' }).trim();
    if (process.platform === 'darwin') {
      const m = out.match(/IOPlatformUUID.*"?([0-9A-Fa-f-]{36})/);
      return m ? m[1] : 'darwin';
    }
    if (process.platform === 'win32') return out.trim();
    return out.trim() || 'linux';
  } catch {
    return 'unknown';
  }
}

/** Run the CLI. Returns 0 on success, non-zero on error. */
function stdinIsTty() {
  try { return process.stdin.isTTY === true; } catch { return false; }
}

export async function runNexusCli(argv, env = process.env, stdout = console.log, stderr = console.error) {
  // Gateway secrets live in .env-gateway; load once per CLI invocation.
  // loadEnv never overrides explicit process.env, and never returns values.
  loadEnv('.env-gateway');
  let args;
  try { args = parseArgs(argv); }
  catch (e) { stderr('parse: ' + e.message); return 2; }

  // Fase 3: bare `nexus` in a TTY -> REPL; -p -> headless
  if (args.argvEmpty && stdinIsTty(env)) {
    return await runRepl({ env, stdout, stderr, stdin: process.stdin, startMode: readFlags(args.flags, 'permission-mode', 'permissionMode') ?? undefined });
  }
  if (args.flags.p === true || args.flags.print === true) {
    return await runHeadless({ task: args.task, env, stdout, stderr, stdin: process.stdin, flags: args.flags });
  }

  if (args.cmd === 'help' || args.cmd === 'unknown') {
    const isHelp = args.cmd === 'help' || args.helpFlag;
    if (isHelp) {
      stdout(HELP);
      return args.argvEmpty ? 2 : 0;
    }
    stderr(`unknown command: ${args.unknownArg}`);
    stderr(HELP);
    return 2;
  }

  if (args.cmd === 'healthz') {
    try {
      const base = (env.NEXUS_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE).replace(/\/+$/, '');
      const key = env.NEXUS_GATEWAY_KEY;
      const headers = key ? { Authorization: `Bearer ${key}` } : {};
      const models = (env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent').split(',').map((s) => s.trim()).filter(Boolean);
      const probeModel = models[0];
      const report = (reachable, extra) => {
        stdout(`gateway reachable: ${reachable}${extra ? ` (${extra})` : ''}`);
        stdout(`base: ${base}`);
        stdout(`models: ${models.join(',')}`);
      };
      // The gateway has no /healthz and its /v1/models can stall for tens of
      // seconds, so probe with a 1-token chat completion instead: it is the
      // actual workload path and answers in ~2s.
      const body = JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 });
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(env.NEXUS_HEALTHZ_TIMEOUT_MS ?? 15_000),
      }).catch(() => null);
      if (!r) { report('unknown (request failed or timed out)'); return 1; }
      if (r.status === 401 || r.status === 403) {
        report('yes, auth: REJECTED', `HTTP ${r.status} — check NEXUS_GATEWAY_KEY`);
        return 1;
      }
      if (!r.ok) { report('yes, unhealthy', `HTTP ${r.status}`); return 1; }
      const list = await r.json().catch(() => null);
      const got = list?.model ?? list?.id;
      report('yes', `HTTP ${r.status}`);
      if (got) stdout(`served by: ${got}`);
      return 0;
    } catch (e) { stderr('healthz: ' + e.message); return 1; }
  }

  if (args.cmd === 'doctor') {
    if (args.flags.fix) {
      const result = await runDoctorFix({ stdout, stderr });
      // `true` only when nothing changed AND the gateway key is usable.
      const allOk = result.actions.every((a) => a.ok) && !result.keyUnusable;
      return allOk ? 0 : 1;
    }
    return await runDoctor({ env, stdout, stderr });
  }

  if (args.cmd === 'setup') {
    return await runSetup(argv.slice(1), { stdout, stderr });
  }

  if (args.cmd === 'plugins') {
    const dirs = [join(process.cwd(), '.nexus', 'plugins')];
    if (args.flags.dir) dirs.push(resolve(args.flags.dir));
    const { plugins, errors } = await loadPlugins(dirs);
    if (plugins.length === 0) stdout('no plugins found');
    for (const p of plugins) {
      stdout(`  ${p.name}  (${p.tools.length} tool${p.tools.length === 1 ? '' : 's'})  ${p.path}`);
      for (const t of p.tools) stdout(`      - ${t.name}${t.description ? `  ${t.description}` : ''}`);
    }
    for (const e of errors) stderr(`  plugin error: ${e.path}: ${e.error}`);
    return errors.length ? 1 : 0;
  }

  if (args.cmd === 'telemetry') {
    const on = args.positional?.[0] ?? args.task;
    if (on === 'on') {
      setTelemetryEnabled(true);
      stdout('telemetry: enabled — counters and timings recorded locally. Set NEXUS_TELEMETRY=0 to force off.');
      return 0;
    }
    if (on === 'off') {
      setTelemetryEnabled(false);
      stdout('telemetry: disabled');
      return 0;
    }
    stdout(`telemetry: ${isTelemetryEnabled() ? 'enabled' : 'disabled'} (env NEXUS_TELEMETRY, flag .nexus/telemetry.json)`);
    return 0;
  }

  if (args.cmd === 'ask') {
    return runAsk([args.task, ...Object.entries(args.flags).filter(([_, v]) => v === true).map(([k]) => `--${k}`)], env, stdout, stderr);
  }

  if (args.cmd === 'init') {
      let parsed;
      try { parsed = parseInitArgs(argv.slice(1)); }
      catch (e) { stderr('init: ' + e.message); return 2; }

      let answers;
    try {
      answers = parsed.yes
        ? { name: parsed.name, scope: '@' + parsed.name, provider: 'hermes-agent', sandbox: 'subprocess' }
        : await promptInitAnswers({ name: parsed.name, stdout, stderr });
    } catch (e) {
      stderr('init: ' + e.message);
      return 2;
    }

    const target = join(process.cwd(), parsed.name);
    try {
      await scaffoldProject({ target, answers, yes: parsed.yes, stdout, stderr });
      return 0;
    } catch (e) {
      stderr('init: ' + e.message);
      return 1;
    }
  }

  if (args.cmd === 'audit') {
    return await runAudit(argv.slice(1), env, stdout, stderr);
  }

  if (args.cmd === 'replay' && args.task.startsWith('diff')) {
    // nexus replay diff <left> <right> [--json] [--limit=N]
    // Flags land in args.flags (parseArgs); positional subjects ride in task.
    const diffArgs = args.task.slice(5).split(/\s+/).filter(Boolean);
    return await runReplayDiff(diffArgs, buildReplayCtx(), stdout, stderr, args.flags);
  }

  if (args.cmd === 'replay') {
    // Browser UI mode: --port[=N] (or positional 9090) opens the replay server.
    const portFlag = args.flags.port ?? args.flags['serve-port'];
    const hostFlag = args.flags.host ?? args.flags['serve-host'] ?? '127.0.0.1';
    const noOpen = !!args.flags['no-open'] || args.flags.noOpen === true;
    if (portFlag !== undefined || args.flags.ui === true) {
      const port = Number(portFlag ?? 9090);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) { stderr('replay: --port must be 1..65535'); return 2; }
      const ctx = buildReplayCtx();
      const store = await ctx.store.open();
      // resolve the event-system public dir regardless of CWD: replay-server
      // is shipped inside the installed package, so we go up from this file.
      const here = dirname(fileURLToPath(import.meta.url));
      // here = <pkg>/src; the tarball ships the UI at <pkg>/vendor/event-system/public
      // (source-tree layout has packages/, the published bundle has vendor/).
      // Try the installed layout first, then the source-tree layout for repo runs.
      let publicDir = resolve(here, '..', 'vendor', 'event-system', 'public');
      try {
        const fs = await import('node:fs');
        if (!fs.existsSync(publicDir)) {
          const sourceDir = resolve(here, '..', '..', '..', 'packages', 'event-system', 'public');
          publicDir = fs.existsSync(sourceDir) ? sourceDir : resolve(process.cwd(), 'packages', 'event-system', 'public');
        }
      } catch { /* ignore */ }
      const srv = createReplayServer({ store, publicDir, host: String(hostFlag), port });
      let shutdown;
      try {
        await srv.listen();
        const url = `http://${srv.host}:${srv.port}/`;
        stdout(`nexus replay ui: ${url}`);
        stdout(`  serving static from ${publicDir}`);
        stdout(`  store: ${ctx.store.dir}/events.jsonl (count=${store.count()})`);
        stdout('  press Ctrl+C to stop');
        if (!noOpen) {
          try {
            const { spawn } = await import('node:child_process');
            const opener = process.platform === 'darwin' ? 'open'
              : process.platform === 'win32' ? 'start'
              : 'xdg-open';
            spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
          } catch { /* best-effort */ }
        }
        // SIGTERM/SIGINT -> close replay server + store cleanly
        shutdown = installCliGraceful({
          onClose: async () => { try { await srv.close(); } catch {} try { await store.close(); } catch {} },
        });
        await new Promise(() => {}); // run until SIGINT/SIGTERM
      } finally {
        if (shutdown) shutdown.uninstall();
        try { await srv.close(); } catch {}
        try { await store.close(); } catch {}
      }
      return 0;
    }
    // Fase 6i: nexus replay export <session> --html [out.html]
    if (args.task.startsWith('export')) {
      const parts = args.task.slice(7).split(/\s+/).filter(Boolean);
      const sessionId = parts[0];
      if (!sessionId) { stderr('usage: nexus replay export <session> --html [out.html]'); return 2; }
      const ctx2 = buildReplayCtx();
      const store2 = await ctx2.store.open();
      // A session's events span multiple subjects (session-*, agent-*, task-*):
      // slice the store by the seq window bounded by this session's
      // user_message..assistant_message envelope.
      const all = [];
      for await (const e of store2.replay({})) all.push(e);
      await store2.close();
      const starts = all.filter((e) => e.name === 'session.user_message' && e.subject === sessionId);
      const ends = all.filter((e) => e.name === 'session.assistant_message' && e.subject === sessionId);
      const events = [];
      for (let i = 0; i < starts.length; i++) {
        const from = starts[i].seq;
        const to = (ends[i] ?? all[all.length - 1]).seq;
        for (const e of all) if (e.seq >= from && e.seq <= to) events.push(e);
      }
      if (!events.length) { stderr(`no events for session ${sessionId}`); return 1; }
      const { exportSessionHtml } = await import('./replay-export.js');
      const html = exportSessionHtml(events, { title: `nexus · ${sessionId}` });
      const outPath = args.flags.html && typeof args.flags.html === 'string'
        ? args.flags.html
        : parts[1] ?? `${sessionId}.html`;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outPath, html);
      stdout(`exported ${events.length} events -> ${outPath}`);
      return 0;
    }
    const ctx = buildReplayCtx();
    const store = await ctx.store.open();
    const subject = args.flags.subject;
    const since = readFlags(args.flags, 'since');
    const follow = !!args.flags.follow;
    const interval = Number(args.flags.interval ?? 1000);
    try {
      let cursor = since;
      let got = false;
      for (;;) {
        for await (const env of store.replay({ subject, since: cursor })) {
          stdout(JSON.stringify(env));
          cursor = (env.seq ?? 0) + 1;
          got = true;
        }
        if (!follow) {
          if (!got) stdout(subject ? `no events for subject ${subject} in store` : 'no events in store yet');
          break;
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      return 0;
    } finally { await store.close(); }
  }

  if (args.cmd === 'prompts') {
    const sub = args.task.split(/\s+/).filter(Boolean);
    return runPrompts(sub, process.env, stdout, stderr, { flags: args.flags });
  }

  if (args.cmd === 'secrets') {
    // nexus secrets <sub> [args...] — positional args ride in args.task,
    // flags ride in args.flags (parseArgs splits them out).
    const sub = args.task.split(/\s+/).filter(Boolean);
    return runSecrets(sub, process.env, stdout, stderr, { flags: args.flags });
  }

  if (args.cmd === 'webhooks') {
    // nexus webhooks <sub> [args...] — positional args ride in args.task.
    const whArgs = args.task.split(/\s+/).filter(Boolean);
    return await runWebhooks(whArgs, env, stdout, stderr);
  }

  if (args.cmd === 'events' && args.task === 'compact') {
    // nexus events compact [--keep-recent=N] [--store=PATH]
    const keepRecent = Number(args.flags['keep-recent'] ?? args.flags.keepRecent ?? 1000);
    if (!Number.isFinite(keepRecent) || keepRecent < 1) {
      stderr('events compact: --keep-recent must be a positive integer');
      return 2;
    }
    const storePath = args.flags.store;
    const { compact, EventStore } = await import('@nexus/event-system');
    const { buildReplayCtx } = await import('./ctx.js');
    const ctx = storePath
      ? { store: { open: async () => new EventStore(storePath) } }
      : buildReplayCtx();
    const store = await ctx.store.open();
    let result;
    try {
      const before = store.count();
      result = compact(store, { keepRecent });
      // compact() closed the store above; open a FRESH instance to read the
      // after-state. A cached handle returns the dead one (EBADF).
      const reopened = new EventStore(store.jsonlPath);
      try {
        const after = reopened.count();
        stdout(`compact: ${before} → ${after} events (dropped ${result.dropped}, kept ${result.kept})`);
        stdout(`store: ${reopened.jsonlPath}`);
      } finally { reopened.close(); }
      return 0;
    } catch (e) {
      stderr('events compact failed: ' + e.message);
      return 1;
    }
  }

  if (args.cmd === 'license') {
    // nexus license activate <key> [--device=N] [--base=URL]
    // nexus license verify <key> [--base=URL]
    // nexus license issue <tier> [--admin=TOKEN] [--base=URL]
    const sub = args.task.split(' ').filter(Boolean)[0];
    const rest = args.task.split(' ').slice(1).filter(Boolean);
    const baseUrl = args.flags.base ?? args.flags['base-url'] ?? process.env.LICENSE_BASE ?? 'http://127.0.0.1:8486';
    const device = args.flags.device ?? args.flags['host-id'] ?? (await machineId()) ?? 'unknown';
    const admin = args.flags.admin ?? process.env.LICENSE_ADMIN_SECRET;

    const bodyFor = (obj) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

    try {
      if (sub === 'activate') {
        const key = rest[0];
        if (!key) { stderr('license activate: <key> required'); return 2; }
        const r = await fetch(baseUrl + '/v1/keys/activate', bodyFor({ key, device })).then((x) => x.json());
        if (!r.ok) { stderr('activate failed: ' + (r.reason || r.error)); return 1; }
        stdout(`activated: ${r.key} (${r.tier}) on ${r.device}`);
        return 0;
      }
      if (sub === 'verify') {
        const key = rest[0];
        if (!key) { stderr('license verify: <key> required'); return 2; }
        const r = await fetch(baseUrl + '/v1/keys/verify', bodyFor({ key, device })).then((x) => x.json());
        if (!r.ok) { stderr('verify failed: ' + (r.reason || r.error)); return 1; }
        stdout(`key ${r.key}: tier=${r.tier} activated=${r.activated}`);
        return 0;
      }
      if (sub === 'issue') {
        const tier = rest[0] ?? 'pro';
        if (!admin) { stderr('license issue: --admin=TOKEN required'); return 2; }
        const h = { 'Content-Type': 'application/json', 'x-license-admin': admin };
        const r = await fetch(baseUrl + '/v1/keys/issue', { method: 'POST', headers: h, body: JSON.stringify({ tier, count: 1 }) }).then((x) => x.json());
        if (!r.ok) { stderr('issue failed: ' + (r.error || r.reason)); return 1; }
        stdout(r.keys[0].key);
        return 0;
      }
    } catch (e) {
      stderr('license: ' + e.message);
      return 1;
    }
    stderr('license: unknown subcommand (activate|verify|issue)');
    return 2;
  }

  if (args.cmd === 'tasks') {
    const ctx = buildReplayCtx();
    const store = await ctx.store.open();
    try {
      const seen = new Map();
      for await (const e of store.replay({ name: 'task.started' })) {
        seen.set(e.subject, e.ts);
      }
      for (const [s, ts] of seen) stdout(ts, s);
      if (seen.size === 0) stdout('no tasks recorded yet (run: nexus run "task text")');
      return 0;
    } finally { await store.close(); }
  }

  if (args.cmd === 'sessions') {
    const sessions = loadSessionIndex('.nexus/store');
    if (args.flags.clear) {
      saveSessionIndex('.nexus/store', []);
      stdout('sessions: index cleared');
      return 0;
    }
    if (sessions.length === 0) { stdout('no sessions yet (run: nexus run "task text")'); return 0; }
    for (const s of sessions) {
      stdout(`${s.id}  ${s.startedAt}  ${s.lastSubject?.slice(0, 60) ?? ''}`);
    }
    return 0;
  }

  if (args.cmd === 'run' || (args.task && args.cmd === 'nexus')) {
        if (!args.task.trim()) { stderr('run: task text required'); return 2; }
      const agentId = newAgentId();
        let ctx;
        try {
          const sandboxFlag = args.flags.sandbox;
          if (sandboxFlag && sandboxFlag !== 'host' && sandboxFlag !== 'docker') {
            stderr('run: --sandbox must be host or docker'); return 2;
          }
          const modeFlag = readFlags(args.flags, 'permission-mode', 'permissionMode');
          if (modeFlag && !isValidMode(modeFlag)) {
            stderr(`run: --permission-mode must be one of: ${PERMISSION_MODES.join(', ')}`); return 2;
          }
          // C2: auto mode requires the explicit danger acknowledgment flag
          if (modeFlag === 'auto' && !args.flags.dangerouslyAuto && !args.flags['dangerously-auto']) {
            stderr('run: --permission-mode=auto requires --dangerously-auto (agent can run any command without asking)');
            return 2;
          }
          ctx = await buildRunCtx({
            env, agentId, sandbox: sandboxFlag ?? 'host',
            permissionMode: modeFlag ?? undefined,
            onAsk: makePermissionPrompt() ?? undefined,
            log: { info: stdout, warn: stderr, error: stderr, debug: () => {} },
          });
        } catch (e) { stderr(`run: ${e.message || e}`); return 1; }
    const taskId = newTaskId();
    const maxSteps = readFlags(args.flags, 'max-steps', 'maxSteps') ?? 16;
    const model = readFlags(args.flags, 'model');
    // A4: --prompt=<name> or --prompt=<name>@<hash> pins the exact instruction
    // bytes; the resolved hash rides on the task event so a replay can prove
    // which version ran.
    const promptRef = readFlags(args.flags, 'prompt');
    let systemPrompt = renderCliDefault({
      cwd: process.cwd(),
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      sandboxMode: ctx.sandboxMode,
      tools: ctx.registry.list().map((t) => t.name).join(', '),
    });
    // Fase 5: hierarchical project instructions (NEXUS.md > AGENTS.md > CLAUDE.md)
    {
      const { loadProjectDocs } = await import('./project-doc.js');
      const docs = loadProjectDocs(process.cwd());
      if (docs.text) {
        stderr(`project instructions: ${docs.files.join(', ')}${docs.truncated ? ' (truncated)' : ''}`);
        systemPrompt += '\n\n' + docs.text;
      }
    }
    if (typeof promptRef === 'string' && promptRef) {
      if (!ctx.prompts) throw new Error('prompts registry unavailable (buildRunCtx did not wire @nexus/prompts)');
      const [pName, pHash] = promptRef.split('@');
      const v = ctx.prompts.resolve(pName, pHash ?? null);
      if (!v) throw new Error(`unknown prompt reference: ${promptRef}`);
      systemPrompt = v.body;
      ctx.promptVersion = { name: v.name, hash: v.hash };
    }

    const started = makeEvent('task.started',
      { task: args.task, taskId, agentId, ...(ctx.promptVersion ? { prompt: ctx.promptVersion } : {}) }, taskId);
    await ctx.store.append(started);

    // Fase 6h: --worktree runs the session in a detached git worktree
    let worktreeDir = null;
    if (readFlags(args.flags, 'worktree')) {
      const { isRepo, addWorktree } = await import('./git.js');
      if (!(await isRepo(process.cwd()))) { stderr('--worktree: not a git repo'); return 2; }
      worktreeDir = `nexus-wt-${taskId.slice(0, 8)}`;
      await addWorktree(process.cwd(), worktreeDir);
      process.chdir(join(process.cwd(), worktreeDir));
      stderr(`worktree: ${worktreeDir}`);
    }
    // Fase 6h: warn when the working tree is dirty
    {
      const { isRepo, isDirty, status } = await import('./git.js');
      if (await isRepo(process.cwd())) {
        if (await isDirty(process.cwd())) {
          const lines = (await status(process.cwd())).split('\n').length;
          stderr(`warning: working tree is dirty (${lines} changed path(s)) — /rewind or git diff to review`);
        }
      }
    }

    // Fase 6b: UserPromptSubmit hooks — blocked turns stop before the model
    {
      const { runHooks, loadHooks } = await import('./hooks.js');
      const h = await runHooks(loadHooks(process.cwd()), 'UserPromptSubmit', { prompt: args.task }, { cwd: process.cwd() });
      if (h.blocked) {
        stderr(`blocked by hook: ${h.feedback}`);
        return 2;
      }
    }

    // C1: --continue resumes latest session in cwd; --resume=<id> picks one.
    const resumeId = readFlags(args.flags, 'resume');
    const wantContinue = args.flags.continue === true || args.flags.c === true;
    let history = null;
    let sessionId = newSessionId();
    if (resumeId || wantContinue) {
      const found = findSession('.nexus/store', { id: resumeId ?? null, cwd: wantContinue ? process.cwd() : null });
      if (!found) {
        stderr(resumeId ? `run: no session matches ${resumeId}` : 'run: no previous session in this directory');
        return 1;
      }
      sessionId = found.id;
      history = await replaySessionHistory(ctx.store, sessionId);
      recordSession('.nexus/store', { id: sessionId, cwd: process.cwd(), subject: args.task });
      stdout(`resuming session ${sessionId} (${history.length} prior messages)`);
    } else {
      recordSession('.nexus/store', { id: sessionId, cwd: process.cwd(), subject: args.task });
    }
    emitSessionEvents(ctx.bus, sessionId, { user: args.task });

    // C2: Ctrl+C once aborts the current turn; twice exits.
    const abort = new AbortController();
    let sigintCount = 0;
    const onSigint = () => {
      sigintCount++;
      if (sigintCount === 1) { stderr('(interrupted — aborting current turn, Ctrl+C again to exit)'); abort.abort(); }
      else process.exit(130);
    };
    process.once('SIGINT', onSigint);

    const loop = new AgentLoop({
      provider: ctx.provider,
      tools: ctx.tools,
      bus: ctx.bus,
      ...(model ? { model } : {}),
    });
    try {
      const result = await loop.run(args.task, {
        agentId,
        sandbox: ctx.sandboxId,
        runtime: ctx.runtime,
        hostRoot: ctx.hostRoot,
        sandboxId: ctx.sandboxId,
        maxSteps,
        env: ctx.env,
        system: systemPrompt,
        signal: abort.signal,
        ...(history ? { history } : {}),
      });
      const ok = result?.done === true;
      emitSessionEvents(ctx.bus, sessionId, { assistant: result?.answer ?? '' });
      // Fase 6b: Stop hooks (tests/lints after the turn)
      {
        const { runHooks, loadHooks } = await import('./hooks.js');
        const h = await runHooks(loadHooks(process.cwd()), 'Stop', { task: args.task, ok: true }, { cwd: process.cwd() });
        if (h.blocked) stderr(`stop hook flagged: ${h.feedback}`);
      }
      // Fase 6f: plan mode — save the produced plan for review
      if (ctx.permissionMode === 'plan') {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        md(join(process.cwd(), '.nexus', 'plans'), { recursive: true });
        wf(join(process.cwd(), '.nexus', 'plans', `${agentId.slice(0, 12)}.md`), `# plan — ${args.task}\n\n${result?.answer ?? ''}\n`);
        stderr(`plan saved: .nexus/plans/${agentId.slice(0, 12)}.md — review then /plan approve (REPL) or rerun without --permission-mode=plan`);
      }
      const ended = makeEvent('task.ended', {
        taskId, agentId, ok,
        ...(ok ? { summary: result?.answer?.slice(0, 500) } : { reason: 'max_steps', steps: result?.steps }),
      }, taskId);
      await ctx.store.append(ended);
      if (!ok) {
        stderr(`run: berhenti di ${result?.steps} langkah, task belum selesai; lanjutkan dengan \`nexus --continue\``);
        return 1;
      }
      stdout('--- task done ---');
      stdout(result?.answer ?? '(no content)');
      // Fase 6h: --auto-commit still requires explicit confirmation
      if (readFlags(args.flags, 'auto-commit')) {
        const { isRepo, commit } = await import('./git.js');
        if (await isRepo(process.cwd())) {
          const msg = `nexus: ${String(args.task).slice(0, 60)}`;
          if (process.stdout.isTTY) {
            const { makePermissionPrompt } = await import('./permissions-prompt.js');
            const ask = makePermissionPrompt({ stdin: process.stdin, stdout: process.stdout });
            const okc = await ask({ tool: 'git.commit', args: { message: msg } });
            if (okc) {
              const sha = await commit(process.cwd(), msg);
              stderr(`committed ${sha.slice(0, 10)} (never pushed)`);
            } else stderr('commit skipped');
          } else stderr('auto-commit needs a TTY to confirm — skipped (nothing committed)');
        }
      }
      return 0;
    } catch (e) {
      const ended = makeEvent('task.ended', { taskId, agentId, ok: false, error: e.message }, taskId);
      try { await ctx.store.append(ended); } catch {}
      stderr('run failed:', e.message);
      return 1;
    } finally {
      process.removeListener('SIGINT', onSigint);
      await closeCtx(ctx);
    }
  }

  stderr('unknown command:', args.cmd, '\n', HELP);
  return 2;
}
