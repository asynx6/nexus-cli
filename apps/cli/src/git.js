// Git helpers (Fase 6h). Never commits or pushes without explicit user
// confirmation — the auto-commit flag still routes through ask().
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function git(args, cwd) {
  try {
    const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
}

export async function isRepo(cwd = process.cwd()) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

/** True when tracked files are modified (untracked files are NOT dirty). */
export async function isDirty(cwd = process.cwd()) {
  const r = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return r.ok && r.stdout.trim().length > 0;
}

export async function status(cwd = process.cwd()) {
  const r = await git(['status', '--porcelain'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

/** Diff of the session: working tree vs HEAD. */
export async function diff(cwd = process.cwd(), { staged = false } = {}) {
  const r = await git(['diff', ...(staged ? ['--cached'] : []), 'HEAD'], cwd);
  return r.ok ? r.stdout : '';
}

/** Create a worktree and return its path. Caller cleans it up. */
export async function addWorktree(cwd, name) {
  const r = await git(['worktree', 'add', '--detach', name], cwd);
  if (!r.ok) throw new Error(`worktree add failed: ${r.stderr}`);
  const p = await git(['rev-parse', '--show-toplevel'], `${cwd}/${name}`.replace(/\/?$/, ''));
  return r.stdout.trim() || name;
}

/** Commit with a message — ONLY called after explicit user confirmation. */
export async function commit(cwd, message) {
  const add = await git(['add', '-A'], cwd);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const r = await git(['commit', '-m', message], cwd);
  if (!r.ok) throw new Error(`git commit failed: ${r.stderr}`);
  const h = await git(['rev-parse', 'HEAD'], cwd);
  return h.stdout.trim();
}
