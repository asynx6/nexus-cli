// nexus secrets — per-project encrypted secret vault (E1).
//
//   nexus secrets init                          create .nexus/secrets.enc (asks passphrase)
//   nexus secrets set <NAME> [--value=V]        add/overwrite a secret (asks value if absent)
//   nexus secrets get <NAME>                    print plaintext to stdout (use with care)
//   nexus secrets list                          list names only — never values
//   nexus secrets rm <NAME>                     delete an entry
//   nexus secrets grant <PRINCIPAL> <NAME>      allow an agent to read NAME into its exec env
//   nexus secrets revoke <PRINCIPAL> <NAME>     remove that grant
//
// Passphrase: NEXUS_PROJECT_PASSPHRASE env, else prompted from stdin (no echo).
// The vault file is aes-256-gcm; see packages/security/src/vault.js.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, writeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { Vault, ProjectSecrets } from '@asynx6/nexus-security';

const PASS_ENV = 'NEXUS_PROJECT_PASSPHRASE';
const STORE_ENV = 'NEXUS_PROJECT_SECRETS_FILE';

export const SECRETS_HELP = `nexus secrets <subcommand>     per-project encrypted secret vault (E1)
  init                                create the vault (asks for a passphrase)
  set <NAME> [--value=V]              add or overwrite a secret (asks for value if absent)
  get <NAME>                          print one secret value to stdout
  list                                list secret names only — values never printed
  rm <NAME>                           delete a secret
  grant <PRINCIPAL> <NAME>            allow PRINCIPAL (agent id / cli) to read NAME
  revoke <PRINCIPAL> <NAME>           remove a grant
Env:
  ${PASS_ENV}          passphrase (prompted from stdin when unset)
  ${STORE_ENV}  vault file (default .nexus/secrets.enc)`;

function fail(stderr, msg, code = 2) { stderr(msg); return code; }

function defaultVaultPath(env) {
  return env[STORE_ENV] || join(process.cwd(), '.nexus', 'secrets.enc');
}

/** Prompt for a line on stdin (sync, zero deps). Refuses to block on a
 *  non-interactive stdin (piped/closed) — callers must pass the passphrase
 *  via NEXUS_PROJECT_PASSPHRASE in CI and cron contexts. */
function ask(prompt, { secret = false } = {}) {
  if (process.stdin.isTTY !== true) throw new Error(`${PASS_ENV} required (stdin is not interactive)`);
  writeSync(1, prompt);
  let line = '';
  const buf = Buffer.alloc(1);
  while (true) {
    const n = readSync(0, buf, 0, 1, null);
    if (n === 0) break;
    const ch = buf.toString('utf8');
    if (ch === '\n' || ch === '\r') break;
    line += ch;
  }
  if (secret) writeSync(1, '\n');
  return line.trim();
}

function getPassphrase(env, { confirm = false } = {}) {
  if (typeof env[PASS_ENV] === 'string' && env[PASS_ENV].length > 0) return env[PASS_ENV];
  const pass = ask('Passphrase: ', { secret: true });
  if (!pass) throw new Error('passphrase required (env ' + PASS_ENV + ' or stdin)');
  if (confirm) {
    const again = ask('Confirm passphrase: ', { secret: true });
    if (again !== pass) throw new Error('passphrases did not match');
  }
  return pass;
}

/** Read the vault file + unlock, or throw a actionable message. */
function openVault(env) {
  const path = defaultVaultPath(env);
  if (!existsSync(path)) {
    throw new Error(`no vault at ${path} — run \`nexus secrets init\` first`);
  }
  const blob = readFileSync(path, 'utf8');
  return { path, vault: Vault.open(getPassphrase(env), blob) };
}

function saveVault(path, vault) {
  writeFileSync(path, vault.serialize(), { mode: 0o600 });
  chmodSync(path, 0o600); // umask can weaken mode on some systems; enforce
}

/**
 * @param {string[]} argv args after `secrets`
 * @param {object} env process.env (injected for tests)
 * @param {(s: string) => void} stdout
 * @param {(s: string) => void} stderr
 * @param {object} [opts] { flags: pre-parsed --key=value bag from cli.js,
 *   promptValue: async (name) => string for tests }
 * @returns {Promise<number>}
 */
export async function runSecrets(argv, env, stdout, stderr, opts = {}) {
  const sub = argv[0] ?? 'list';
  const flags = opts.flags ?? parseFlags(argv.slice(1));

  try {
    if (sub === 'init') {
      const path = defaultVaultPath(env);
      if (existsSync(path)) return fail(stderr, `secrets: ${path} already exists — use 'set' to add entries`);
      const pass = getPassphrase(env, { confirm: true });
      const vault = Vault.create(pass);
      mkdirSync(join(path, '..'), { recursive: true });
      saveVault(path, vault);
      stdout(`vault created: ${path} (mode 600, aes-256-gcm)`);
      return 0;
    }

    if (sub === 'set') {
          let name = argv[1];
          if (!name) return fail(stderr, 'secrets set <NAME> [value] or --value=V');
          const { path, vault } = openVault(env);
          // Accept value as --value=V, the 2nd positional (argv[2]), or NAME=VALUE.
          let value = typeof flags.value === 'string' ? flags.value : '';
          if (!value && typeof argv[2] === 'string') value = argv[2];
          if (typeof name === 'string' && name.includes('=') && !value) {
            const eq = name.indexOf('=');
            value = name.slice(eq + 1);
            name = name.slice(0, eq);
          }
          if (!value) {
            if (io.promptValue) value = await io.promptValue(name);
            else value = ask(`Value for ${name}: `, { secret: true });
          }
          if (!value) return fail(stderr, 'secrets set: value must be non-empty');
          vault.set(name, value);
          saveVault(path, vault);
          stdout(`stored: ${name}`);
          return 0;
        }

    if (sub === 'get') {
      const name = argv[1];
      if (!name) return fail(stderr, 'secrets get <NAME>');
      const { vault } = openVault(env);
      const value = vault.get(name);
      if (value === null) return fail(stderr, `secrets: no entry named ${name}`, 1);
      stdout(value);
      return 0;
    }

    if (sub === 'list') {
      const { vault } = openVault(env);
      const names = vault.names();
      if (!names.length) { stdout('(vault empty — nexus secrets set <NAME> to add one)'); return 0; }
      for (const n of names) stdout(n);
      return 0;
    }

    if (sub === 'rm') {
      const name = argv[1];
      if (!name) return fail(stderr, 'secrets rm <NAME>');
      const { path, vault } = openVault(env);
      if (!vault.delete(name)) return fail(stderr, `secrets: no entry named ${name}`, 1);
      saveVault(path, vault);
      stdout(`removed: ${name}`);
      return 0;
    }

    if (sub === 'grant' || sub === 'revoke') {
      const principal = argv[1];
      const name = argv[2];
      if (!principal || !name) return fail(stderr, `secrets ${sub} <PRINCIPAL> <NAME>`);
      const { path, vault } = openVault(env);
      if (!vault.has(name)) return fail(stderr, `secrets: no entry named ${name} — set it first`, 1);
      // grants are derived from the vault file's sidecar so they survive writes
      const secrets = new ProjectSecrets({ vault });
      loadGrants(secrets, path);
      const changed = sub === 'grant' ? (secrets.grant(principal, name), true) : secrets.revoke(principal, name);
      if (changed) saveGrants(path, secrets);
      stdout(sub === 'grant' ? `granted: ${principal} may read ${name}` : `revoked: ${principal} may not read ${name}`);
      return 0;
    }

    return fail(stderr, `secrets: unknown subcommand "${sub}"\n\n${SECRETS_HELP}`);
  } catch (e) {
    return fail(stderr, 'secrets: ' + e.message, 1);
  }
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

const GRANTS_SUFFIX = '.grants';

function grantsPath(vaultPath) { return vaultPath + GRANTS_SUFFIX; }

function loadGrants(secrets, vaultPath) {
  const p = grantsPath(vaultPath);
  if (!existsSync(p)) return;
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  for (const [principal, names] of Object.entries(doc)) {
    for (const name of names) secrets.grant(principal, name);
  }
}

function saveGrants(vaultPath, secrets) {
  const p = grantsPath(vaultPath);
  const doc = {};
  for (const principal of secrets.principals()) doc[principal] = secrets.grantsFor(principal);
  writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}
