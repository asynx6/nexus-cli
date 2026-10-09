// Hard denylist + permission modes + persistent rules (.nexus/settings.json).
// The denylist can NOT be relaxed, even in auto mode. Pattern matching splits
// compound commands (;, &&, ||, |, $(), backticks) and checks each segment.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PERMISSION_MODES = ['ask', 'accept-edits', 'plan', 'auto'];

/** Commands that are always denied regardless of grants or mode. */
const HARD_DENY_COMMANDS = [
  /^rm\s+(-[a-z]*\s+)*-?[rf]{1,2}[a-z]*\s+.*\/(\s|$)/,       // rm -rf /
  /^rm\s+(-[a-z]*\s+)*.*\s+\/(\s|$)/,                         // rm ... /
  /\bmkfs(\.[a-z0-9]+)?\b/,                                   // format disk
  /\bdd\s+.*of=\/dev\/(sd|nvme|vd)/,                          // dd to raw disk
  />\s*\/dev\/sd[a-z]/,                                       // redirect to raw disk
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,
  /\bchmod\s+-R\s+0?\d{3,4}\s+\/(?!\s)/,                     // chmod -R 777 /
  /\b:()\{\s*:\|\:&\s*\};:/,                                  // fork bomb
];

/** Path patterns never writable regardless of mode. */
const HARD_DENY_PATHS = [
  /^\/etc\//, /^\/boot\//, /^\/dev\//, /^\/proc\//, /^\/sys\//,
  /^\/root\//, /^\/home\/[^/]+\/\.ssh\//, /^\/\.ssh\//,
  /(^|\/)\.git\/config$/, /(^|\/)id_rsa($|\.)/, /(^|\/)id_ed25519($|\.)/,
  /^\/(usr|bin|sbin|lib|lib64|var)\//,
  /(^|\/)\.env-gateway$/, /(^|\/)\.nexus\/secrets\.enc$/, /(^|\/)credentials\.json$/,
];

export function isHardDeniedCommand(command) {
  if (typeof command !== 'string') return false;
  // split compound commands; check every segment
  const segments = command.split(/(?:&&|\|\||;|\||`|\$\(|\)$)/g).map((s) => s.trim()).filter(Boolean);
  return segments.some((seg) => HARD_DENY_COMMANDS.some((re) => re.test(seg)));
}

export function isHardDeniedPath(p) {
  if (typeof p !== 'string') return false;
  return HARD_DENY_PATHS.some((re) => re.test(p));
}

/** Does this tool+args mutate anything? (plan mode only allows reads) */
export function isWriteAction(tool, args = {}) {
  if (/^fs\.(write|edit|upload|download)$/.test(tool)) return tool !== 'fs.download';
  if (tool === 'terminal.exec') return true; // any exec can mutate
  return false;
}

export function isReadTool(tool) {
  return /^fs\.(read|glob|grep|list)$/.test(tool) || tool === 'repo.map' || tool === 'terminal.output' || tool === 'todo.read';
}

// ---- persistent rules ----------------------------------------------------

export function loadSettings(dir = process.cwd()) {
  const p = join(dir, '.nexus', 'settings.json');
  if (!existsSync(p)) return { permissions: { allow: [], deny: [], defaultMode: 'ask' } };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (!doc.permissions) doc.permissions = { allow: [], deny: [], defaultMode: 'ask' };
    return doc;
  } catch { return { permissions: { allow: [], deny: [], defaultMode: 'ask' } }; }
}

export function saveSettings(dir, settings) {
  const p = join(dir, '.nexus', 'settings.json');
  mkdirSync(join(dir, '.nexus'), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2));
}

/** glob-ish rule match: "terminal.exec:npm test" matches that exact command;
 *  "terminal.exec:rm -rf*" matches any command starting with "rm -rf";
 *  "fs.write:.env*" matches paths starting with .env. */
function ruleMatches(rule, tool, args) {
  const [ruleTool, ruleArg] = rule.split(':', 2);
  if (ruleTool !== tool) return false;
  if (ruleArg === undefined) return true; // whole tool
  if (tool === 'terminal.exec') {
    const cmd = String(args.command ?? '');
    return ruleArg.endsWith('*') ? cmd.startsWith(ruleArg.slice(0, -1)) : cmd === ruleArg;
  }
  if (tool === 'web.fetch') {
    // rule arg is a hostname or host suffix ("example.com" matches
    // https://api.example.com/x)
    let host = '';
    try { host = new URL(String(args.url ?? '')).hostname; } catch { return false; }
    return host === ruleArg || host.endsWith('.' + ruleArg);
  }
  // fs-like: match path (relative or absolute tail)
  const p = String(args.path ?? '');
  if (ruleArg.endsWith('*')) {
    const prefix = ruleArg.slice(0, -1);
    return p.startsWith(prefix) || p.endsWith(ruleArg) || p.includes(prefix);
  }
  return p === ruleArg || p.endsWith('/' + ruleArg) || p.endsWith('\\' + ruleArg);
}

/** Evaluate persistent allow/deny rules. Returns 'allow' | 'deny' | null. */
export function evalRules(settings, tool, args) {
  const perms = settings.permissions ?? {};
  for (const rule of perms.deny ?? []) {
    if (ruleMatches(rule, tool, args)) return 'deny';
  }
  for (const rule of perms.allow ?? []) {
    if (ruleMatches(rule, tool, args)) return 'allow';
  }
  return null;
}
