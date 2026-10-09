// nexus prompts — named, versioned system prompts (A4).
//
//   nexus prompts list                       names, active hash, version counts
//   nexus prompts show <name> [--rev=HASH|latest]   body of one version
//   nexus prompts diff <name> <left> <right>        added/removed lines
//   nexus prompts rollback <name> <HASH>            set an old version active
//   nexus prompts edit <name> [--editor=...]        open $EDITOR, publish on save
//
// A run pins a prompt with --prompt=<name> or --prompt=<name>@<hash> so the
// exact instruction bytes are recorded alongside the run.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptRegistry, seedDefaults } from '@asynx6/nexus-prompts';

const STORE_ENV = 'NEXUS_PROMPTS_FILE';

export const PROMPTS_HELP = `nexus prompts <subcommand>     named, versioned system prompts (A4)
  list                                names + active hash + version counts
  show <name> [--rev=HASH|latest]     print one version body
  diff <name> <left> <right>          added/removed lines between two hashes
  rollback <name> <HASH>              make an old version the active one
  edit <name>                         open $EDITOR, publish body on save
Env:
  ${STORE_ENV}   prompt store (default ~/.nexus/prompts.json)`;

function fail(stderr, msg, code = 2) { stderr(msg); return code; }

function storePath(env) {
  return env[STORE_ENV] || join(homedir() ?? tmpdir(), '.nexus', 'prompts.json');
}

/**
 * Load the registry from disk (seeding built-ins into an empty store) and
 * hand back { registry, path } so callers can persist after mutation.
 * @param {object} env
 * @returns {{ registry: PromptRegistry, path: string }}
 */
export function loadPromptStore(env) {
  const path = storePath(env);
  const registry = new PromptRegistry();
  if (existsSync(path)) {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    // publish every version in order, then re-pin the recorded active one:
    // publish order alone would leave the *last* published body active, which
    // is not the same thing when the store was rolled back before saving.
    for (const { name, versions, active } of doc.prompts ?? []) {
      for (const v of versions ?? []) registry.publish(name, v.body, { note: v.note });
      if (active && registry.active(name) !== active) registry.rollback(name, active);
    }
  }
  seedDefaults(registry);
  return { registry, path };
}

export function savePromptStore(path, registry) {
  const prompts = registry.summary().map((s) => {
    const versions = registry.versions(s.name).map((h) => {
      const v = registry.version(s.name, h);
      return { hash: v.hash, body: v.body, note: v.note, publishedAt: v.publishedAt };
    });
    return { name: s.name, active: s.active, versions };
  });
  writeFileSync(path, JSON.stringify({ prompts }, null, 2) + '\n', { mode: 0o600 });
}

function parseFlags(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      out[a.slice(2, eq > 0 ? eq : undefined)] = eq > 0 ? a.slice(eq + 1) : true;
    }
  }
  return out;
}

/**
 * @param {string[]} argv args after `prompts`
 * @param {object} env process.env (injected for tests)
 * @param {(s: string) => void} stdout
 * @param {(s: string) => void} stderr
 * @param {object} [opts] { flags, editor: (path) => int for tests }
 * @returns {Promise<number>}
 */
export async function runPrompts(argv, env, stdout, stderr, opts = {}) {
  const sub = argv[0] ?? 'list';
  const flags = opts.flags ?? parseFlags(argv.slice(1));

  try {
    const { registry, path } = loadPromptStore(env);

    if (sub === 'list') {
      const rows = registry.summary();
      if (!rows.length) { stdout('(no prompts — nexus prompts edit <name> to create one)'); return 0; }
      for (const r of rows) stdout(`${r.name}\t${r.active.slice(0, 12)}\tv${r.versions}`);
      return 0;
    }

    if (sub === 'show') {
      const name = argv[1];
      if (!name) return fail(stderr, 'prompts show <name> [--rev=HASH|latest]');
      const rev = flags.rev === true ? null : (flags.rev ?? null);
      const v = registry.resolve(name, rev);
      if (!v) return fail(stderr, `prompts: unknown name/rev: ${name}${rev ? '@' + rev : ''}`, 1);
      stdout(v.body);
      return 0;
    }

    if (sub === 'diff') {
      const name = argv[1];
      const left = argv[2];
      const right = argv[3];
      if (!name || !left || !right) return fail(stderr, 'prompts diff <name> <left> <right>');
      const d = registry.diff(name, left, right);
      stdout(`diff ${name} ${left.slice(0, 12)} -> ${right.slice(0, 12)}${d.same ? ' (identical)' : ''}`);
      for (const l of d.removed) stdout(`- ${l}`);
      for (const l of d.added) stdout(`+ ${l}`);
      return 0;
    }

    if (sub === 'rollback') {
      const name = argv[1];
      const hash = argv[2];
      if (!name || !hash) return fail(stderr, 'prompts rollback <name> <HASH>');
      const v = registry.rollback(name, hash);
      savePromptStore(path, registry);
      stdout(`rolled back ${name} -> ${v.hash.slice(0, 12)}`);
      return 0;
    }

    if (sub === 'edit') {
      const name = argv[1];
      if (!name) return fail(stderr, 'prompts edit <name>');
      const current = registry.body(name) ?? '';
      const tmp = join(tmpdir(), `nexus-prompt-${process.pid}.md`);
      writeFileSync(tmp, current, { mode: 0o600 });
      const runEditor = opts.editor ?? defaultEditor(env);
      const code = runEditor(tmp);
      if (code !== 0) return fail(stderr, `prompts edit: editor exited ${code}`, 1);
      const body = readFileSync(tmp, 'utf8');
      if (body === current) { stdout('no changes — nothing published'); return 0; }
      if (!body.trim()) return fail(stderr, 'prompts edit: empty body refused', 1);
      const v = registry.publish(name, body, { note: 'edited via nexus prompts edit' });
      savePromptStore(path, registry);
      stdout(`published ${name} -> ${v.hash.slice(0, 12)} (${registry.versions(name).length} versions)`);
      return 0;
    }

    return fail(stderr, `prompts: unknown subcommand "${sub}"\n\n${PROMPTS_HELP}`);
  } catch (e) {
    return fail(stderr, 'prompts: ' + e.message, 1);
  }
}

function defaultEditor(env) {
  return (path) => {
    const ed = env.EDITOR || env.VISUAL || 'vi';
    const res = spawnSync(ed, [path], { stdio: 'inherit' });
    return res.status ?? 1;
  };
}
