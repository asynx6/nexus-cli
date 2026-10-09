// Filesystem tools — always operate INSIDE the sandbox via SandboxRuntime,
// never on the host (plan §5: the agent's files live in the container).
// read/exec use `exec`; write uses copyIn (tar upload); edit is a
// read-modify-write with exact-match semantics, like a disciplined sed.
import { EVENTS } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';
import { requireSandbox, safePath } from './_sandbox.js';
import { unifiedDiff, splitLines } from './diff.js';

const MAX_BYTES = 1_048_576; // 1 MiB per read/write — keeps tool payloads sane
const MAX_BIN_BASE64 = 11_010_000; // 8 MiB decoded — binary transfer cap for upload/download
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_RESULTS = 200;

function looksBinary(buf) {
  // NUL anywhere, or >10% control chars in the first 8 KiB -> binary
  const probe = buf.slice(0, 8192);
  let ctrl = 0;
  for (const b of probe) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return probe.length > 0 && ctrl / probe.length > 0.1;
}

/** Decode with BOM detection; returns { text, bom, eol } */
function decodeText(buf) {
  let bom = null;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom = 'utf8';
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) bom = 'utf16be';
  else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) bom = 'utf16le';
  const text = buf.toString('utf8');
  const eol = text.includes('\r\n') && !text.split('\r\n').some((l) => l.endsWith('\r')) ? 'crlf' : 'lf';
  return { text: bom ? text.replace(/^\uFEFF/, '') : text, bom, eol };
}

function emit(ctx, name, data) {
  if (ctx.bus) ctx.bus.emit(makeEvent(name, data, ctx.agentId ?? null));
}

export function fsTools() {
  return [
    {
      name: 'fs.read',
      description: 'Read a text file inside the sandbox (max 1 MiB). offset/limit are line numbers (1-based, inclusive). Binary files are refused with a hint to fs.download.',
      permission: 'fs.read',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path inside the sandbox' },
          offset: { type: 'number', description: 'first line to return (1-based)' },
          limit: { type: 'number', description: 'max lines to return' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const p = safePath(args.path, { hostRoot });
        const st = await runtime.exec(sandboxId, ['test', '-f', p]);
        if (st.exitCode !== 0) throw new Error(`no such file: ${p}`);
        const r = await runtime.exec(sandboxId, ['cat', p]);
        if (r.exitCode !== 0) throw new Error(`read failed: ${r.stderr.trim() || r.exitCode}`);
        const buf = Buffer.from(r.stdout, 'utf8');
        if (looksBinary(buf)) throw new Error('binary file detected — use fs.download for base64 transfer');
        const bytes = buf.length;
        if (bytes > MAX_BYTES) throw new Error(`file too large (${bytes} > ${MAX_BYTES} bytes)`);
        const all = splitLines(r.stdout);
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = args.limit === undefined ? Infinity : Math.max(0, Number(args.limit));
        const slice = all.slice(offset - 1, offset - 1 + limit);
        const lines = slice.map((l, idx) => `${offset + idx}\t${l.replace(/\r?\n$/, '')}`);
        return {
          path: p, bytes, total_lines: all.length,
          offset, limit: Number.isFinite(limit) ? limit : null,
          content: lines.join('\n'),
        };
      },
    },
    {
      name: 'fs.write',
      description: 'Create or overwrite a text file inside the sandbox (max 1 MiB). Parent directory must exist.',
      permission: 'fs.write',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const p = safePath(args.path, { hostRoot });
        if (Buffer.byteLength(args.content, 'utf8') > MAX_BYTES) throw new Error('content exceeds 1 MiB');
        const exists = (await runtime.exec(sandboxId, ['test', '-f', p])).exitCode === 0;
        // copyIn needs the parent dir; create it (absolute canonical path,
        // already permission-checked, so the mkdir stays inside allowed roots)
        await runtime.exec(sandboxId, ['mkdir', '-p', p.slice(0, p.lastIndexOf('/')) || '/']);
        await runtime.copyIn(sandboxId, [{ path: p, content: args.content }]);
        emit(ctx, exists ? EVENTS.FILE_MODIFIED : EVENTS.FILE_CREATED, { path: p, bytes: Buffer.byteLength(args.content, 'utf8') });
        return { path: p, created: !exists, bytes: Buffer.byteLength(args.content, 'utf8') };
      },
    },
    {
      name: 'fs.edit',
      description: 'Edit a sandbox file: one or several replacements applied atomically in order. old_text must match exactly once (pass all=true for every occurrence); whitespace-tolerant matching is tried when the exact match fails. Returns a unified diff.',
      permission: 'fs.write',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          all: { type: 'boolean', description: 'replace every occurrence (default false)' },
          edits: {
            type: 'array',
            description: 'multiple replacements applied in order (mutually exclusive with old_text/new_text)',
            items: {
              type: 'object',
              properties: { old_text: { type: 'string' }, new_text: { type: 'string' }, all: { type: 'boolean' } },
              required: ['old_text', 'new_text'],
              additionalProperties: false,
            },
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const p = safePath(args.path, { hostRoot });
        const edits = Array.isArray(args.edits) && args.edits.length
          ? args.edits
          : [{ old_text: args.old_text, new_text: args.new_text, all: args.all }];
        if (!edits.length) throw new Error('no edits given');
        const rd = await fsReadAt(runtime, sandboxId, p);
        const original = rd;
        let updated = rd;
        const applied = [];
        for (const [idx, e] of edits.entries()) {
          const res = applyEdit(updated, e);
          if (!res.ok) throw new Error(`edit ${idx + 1}: ${res.reason}`);
          applied.push(res.replacements);
          updated = res.text;
        }
        if (updated === original) throw new Error('no changes applied (new_text identical)');
        if (Buffer.byteLength(updated, 'utf8') > MAX_BYTES) throw new Error('result exceeds 1 MiB');
        await runtime.copyIn(sandboxId, [{ path: p, content: updated }]);
        const diff = unifiedDiff(original, updated, { fromFile: p, toFile: p, context: 3 });
        emit(ctx, EVENTS.FILE_MODIFIED, { path: p, replacements: applied.reduce((a, b) => a + b, 0) });
        return { path: p, replacements: applied, diff };
      },
    },
    {
      name: 'fs.download',
      description: 'Fetch a file from the sandbox as base64 (binary-safe, max 8 MiB). Use for images, archives, audio.',
      permission: 'fs.read',
      timeoutMs: 30_000,
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'absolute path inside the sandbox' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const p = safePath(args.path, { hostRoot });
        if (!p) throw new Error('invalid path');
        const st = await runtime.exec(sandboxId, ['test', '-f', p]);
        if (st.exitCode !== 0) throw new Error(`no such file: ${p}`);
        const r = await runtime.exec(sandboxId, ['base64', '-w0', p]);
        if (r.exitCode !== 0) throw new Error(`download failed: ${r.stderr.trim() || r.exitCode}`);
        if (r.stdout.length > MAX_BIN_BASE64) throw new Error('file exceeds 8 MiB download cap');
        emit(ctx, EVENTS.FILE_READ, { path: p, bytes: Math.floor(r.stdout.length * 3 / 4) });
        return { path: p, encoding: 'base64', content: r.stdout };
      },
    },
    {
      name: 'fs.upload',
      description: 'Write base64 content to a path in the sandbox (binary-safe, max 8 MiB). Use for images, archives, audio.',
      permission: 'fs.write',
      timeoutMs: 30_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute destination path inside the sandbox' },
          content: { type: 'string', description: 'base64-encoded file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const p = safePath(args.path, { hostRoot });
        if (!p) throw new Error('invalid path');
        if (typeof args.content !== 'string' || args.content.length === 0) throw new Error('content is required (base64)');
        if (args.content.length > MAX_BIN_BASE64) throw new Error('content exceeds 8 MiB upload cap');
        // decode host-side, copy the raw bytes in — copyIn handles binary.
        const buf = Buffer.from(args.content, 'base64');
        await runtime.copyIn(sandboxId, [{ path: p, content: buf }]);
        emit(ctx, EVENTS.FILE_MODIFIED, { path: p, bytes: buf.length });
        return { path: p, bytes: buf.length };
      },
    },
    {
      name: 'fs.glob',
      description: 'List files matching a glob pattern (supports **, *, ?), respecting .gitignore. Max 500 results.',
      permission: 'fs.read',
      timeoutMs: 30_000,
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'e.g. **\/*.js or src\/\/**\/*.ts' },
          cwd: { type: 'string', description: 'base directory inside the sandbox (default /)' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const base = args.cwd ? safePath(args.cwd, { hostRoot }) : (hostRoot ?? '/');
        const out = await sandboxSh(runtime, sandboxId, base,
          ['find', '.', '-type', 'f', '-not', '-path', '*/.git/*']);
        if (out.exitCode !== 0) throw new Error(`glob failed: ${out.stderr.trim() || out.exitCode}`);
        let files = out.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''));
        // gitignore-aware: ask git which files it tracks/ignores
        const ignored = await gitIgnored(runtime, sandboxId, base);
        if (ignored) files = files.filter((f) => !ignored.has(f) && !ignored.has(f.replace(/^\.\//, '')));
        const rx = globToRegex(args.pattern);
        const matched = files.filter((f) => rx.test(f)).slice(0, MAX_GLOB_RESULTS);
        emit(ctx, EVENTS.FILE_READ, { path: base, pattern: args.pattern, matches: matched.length });
        return { cwd: base, pattern: args.pattern, files: matched, total: matched.length, truncated: matched.length === MAX_GLOB_RESULTS };
      },
    },
    {
      name: 'fs.grep',
      description: 'Search file contents with a regex. Returns matches with line numbers and optional context lines. Max 200 results.',
      permission: 'fs.read',
      timeoutMs: 30_000,
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regex source' },
          path: { type: 'string', description: 'file or directory to search (default /)' },
          include: { type: 'string', description: 'glob filter for file names, e.g. *.js' },
          context: { type: 'number', description: 'context lines around each match (default 0)' },
          max_results: { type: 'number', description: 'default 200' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const base = args.path ? safePath(args.path, { hostRoot }) : (hostRoot ?? '/');
        let re;
        try { re = new RegExp(args.pattern); } catch (e) { throw new Error(`invalid regex: ${e.message}`); }
        const out = await sandboxSh(runtime, sandboxId, base,
          ['find', '.', '-type', 'f', '-not', '-path', '*/.git/*']);
        if (out.exitCode !== 0) throw new Error(`grep failed: ${out.stderr.trim() || out.exitCode}`);
        let files = out.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''));
        const ignored = await gitIgnored(runtime, sandboxId, base);
        if (ignored) files = files.filter((f) => !ignored.has(f));
        if (args.include) {
          const inc = globToRegex(args.include);
          files = files.filter((f) => inc.test(f.split('/').pop()));
        }
        const max = Math.min(1000, Math.max(1, Number(args.max_results) || MAX_GREP_RESULTS));
        const ctxLines = Math.min(5, Math.max(0, Number(args.context) || 0));
        const results = [];
        let truncated = false;
        outer:
        for (const f of files) {
          const r = await runtime.exec(sandboxId, ['cat', joinPosix(base, f)]);
          if (r.exitCode !== 0 || !r.stdout) continue;
          if (looksBinary(Buffer.from(r.stdout, 'utf8'))) continue;
          const lines = r.stdout.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            results.push({
              path: joinPosix(base, f), line: i + 1,
              text: lines[i].slice(0, 500),
              context: ctxLines ? {
                before: lines.slice(Math.max(0, i - ctxLines), i).map((t) => t.slice(0, 300)),
                after: lines.slice(i + 1, i + 1 + ctxLines).map((t) => t.slice(0, 300)),
              } : undefined,
            });
            if (results.length >= max) { truncated = true; break outer; }
          }
        }
        emit(ctx, EVENTS.FILE_READ, { path: base, pattern: args.pattern, matches: results.length });
        return { pattern: args.pattern, matches: results, total: results.length, truncated };
      },
    },
    {
      name: 'fs.list',
      description: 'List a directory (names, types, sizes). Max 1000 entries.',
      permission: 'fs.read',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'directory inside the sandbox' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId, hostRoot } = requireSandbox(ctx);
        const p = safePath(args.path, { hostRoot });
        const out = await sandboxSh(runtime, sandboxId, p,
          ['find', '.', '-maxdepth', '1', '-mindepth', '1', '-printf', '%y %s %f\n']);
        if (out.exitCode !== 0) throw new Error(`no such directory: ${p}`);
        const entries = out.stdout.split('\n').filter(Boolean).slice(0, 1000).map((l) => {
          const type = l[0] === 'd' ? 'dir' : l[0] === 'l' ? 'link' : 'file';
          const m = /^\S\s+(\d+)\s+(.+)$/.exec(l);
          return { name: m ? m[2] : l, type, size: m ? Number(m[1]) || 0 : 0 };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return { path: p, entries, total: entries.length };
      },
    },
  ];
}

async function sandboxSh(runtime, sandboxId, cwd, cmd) {
  if (runtime.__hostMode) return runtime.exec(sandboxId, cmd, { workdir: cwd });
  // docker: run find from cwd via workdir option
  return runtime.exec(sandboxId, cmd, { workdir: cwd === '/' ? undefined : cwd });
}

async function gitIgnored(runtime, sandboxId, base) {
  // best-effort: git check-ignore per file is slow; use git ls-files when repo
  const r = await sandboxSh(runtime, sandboxId, base, ['git', 'ls-files', '--ignored', '--exclude-standard', '--others', '--directory']);
  if (r.exitCode !== 0) return null;
  return new Set(r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/\/$/, '')));
}

function joinPosix(a, b) {
  if (!b) return a;
  if (a.endsWith('/')) return a + b;
  return a + '/' + b;
}

/** glob -> RegExp: ** = any depth, * = within segment, ? = one char */
export function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // '**/' also matches zero dirs
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '.') out += '\\.';
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

/**
 * Whitespace-tolerant, line-ending-preserving edit.
 * Strategy: try exact match first. If not found, try a whitespace-flexible
 * regex (consecutive whitespace runs collapse). CRLF files: match on the
 * LF-normalized text, then re-emit with the file's dominant EOL.
 */
function applyEdit(text, { old_text, new_text, all }) {
  if (typeof old_text !== 'string' || old_text.length === 0) return { ok: false, reason: 'old_text is required' };
  if (typeof new_text !== 'string') return { ok: false, reason: 'new_text is required' };
  const crlf = text.includes('\r\n');
  const norm = crlf ? text.split('\r\n').join('\n') : text;
  const oldN = crlf ? old_text.split('\r\n').join('\n') : old_text;
  const newN = crlf ? new_text.split('\r\n').join('\n') : new_text;

  let count = splitCount(norm, oldN);
  let mode = 'exact';
  let re = null;
  if (count === 0) {
    // tolerant pass: whitespace runs -> \s*, and \s* inserted next to
    // punctuation so "main( )" matches "main()" and "(  x )" matches "(x )".
    const esc = oldN
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, ' ')
      .split('')
      .map((ch) => (PUNCT.has(ch) ? ch + '\\s*' : ch))
      .join('')
      .replace(/ /g, '\\s+');
    re = new RegExp(esc, 'g');
    count = (norm.match(re) ?? []).length;
    mode = 'whitespace-tolerant';
  }
  if (count === 0) {
    const line = nearestLine(norm, oldN);
    return { ok: false, reason: `old_text not found in file${line ? ` (nearest candidate around line ${line})` : ''}` };
  }
  if (count > 1 && !all) {
    const lines = [];
    let idx = -1; let from = 0;
    const hay = re ?? oldN;
    while (lines.length < 5) {
      idx = re ? hayReIndex(norm, re, from) : norm.indexOf(oldN, from);
      if (idx === -1) break;
      lines.push(norm.slice(0, idx).split('\n').length);
      from = idx + 1;
    }
    return { ok: false, reason: `found ${count} matches at line(s) ${lines.join(', ')}${count > 5 ? '…' : ''}; pass all=true or add context` };
  }
  let out;
  if (re) out = all ? norm.replace(re, newN) : norm.replace(re, () => newN);
  else out = all ? norm.split(oldN).join(newN) : norm.replace(oldN, newN);
  return { ok: true, replacements: count, mode, text: crlf ? out.split('\n').join('\r\n') : out };
}

function hayReIndex(norm, re, from) {
  re.lastIndex = from;
  const m = re.exec(norm);
  return m ? m.index : -1;
}

function nearestLine(hay, needle) {
  // fuzzy: first line of the needle, find a line sharing 4+ word chars
  const first = needle.split('\n')[0].trim();
  if (first.length < 4) return null;
  const words = first.split(/\s+/).filter((w) => w.length >= 4).slice(0, 3);
  if (!words.length) return null;
  const lines = hay.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (words.some((w) => lines[i].includes(w))) return i + 1;
  }
  return null;
}

async function fsReadAt(runtime, sandboxId, p) {
  const st = await runtime.exec(sandboxId, ['test', '-f', p]);
  if (st.exitCode !== 0) throw new Error(`no such file: ${p}`);
  const r = await runtime.exec(sandboxId, ['cat', p]);
  if (r.exitCode !== 0) throw new Error(`read failed: ${r.stderr.trim() || r.exitCode}`);
  return r.stdout;
}

const PUNCT = new Set(['(', ')', '{', '}', '[', ']', ',', ';', ':', '=', '+', '-', '*', '/', '<', '>', '!', '&', '|', '?', '.']);

function splitCount(hay, needle) {
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}
