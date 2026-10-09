// Slash commands (Fase 3): built-ins + custom from .nexus/commands/*.md.
// Custom file body = prompt template; $ARGUMENTS replaced with the rest of
// the line. Built-ins are handled by the REPL; unknown /x checks custom.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILTIN_SLASH = [
  '/help', '/clear', '/model', '/compact', '/plan', '/permissions',
  '/cost', '/status', '/resume', '/rewind', '/doctor', '/init', '/memory',
  '/skills', '/reload-skills', '/mcp', '/diff', '/exit',
];

/** Parse "/cmd arg1 arg2" -> { cmd: '/cmd', args: 'arg1 arg2' } */
export function parseSlash(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const sp = trimmed.indexOf(' ');
  const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const args = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  return { cmd, args };
}

/** Load custom commands: .nexus/commands/*.md -> { '/name': template } */
export function loadCustomCommands(dir = process.cwd()) {
  const out = {};
  const p = join(dir, '.nexus', 'commands');
  if (!existsSync(p)) return out;
  for (const f of readdirSync(p)) {
    if (!f.endsWith('.md')) continue;
    const name = '/' + f.slice(0, -3);
    try { out[name] = readFileSync(join(p, f), 'utf8'); } catch { /* skip unreadable */ }
  }
  return out;
}

/** Resolve a slash line to either a built-in or a custom prompt.
 *  @returns {{ kind: 'builtin', cmd: string, args: string } |
 *            { kind: 'custom', cmd: string, prompt: string } | null } */
export function resolveSlash(line, customCommands = {}) {
  const parsed = parseSlash(line);
  if (!parsed) return null;
  if (BUILTIN_SLASH.includes(parsed.cmd)) return { kind: 'builtin', ...parsed };
  if (customCommands[parsed.cmd]) {
    const prompt = customCommands[parsed.cmd].replaceAll('$ARGUMENTS', parsed.args);
    return { kind: 'custom', cmd: parsed.cmd, prompt };
  }
  return null;
}
