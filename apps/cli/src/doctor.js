// nexus doctor — comprehensive environment health check.
// Run before first agent invocation to catch setup issues early.
// Zero deps, stdlib only.
import { existsSync, statSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname, platform, arch } from 'node:os';
import { version as nodeVersion } from 'node:process';
import { execFileSync } from 'node:child_process';
import { DEFAULT_GATEWAY_BASE } from '@asynx6/nexus-shared';

export async function runDoctor({ env = process.env, stdout = console.log, exec = execFileSync } = {}) {
  const ok = (label, detail = '') => stdout(`  ok    ${label} ${detail}`);
  const warn = (label, detail = '') => stdout(`  warn  ${label} ${detail}`);
  const fail = (label, detail = '') => stdout(`  fail  ${label} ${detail}`);
  let exit = 0;
  stdout('nexus doctor — environment health check\n');

  // Node version
  const v = nodeVersion;
  const major = parseInt(v.slice(1).split('.')[0], 10);
  if (major >= 22) ok('Node.js version', `${v}`);
  else { fail('Node.js version', `${v} — need >= 22 for node:sqlite`); exit = 2; }

  // Platform
  ok('Platform', `${platform()} ${arch()} (${hostname()})`);

  // Env file
  if (existsSync('.env')) ok('Env file', '.env present');
  else if (existsSync('.env-gateway')) ok('Env file', '.env-gateway present');
  else warn('Env file', 'not present; using environment variables');

  // Gateway config
  const base = env.NEXUS_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE;
  const key = env.NEXUS_GATEWAY_KEY;
  if (key) ok('Gateway key', 'set');
  else { fail('Gateway key', 'NEXUS_GATEWAY_KEY not set'); exit = 2; }

  // Models
  const models = (env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent').split(',').map((s) => s.trim());
  ok('Models configured', models.join(', '));

  // Gateway reachability
  try {
    const r = await fetch(base + '/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 200) ok('Gateway reachable', `${base} (200)`);
    else { fail('Gateway reachable', `HTTP ${r.status}`); exit = 2; }
  } catch (e) {
    fail('Gateway reachable', `${base} — ${e.message}`);
    exit = 2;
  }

  // node:sqlite available (Node 22 has it built-in)
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1)');
    const row = db.prepare('SELECT x FROM t').get();
    db.close();
    if (row.x === 1) ok('node:sqlite', 'in-memory round-trip ok');
  } catch (e) {
    fail('node:sqlite', e.message);
    exit = 2;
  }

  // Event store directory presence (not a write-permission check).
  const storeDir = './.nexus/store';
  try {
    statSync(storeDir);
    ok('Event store dir', storeDir);
  } catch {
    warn('Event store dir', `${storeDir} not present — will be created on first run`);
  }

  // Docker (optional but recommended for sandbox)
  try {
    const dockerVer = exec('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    ok('Docker daemon (optional)', dockerVer);
  } catch {
    warn('Docker daemon (optional)', 'unavailable; sandbox execution is not verified');
  }

  stdout(exit === 0 ? '\nRequired checks passed. Review warnings above.' : '\nIssues found. See above.');
  return exit;
}

/**
 * nexus doctor --fix — auto-repair common setup issues.
 *
 * Actions performed (idempotent, safe to re-run):
 *   1. .env-gateway missing → copy from .env.example (chmod 600).
 *   2. .env-gateway wrong perms → chmod 600.
 *   3. package-lock.json missing + package.json present → npm install --package-lock-only.
 *
 * Returns { actions: [{name, ok, detail}], summary }.
 * Never modifies gateway key contents; never deletes user data.
 */
export async function runDoctorFix({ cwd = process.cwd(), exec = execFileSync, env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const actions = [];
  const base = resolve(cwd);
  const envExample = join(base, '.env.example');
  const envFile = join(base, '.env-gateway');
  const pkgJson = join(base, 'package.json');
  const lockFile = join(base, 'package-lock.json');

  // The CLI loads .env-gateway into process.env before dispatching, which would
  // mask a placeholder key. Read the file itself for the key check instead.
  let fileKey = env.NEXUS_GATEWAY_KEY ?? '';
  try {
    const raw = readFileSync(envFile, 'utf8');
    const m = raw.match(/^NEXUS_GATEWAY_KEY=(.*)$/m);
    if (m) fileKey = m[1].trim();
  } catch { /* missing file is handled below */ }

  // 1. Recreate .env-gateway from .env.example when missing
  if (!existsSync(envFile)) {
    if (existsSync(envExample)) {
      try {
        mkdirSync(base, { recursive: true });
        copyFileSync(envExample, envFile);
        chmodSync(envFile, 0o600);
        actions.push({ name: 'create-env-gateway', ok: true, detail: '.env-gateway created from .env.example (mode 600)' });
        stdout('[fix] created .env-gateway (mode 600)');
      } catch (e) {
        actions.push({ name: 'create-env-gateway', ok: false, detail: e.message });
        stderr('[fix] failed to create .env-gateway:', e.message);
      }
    } else {
      actions.push({ name: 'create-env-gateway', ok: true, detail: 'skipped (no .env.example)' });
    }
  } else {
    // 2. chmod 600 on existing .env-gateway if wrong
    try {
      const st = statSync(envFile);
      const mode = st.mode & 0o777;
      if (mode !== 0o600) {
        chmodSync(envFile, 0o600);
        actions.push({ name: 'chmod-env-gateway', ok: true, detail: `chmod ${mode.toString(8)} → 600` });
        stdout(`[fix] chmod .env-gateway ${mode.toString(8)} → 600`);
      } else {
        actions.push({ name: 'chmod-env-gateway', ok: true, detail: 'already 600' });
      }
    } catch (e) {
      actions.push({ name: 'chmod-env-gateway', ok: false, detail: e.message });
    }
  }

  // 3. Regen package-lock.json if missing
  if (!existsSync(lockFile) && existsSync(pkgJson)) {
    try {
      exec('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      actions.push({ name: 'regen-lockfile', ok: true, detail: 'regenerated lockfile via npm install --package-lock-only' });
      stdout('[fix] regenerated package-lock.json');
    } catch (e) {
      actions.push({ name: 'regen-lockfile', ok: false, detail: e.message });
      stderr('[fix] npm install failed:', e.message);
    }
  } else if (existsSync(lockFile)) {
    actions.push({ name: 'regen-lockfile', ok: true, detail: 'already present' });
  }

  const changed = actions.filter((a) => /created|chmod|regenerated|lockfile/.test(a.detail) && a.ok);
  // loadEnv() has already merged .env-gateway into process.env by now, so a key
  // that exists but is clearly unusable is what we actually need to catch:
  // missing, empty, or an obvious placeholder value.
  const rawKey = fileKey || (env.NEXUS_GATEWAY_KEY ?? '');
  const PLACEHOLDER = /^(?:sk-dummy|sk-test|test|changeme|your[-_]?key|<.+>|\s*)$/i;
  const keyUnusable = !rawKey || PLACEHOLDER.test(rawKey);
  let summary = changed.length === 0
    ? 'nothing to fix — environment already healthy'
    : `${changed.length} change(s): ${changed.map((a) => a.name).join(', ')}`;
  if (keyUnusable) {
    summary += ' — WARNING: NEXUS_GATEWAY_KEY missing or placeholder (run: nexus setup)';
  }

  stdout(`\n[fix] ${summary}`);
  return { actions, summary, keyUnusable };
}
