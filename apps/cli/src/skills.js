// Skills (Fase 6c): .nexus/skills/<name>/SKILL.md with frontmatter
// (name, description, disallowed-tools?). Only name+description enter the
// system prompt; the body loads on invocation (/name or the skill.load tool).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BODY_BYTES = 120_000;

/** Parse SKILL.md: `---\nkey: value\n---\nbody` */
export function parseSkillMd(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

/**
 * Scan .nexus/skills. Returns { name: { name, description, disallowedTools,
 * body, path } } — body excluded from prompt assembly by the caller.
 */
export function loadSkills(dir = process.cwd()) {
  const root = join(dir, '.nexus', 'skills');
  const out = {};
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    try {
      const { meta, body } = parseSkillMd(readFileSync(file, 'utf8'));
      if (!meta.name || !meta.description) continue;
      out['/' + meta.name] = {
        name: meta.name,
        description: meta.description,
        disallowedTools: meta['disallowed-tools'] ? meta['disallowed-tools'].split(',').map((s) => s.trim()).filter(Boolean) : [],
        body: body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) + '\n[... truncated]' : body,
        path: file,
      };
    } catch { /* unreadable skill — skip */ }
  }
  return out;
}

/** Render the skill index for the system prompt (names + descriptions only). */
export function renderSkillIndex(skills) {
  const names = Object.keys(skills);
  if (!names.length) return '';
  return [
    '## skills',
    'Invoke a skill with its slash command to load its instructions.',
    ...names.map((n) => `- ${n}: ${skills[n].description}`),
  ].join('\n');
}
