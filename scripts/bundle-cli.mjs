// Bundle workspace deps into a self-contained publish directory.
// The published CLI imports packages/* via @asynx6/* specifiers that only resolve
// in the monorepo (symlinks + workspace install). They do NOT exist for a
// consumer, so the tarball would E404 / ERR_MODULE_NOT_FOUND.
//
// Fix: stage a publish copy at apps/cli/_publish/, generate vendor/ inside it,
// and rewrite every @asynx6/* import (vendor cross-imports AND src/* imports)
// to relative ../vendor/<pkg>/index.js paths. The source tree is left untouched.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'apps', 'cli');
const pub = join(cli, '_publish');
const pubVendor = join(pub, 'vendor');

// Packages the CLI imports at runtime.
const PKGS = ['shared', 'event-system', 'sandbox-runtime', 'security', 'tool-system',
              'model-providers', 'agent-runtime', 'audit', 'consensus', 'memory', 'plugin-registry', 'multi-agent', 'telemetry', 'prompts'];

// --- 1. Fresh publish copy of the CLI, minus dev-only junk ---
rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });
for (const ent of readdirSync(cli, { withFileTypes: true })) {
  if (['test', 'node_modules', 'vendor', '_publish', '.env-gateway'].includes(ent.name)) continue;
  const src = join(cli, ent.name);
  if (ent.isDirectory()) {
    cpSync(src, join(pub, ent.name), { recursive: true });
    // no nested tests in the tarball
    rmSync(join(pub, ent.name, 'test'), { recursive: true, force: true });
  } else {
    cpSync(src, join(pub, ent.name));
  }
}

// --- 2. vendor/ = packages/* minus tests ---
rmSync(pubVendor, { recursive: true, force: true });
mkdirSync(pubVendor, { recursive: true });
for (const name of PKGS) {
  const src = join(root, 'packages', name);
  if (!existsSync(src)) { console.log(`skip ${name} (missing)`); continue; }
  cpSync(src, join(pubVendor, name), { recursive: true });
  for (const drop of ['test', 'node_modules', 'coverage']) {
    rmSync(join(pubVendor, name, drop), { recursive: true, force: true });
  }
  console.log(`vendored ${name}`);
}

// --- 3. Rewrite @asynx6/<pkg> specifiers to relative vendor paths ---
// Matches import/export-from and bare import statements only, so template
// literals that legitimately mention @asynx6/* (scaffolded project output) stay intact.
// Matches static import/export-from, bare import, AND dynamic import('...'),
// so a runtime await import('@asynx6/x') in the publish copy resolves too.
const SPEC_RE = /((?:^|\n)(?:import|export)[^\n]*?\bfrom\s*|(?:^|\n)import\s*|(?:^|\n|[^\w.])\bimport\(\s*)(['"])@nexus\/([a-z-]+)(\/[^\s'"]*)?/g;

// dir: directory to walk; baseDir: what depth is measured from;
// isVendorBase: true when dir IS vendor/ (sibling refs, no "vendor/" prefix).
function rewriteDir(dir, baseDir, isVendorBase) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { rewriteDir(p, baseDir, isVendorBase); continue; }
    if (!/\.(mjs|js)$/.test(ent.name)) continue;
    const txt = readFileSync(p, 'utf8');
    const before = txt;
    const next = txt.replace(SPEC_RE, (m, prefix, q, pkg, sub) => {
      const fileDir = dirname(p).replace(/\\/g, '/');
      const bp = baseDir.replace(/\\/g, '/');
      const rel = fileDir.startsWith(bp) ? fileDir.slice(bp.length + 1) : '';
      const depth = rel ? rel.split('/').length : 0;
      const ups = depth === 0 ? './' : '../'.repeat(depth);
      // ESM filesystem resolution needs explicit /index.js (no exports map).
      const target = isVendorBase ? ups + pkg : ups + 'vendor/' + pkg;
      return prefix + q + target + (sub || '/index.js');
    });
    if (next !== before) { writeFileSync(p, next); console.log(`rewrote ${p.replace(pub, '')}`); }
  }
}
rewriteDir(pubVendor, pubVendor, true);
rewriteDir(join(pub, 'src'), pub, false);
rewriteDir(pub, pub, false);

// --- 4. Dev shims: symlink apps/cli/node_modules/@asynx6/<pkg> -> packages/<pkg>
// so the source tree (not the publish copy) resolves @asynx6/* during npm test.
// Never lands in the tarball: _publish has no symlinks.
const nm = join(cli, 'node_modules');
const scopeDir = join(nm, '@nexus');
mkdirSync(scopeDir, { recursive: true });
for (const name of PKGS) {
  const link = join(scopeDir, name);
  const target = join(root, 'packages', name);
  if (!existsSync(target)) continue;
  rmSync(link, { recursive: true, force: true });
  try { symlinkSync(target, link, 'dir'); }
  catch { /* non-fatal */ }
}

console.log('\nDONE. Verify with: cd apps/cli && node bin.mjs --version');
console.log('  npm publish from there:  cd apps/cli/_publish && npm publish --access public');
console.log('  (release.yml does this automatically)');
