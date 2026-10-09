// Project instructions loader (Fase 5): hierarchical NEXUS.md with
// AGENTS.md / CLAUDE.md fallback, @path imports, size cap + truncation report.
// Zero runtime deps.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const MAX_TOTAL_BYTES = 60_000; // ~15k tokens of instructions is plenty
const MAX_IMPORT_DEPTH = 5;

const CANDIDATES = ['NEXUS.md', 'AGENTS.md', 'CLAUDE.md'];

/** Find the instruction file for a directory (NEXUS.md > AGENTS.md > CLAUDE.md). */
export function findProjectDoc(dir) {
  for (const name of CANDIDATES) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return { path: p, name };
  }
  return null;
}

/**
 * Load the full instruction stack for a working directory:
 *   ~/.nexus/NEXUS.md  (global)
 *   <root>/NEXUS.md    (project root = cwd)
 *   <nested>/NEXUS.md  (dirs between root and cwd, nearest last)
 * Sections are joined with a header naming each file. `@path` lines import
 * other files (relative to the including file, or absolute).
 * Returns { text, files, truncated, bytes }.
 */
export function loadProjectDocs(rootDir, cwd = rootDir) {
  const root = resolve(rootDir);
  const dirs = [];
  // global first
  const globalDir = join(homedir(), '.nexus');
  const g = findProjectDoc(globalDir);
  if (g) dirs.push({ dir: globalDir, label: '~/.nexus/' + g.name });
  // project root
  const r = findProjectDoc(root);
  if (r) dirs.push({ dir: root, label: r.name });
  // nested dirs between root and cwd (when cwd is deeper)
  const cw = resolve(cwd);
  if (cw.startsWith(root + '/')) {
    let d = cw;
    const nested = [];
    while (d.startsWith(root + '/') && d !== root) {
      const f = findProjectDoc(d);
      if (f && !(d === root)) nested.push({ dir: d, label: f.name + ' (' + d.slice(root.length) + ')' });
      d = dirname(d);
    }
    dirs.push(...nested.reverse());
  }

  const files = [];
  const sections = [];
  let bytes = 0;
  let truncated = false;
  for (const { dir, label } of dirs) {
    const found = findProjectDoc(dir);
    if (!found) continue;
    const { text, truncated: t } = expandImports(found.path, bytes);
    if (text === null) continue; // budget already spent
    bytes += Buffer.byteLength(text, 'utf8');
    if (t) truncated = true;
    files.push(found.path);
    sections.push(`## project instructions: ${label}\n\n${text}`);
    if (bytes >= MAX_TOTAL_BYTES) { truncated = true; break; }
  }
  if (!sections.length) return { text: '', files: [], truncated: false, bytes: 0 };
  return { text: sections.join('\n\n'), files, truncated, bytes };
}

/** Expand `@path` import lines (max depth 5). A line that is exactly
 *  `@<path>` (leading @, optional quotes) is replaced by the file content. */
function expandImports(filePath, budgetSpent, depth = 0) {
  if (depth > MAX_IMPORT_DEPTH) return { text: '[import depth limit reached]', truncated: true };
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return { text: null, truncated: false }; }
  const lines = raw.split('\n');
  const out = [];
  let truncated = false;
  for (const line of lines) {
    const m = /^@("([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(line.trim());
    if (!m) { out.push(line); continue; }
    const target = resolve(dirname(filePath), m[2] ?? m[3] ?? m[4]);
    if (!existsSync(target)) { out.push(`[missing import: ${line.trim()}]`); truncated = true; continue; }
    const sub = expandImports(target, budgetSpent, depth + 1);
    if (sub.text === null) { out.push('[import budget exceeded]'); truncated = true; continue; }
    out.push(sub.text);
    if (sub.truncated) truncated = true;
  }
  let text = out.join('\n');
  const remaining = MAX_TOTAL_BYTES - budgetSpent;
  if (Buffer.byteLength(text, 'utf8') > remaining) {
    text = Buffer.from(text, 'utf8').slice(0, Math.max(0, remaining)).toString('utf8')
      + '\n[... instructions truncated to fit the budget]';
    truncated = true;
  }
  return { text, truncated };
}

/**
 * Scaffold an initial NEXUS.md by scanning the repo (for /init).
 * Uses repo.map-style symbol extraction when available, else file listing.
 */
export function scaffoldProjectDoc({ files, symbols, projectName }) {
  const byLang = {};
  for (const [f, syms] of Object.entries(symbols ?? {})) {
    const ext = f.split('.').pop();
    byLang[ext] = (byLang[ext] ?? 0) + syms.length;
  }
  const topFiles = (files ?? []).filter((f) => !f.startsWith('.')).slice(0, 30);
  return `# NEXUS.md — ${projectName}

## Project
TODO: satu paragraf — apa proyek ini, untuk siapa.

## Structure
${topFiles.map((f) => `- \`${f}\`${symbols?.[f] ? ` — ${symbols[f].slice(0, 5).map((s) => s.name).join(', ')}` : ''}`).join('\n') || '- (empty)'}

## Conventions
- TODO: style guide, naming, test command (mis. \`npm test\`)
- TODO: hal yang JANGAN dilakukan agent di repo ini

## Commands
- build: TODO
- test: TODO
- lint: TODO

## Notes
- Dokumen ini dimuat otomatis oleh nexus sebagai instruksi proyek.
- Import file lain dengan baris \`@path/ke/file.md\`.
`;
}
