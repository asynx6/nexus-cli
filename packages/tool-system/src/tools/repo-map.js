// repo.map — lightweight regex symbol map so the agent can grok a large repo
// without reading every file. JS/TS, Python, Go, Rust, Pawn (.pwn/.inc).
// Cached in .nexus/cache/repo-map.json keyed by mtime+size of each file.
import { EVENTS } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';
import { requireSandbox, safePath } from './_sandbox.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILES = 2000;
const MAX_SYMBOLS_PER_FILE = 300;

// per-language symbol patterns: name capture group must be index 1
const LANGS = [
  { ext: /\.(js|mjs|cjs|ts|tsx|jsx)$/, name: 'js', patterns: [
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  ] },
  { ext: /\.py$/, name: 'py', patterns: [
    /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/,
  ] },
  { ext: /\.go$/, name: 'go', patterns: [
    /(?:^|\n)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /(?:^|\n)type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/,
  ] },
  { ext: /\.rs$/, name: 'rs', patterns: [
    /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
    /(?:^|\n)\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  ] },
  { ext: /\.(pwn|inc)$/, name: 'pawn', patterns: [
    { re: /(?:^|\n)\s*(?:public|stock|native)\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
    { re: /(?:^|\n)\s*forward\s+([A-Za-z_]\w*)/, kind: 'forward' },
    { re: /(?:^|\n)\s*#define\s+([A-Za-z_]\w*)/, kind: 'define' },
  ] },
];

export function repoMapTools({ cacheDir = join(process.cwd(), '.nexus', 'cache') } = {}) {
  return [
    {
      name: 'repo.map',
      description: 'Build a symbol map of the project (functions/classes/defines in JS/TS, Python, Go, Rust, Pawn). Cached in .nexus/cache; re-scans only changed files. Max 2000 files.',
      permission: 'repo.map',
      timeoutMs: 120_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'directory inside the sandbox to map (default project root)' },
          refresh: { type: 'boolean', description: 'ignore the cache and rescan' },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const base = args.path ? safePath(args.path, { hostRoot }) : (hostRoot ?? '/');
        const out = await runtime.exec(sandboxId,
          ['find', hostRoot ? '.' : base, '-type', 'f', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*'],
          hostRoot ? { workdir: base } : {});
        if (out.exitCode !== 0) throw new Error(`scan failed: ${out.stderr.trim() || out.exitCode}`);
        // normalize both layouts to paths RELATIVE to base:
        // host: "./x.js" -> "x.js"; docker abs: "/workspace/x.js" -> "x.js"
        const prefix = base.endsWith('/') ? base : base + '/';
        let files = out.stdout.split('\n').filter(Boolean).map((l) => {
          let f = l.replace(/^\.\//, '');
          if (f.startsWith(prefix)) f = f.slice(prefix.length);
          return f;
        });
        const candidates = files.filter((f) => LANGS.some((l) => l.ext.test(f.split('/').pop())));
        if (candidates.length > MAX_FILES) throw new Error(`too many source files (${candidates.length} > ${MAX_FILES})`);

        // cache: file -> { mtime, size, syms }
        const cacheFile = join(cacheDir, 'repo-map.json');
        let cache = {};
        try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* fresh */ }
        if (args.refresh) cache = {};

        const stats = await runtime.exec(sandboxId,
          ['find', hostRoot ? '.' : base, '-type', 'f', '-printf', '%T@ %s %p\n', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*'],
          hostRoot ? { workdir: base } : {});
        const statMap = new Map();
        for (const line of stats.stdout.split('\n')) {
          const m = /^(\d+(?:\.\d+)?) (\d+) (.+)$/.exec(line);
          if (m) {
            let f = m[3].replace(/^\.\//, '');
            if (f.startsWith(prefix)) f = f.slice(prefix.length);
            statMap.set(f, { mtime: m[1], size: m[2] });
          }
        }

        const map = {};
        let scanned = 0;
        let cached = 0;
        for (const f of candidates) {
          const st = statMap.get(f);
          const key = f;
          if (st && cache[key] && cache[key].mtime === st.mtime && cache[key].size === st.size) {
            map[f] = cache[key].syms;
            cached++;
            continue;
          }
          const r = await runtime.exec(sandboxId, ['cat', joinPosix(base, f)], hostRoot ? { workdir: base } : {});
          if (r.exitCode !== 0) continue;
          const syms = extractSymbols(f.split('/').pop(), r.stdout);
          map[f] = syms;
          cache[key] = { mtime: st?.mtime ?? null, size: st?.size ?? null, syms };
          scanned++;
        }
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(cache));

        const totalSyms = Object.values(map).reduce((a, s) => a + s.length, 0);
        if (ctx.bus) ctx.bus.emit(makeEvent(EVENTS.REPO_MAPPED, { path: base, files: Object.keys(map).length, symbols: totalSyms, scanned, cached }, ctx.agentId ?? null));
        return { path: base, files: Object.keys(map).length, symbols: totalSyms, scanned, cached, map };
      },
    },
  ];
}

export function extractSymbols(fileName, source) {
  const lang = LANGS.find((l) => l.ext.test(fileName));
  if (!lang) return [];
  const seen = new Set();
  const syms = [];
  for (const p of lang.patterns) {
    const re = p.re ?? p;
    const kind = p.kind ?? kindOf(p);
    for (const m of source.matchAll(new RegExp(re.source, 'g'))) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const line = source.slice(0, m.index).split('\n').length;
      syms.push({ name, kind, line });
      if (syms.length >= MAX_SYMBOLS_PER_FILE) return syms;
    }
  }
  return syms;
}

function kindOf(re) {
  const src = re.source;
  if (src.includes('class')) return 'class';
  if (src.includes('fn') || src.includes('def') || src.includes('func')) return 'function';
  if (src.includes('struct') || src.includes('enum') || src.includes('trait')) return 'type';
  if (src.includes('#define')) return 'define';
  return 'symbol';
}

function joinPosix(a, b) {
  if (!b) return a;
  if (a.endsWith('/')) return a + b;
  return a + '/' + b;
}
