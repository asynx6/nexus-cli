// Hooks (Fase 6b): external commands reacting to agent lifecycle, from
// .nexus/settings.json. Contract: JSON event on stdin; exit 0 = continue;
// exit 2 = block + stderr becomes model feedback; stdout JSON optionally
// patches input/adds context. No shell unless asked. Per-hook timeout.
import { spawn } from 'node:child_process';
import { loadSettings } from '@nexus/security';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'];
const DEFAULT_TIMEOUT_MS = 30_000;

/** @returns {Record<string, Array<{match?: string, command: string, shell?: boolean, timeoutMs?: number}>>} */
export function loadHooks(dir = process.cwd()) {
  const settings = loadSettings(dir);
  const hooks = settings.hooks ?? {};
  const out = {};
  for (const k of HOOK_EVENTS) if (Array.isArray(hooks[k])) out[k] = hooks[k];
  return out;
}

function matches(hook, payload) {
  if (!hook.match) return true;
  // match is an alternation of literals: "fs.edit|fs.write" — escape each
  // alternative, then join with |
  const re = new RegExp('^(' + hook.match.split('|').map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$');
  const target = payload?.tool ?? payload?.event ?? '';
  return re.test(String(target));
}

/**
 * Run all hooks for an event. Returns { blocked: boolean, feedback?: string,
 * patch?: object, ran: number } — blocked=true means the caller must stop the
 * action and feed `feedback` to the model.
 */
export async function runHooks(hooksMap, event, payload, { cwd = process.cwd() } = {}) {
  const list = hooksMap?.[event] ?? [];
  let ran = 0;
  let patch = null;
  for (const hook of list) {
    if (!hook || typeof hook.command !== 'string') continue;
    if (!matches(hook, payload)) continue;
    const res = await runOne(hook, event, payload, cwd);
    ran++;
    if (res.blocked) return { blocked: true, feedback: res.stderr, ran };
    if (res.patch) patch = { ...(patch ?? {}), ...res.patch };
  }
  return { blocked: false, ran, ...(patch ? { patch } : {}) };
}

function runOne(hook, event, payload, cwd) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(hook.timeoutMs) && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // no shell by default: tokenize simple argv, honor shell:true opt-in
    const argv = hook.shell
      ? ['/bin/sh', '-c', hook.command]
      : Array.isArray(hook.args) && hook.args.length ? [hook.command, ...hook.args] : tokenize(hook.command);
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ blocked: false, stderr: String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ blocked: false, stderr: `hook timed out after ${timeoutMs}ms: ${hook.command}` }); return; }
      if (code === 2) { resolve({ blocked: true, stderr: stderr.trim() || `blocked by hook: ${hook.command}` }); return; }
      // optional stdout JSON patch
      let patch = null;
      try { const j = JSON.parse(stdout.trim()); if (j && typeof j === 'object') patch = j; } catch { /* not json */ }
      resolve({ blocked: false, patch, stderr });
    });
    child.stdin.write(JSON.stringify({ event, ...payload }));
    child.stdin.end();
  });
}

/** minimal quote-aware tokenizer (same rules as terminal.exec) */
function tokenize(input) {
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
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}
