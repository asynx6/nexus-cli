// Shared plumbing for sandbox-backed tools: resolve the runtime + sandbox
// from the execution context, and path hygiene for in-container files.
import path from 'node:path/posix';
import { hostPath } from '@asynx6/nexus-sandbox-runtime';

export function requireSandbox(ctx) {
  if (!ctx.runtime || typeof ctx.runtime.exec !== 'function') {
    throw new Error('this tool requires a sandbox runtime (ctx.runtime)');
  }
  if (!ctx.sandboxId) throw new Error('this tool requires an active sandbox (ctx.sandboxId)');
  return { runtime: ctx.runtime, sandboxId: ctx.sandboxId, hostRoot: ctx.hostRoot ?? null };
}

/** Absolute, normalized, no traversal. Sandbox paths only.
 * Rejects non-canonical paths outright: PermissionManager matches the RAW
 * arg path, so a path that changes under normalize() could slip past the
 * allowed-roots matcher (e.g. /workspace/../etc) — refuse it at the tool.
 * Host mode (ctx.hostRoot): also accepts paths RELATIVE to the project root
 * and resolves them via hostPath; canonical rule still applies after resolve. */
export function safePath(p, { hostRoot = null } = {}) {
  if (hostRoot && typeof p === 'string' && !p.startsWith('/')) {
    return hostPath(hostRoot, p);
  }
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('path must be absolute inside the sandbox');
  const norm = path.normalize(p);
  if (!norm.startsWith('/') || norm.split('/').includes('..')) throw new Error('path traversal rejected');
  if (norm !== p) throw new Error(`path must be canonical (normalize to "${norm}")`);
  return norm;
}
