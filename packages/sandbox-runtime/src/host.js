// HostRuntime — runs commands on the host, locked to a project root.
// Same contract as DockerRuntime: create/start/exec/copyIn/stop/remove.
// Paths are resolved against root and must stay inside it (no .., no symlinks
// pointing out, no other drive on Windows).
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep, dirname } from 'node:path';

const IS_WIN = process.platform === 'win32';

/** Resolve a sandbox-style path against root; throw when it escapes root. */
export function hostPath(root, p) {
  if (typeof p !== 'string' || p.length === 0) throw new Error('path required');
  // Windows absolute paths never live under a posix root and vice versa
  if (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) throw new Error(`path escapes project root: ${p}`);
  let abs;
  if (isAbsolute(p)) abs = resolve(p);
  else abs = resolve(root, p);
  const rootNorm = resolve(root);
  if (abs !== rootNorm && !abs.startsWith(rootNorm + sep)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  return abs;
}

async function assertInside(root, abs) {
  let real;
  try {
    real = await realpath(dirname(abs));
  } catch {
    return; // parent does not exist yet (copyIn will mkdir it)
  }
  const rootReal = await realpath(root);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error('path escapes project root (symlink)');
  }
}

function killTree(child, root) {
  if (IS_WIN) {
    if (child.pid) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
}

export class HostRuntime {
  #root;
  #allowEnv;
  #envValues;
  #sandboxes = new Map();

  /**
   * @param {{ root: string, allowEnv?: string[], env?: Record<string,string> }} opts
   *   allowEnv: env var names forwarded to commands (default: PATH, HOME, LANG,
   *   SystemRoot on Windows). env: full values for granted secrets.
   */
  constructor(opts = {}) {
    if (!opts.root) throw new TypeError('root required');
    this.#root = resolve(opts.root);
    this.#allowEnv = opts.allowEnv ?? (IS_WIN
      ? ['PATH', 'HOME', 'LANG', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'COMSPEC', 'PROCESSOR_ARCHITECTURE']
      : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM']);
    this.#envValues = opts.env ?? {};
  }

  get root() { return this.#root; }

  /** Conforms to the sandbox contract: returns an id string. */
  async create(_spec = {}) {
    const id = 'host-' + Math.random().toString(36).slice(2, 10);
    this.#sandboxes.set(id, true);
    return id;
  }

  async start(_id) { /* host processes start per-exec; nothing to boot */ }

  /**
   * @param {string} id @param {string[]} cmd @param {{ timeoutMs?: number, workdir?: string, env?: Record<string,string> }} [opts]
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }>}
   */
  async exec(id, cmd, opts = {}) {
    if (!Array.isArray(cmd) || cmd.length === 0) throw new TypeError('cmd must be a non-empty argv array');
    const workdir = opts.workdir ? hostPath(this.#root, opts.workdir) : this.#root;
    const timeoutMs = opts.timeoutMs ?? 30_000;

    const env = {};
    for (const k of this.#allowEnv) if (process.env[k] !== undefined) env[k] = process.env[k];
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        // only forward granted secret names that were materialized in ctx.env
        if (this.#allowEnv.includes(k) || k in this.#envValues || this.#envValues.__all === true) env[k] = v;
      }
    }

    return await new Promise((res) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(cmd[0], cmd.slice(1), { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, this.#root);
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        res({ exitCode: -1, stdout, stderr: stderr + String(e.message), timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        res({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }

  /**
   * Write files atomically-ish: mkdir -p the parent, then writeFile.
   * @param {string} id @param {Array<{path: string, content: string|Buffer}>} files
   */
  async copyIn(id, files) {
    for (const f of files ?? []) {
      const abs = hostPath(this.#root, f.path);
      await assertInside(this.#root, abs);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content);
    }
  }

  async stop(_id) { /* no persistent process */ }

  async remove(id) { this.#sandboxes.delete(id); }

  async cleanupOrphans() { /* nothing tracked */ }
}
