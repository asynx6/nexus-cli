// Checkpoints (Fase 6a): snapshot file contents BEFORE a mutating tool runs,
// so /rewind can restore code. Stored under .nexus/checkpoints/<sessionId>/
// <seq>/ as a small JSON manifest + file copies (host-side, outside sandbox).
// Honest limitation: terminal.exec side effects (rm, npm install) are NOT
// captured — the rewind UI warns about this.
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MUTATING = new Set(['fs.write', 'fs.edit', 'fs.upload']);
const MANIFEST = 'manifest.json';

export class Checkpointer {
  /** @param {{ root?: string, sessionId: string }} opts */
  constructor({ root = '.nexus/checkpoints', sessionId }) {
    if (!sessionId) throw new TypeError('sessionId required');
    this.base = join(root, sessionId);
    this.sessionId = sessionId;
    this.#seq = 0;
    try {
      const dirs = existsSync(this.base) ? readdirNumbers(this.base) : [];
      this.#seq = dirs.length ? Math.max(...dirs) : 0;
    } catch { /* fresh */ }
  }

  #seq;

  /** Snapshot the files a mutating call is about to touch.
   *  @param {{ tool: string, args: object, ctx: { runtime, sandboxId, hostRoot } }} p
   *  @returns {{ checkpoint: number, files: string[] } | null} null when the
   *  tool is not mutating or nothing existed yet. */
  async beforeTool({ tool, args, ctx }) {
    if (!MUTATING.has(tool) || !args?.path) return null;
    if (!ctx?.runtime || !ctx?.sandboxId) return null;
    const seq = ++this.#seq;
    const dir = join(this.base, String(seq));
    const files = [];
    let existed = false;
    let content = null;
    try {
      // read through the sandbox (works for docker AND host)
      const r = await ctx.runtime.exec(ctx.sandboxId, ['cat', String(args.path)]);
      if (r.exitCode === 0) { content = r.stdout; existed = true; }
    } catch { /* not there yet — creation, still checkpoint the "absent" state */ }
    mkdirSync(dir, { recursive: true });
    const manifest = {
      seq, tool, ts: new Date().toISOString(),
      files: [{ path: String(args.path), existed, bytes: content ? Buffer.byteLength(content, 'utf8') : 0 }],
    };
    writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    if (existed) writeFileSync(join(dir, 'snapshot.b64'), Buffer.from(content, 'utf8').toString('base64'));
    return { checkpoint: seq, files: manifest.files.map((f) => f.path) };
  }

  /** List checkpoints (newest first): [{ seq, tool, ts, files }] */
  list() {
    if (!existsSync(this.base)) return [];
    return readdirNumbers(this.base)
      .sort((a, b) => b - a)
      .map((seq) => {
        try {
          return { seq, ...JSON.parse(readFileSync(join(this.base, String(seq), MANIFEST), 'utf8')) };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  /** Restore file contents as of BEFORE checkpoint `seq` (i.e. the newest
   *  checkpoint with seq' <= seq whose file matches). Returns restored paths.
   *  Deletions caused AFTER the checkpoint are undone by re-creating. */
  async restore(seq, ctx) {
    const all = this.list().filter((c) => c.seq <= seq); // newest first
    // newest snapshot per file path — list() is newest-first, so the FIRST
    // hit per path wins
    const latest = new Map();
    for (const c of all) {
      for (const f of c.files) {
        if (!latest.has(f.path)) latest.set(f.path, { entry: f, seq: c.seq });
      }
    }
    const restored = [];
    for (const [path, { entry, seq: cseq }] of latest) {
      const snapPath = join(this.base, String(cseq), 'snapshot.b64');
      if (entry.existed && existsSync(snapPath)) {
        const content = Buffer.from(readFileSync(snapPath, 'utf8'), 'base64');
        await ctx.runtime.copyIn(ctx.sandboxId, [{ path, content }]);
        restored.push(path);
      }
      // existed:false => file was created after the checkpoint; delete it
      else if (!entry.existed) {
        await ctx.runtime.exec(ctx.sandboxId, ['rm', '-f', path]);
        restored.push(path + ' (deleted)');
      }
    }
    return restored;
  }
}

function readdirNumbers(dir) {
  return readdirSync(dir).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}
