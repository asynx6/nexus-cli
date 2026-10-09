// E1 per-project secrets — access-control layer on top of Vault + SecretStore.
//
// RBAC is deliberately minimal: a principal (agent id, or 'cli' / 'api')
// holds an explicit allowlist of secret NAMES it may read. No role table, no
// wildcard permissions — per plan §6 "deny by default", absence of a grant
// means denial, and every decision is logged as an audit event.
//
//   vault  -> at-rest encryption (this file never sees plaintext at rest)
//   this   -> who may materialize which name into an exec env
//
// ponytail: grants live in memory alongside the vault. When the API needs
// grants to survive restart, persist the grant table (names only — never
// values) in the vault file's sibling; the Vault format already has a
// version byte for it.

import { makeEvent } from '@asynx6/nexus-event-system';

export class ProjectSecrets {
  #vault;
  #bus;
  #grants = new Map(); // principal -> Set(secretName)

  /**
   * @param {{ vault: import('./vault.js').Vault, bus?: object }} deps
   */
  constructor({ vault, bus = null }) {
    if (!vault) throw new TypeError('vault required');
    this.#vault = vault;
    this.#bus = bus ?? null;
  }

  /** Allow a principal to read a secret name into an exec env. */
  grant(principal, name) {
    assertPrincipal(principal);
    assertEnvName(name);
    let set = this.#grants.get(principal);
    if (!set) { set = new Set(); this.#grants.set(principal, set); }
    set.add(name);
    this.#log(`secrets.grant`, { principal, name });
    return this;
  }

  revoke(principal, name) {
    assertPrincipal(principal);
    const set = this.#grants.get(principal);
    const removed = set ? set.delete(name) : false;
    if (set && set.size === 0) this.#grants.delete(principal);
    if (removed) this.#log('secrets.revoke', { principal, name });
    return removed;
  }

  /** All principals with any grant (names only). */
  principals() { return [...this.#grants.keys()].sort(); }

  /** Names a principal may read. Names only — values never leave the vault. */
  grantsFor(principal) {
    assertPrincipal(principal);
    const set = this.#grants.get(principal);
    return set ? [...set].sort() : [];
  }

  /**
   * Materialize granted secrets into a base env for one execution.
   * @param {string} principal
   * @param {string[]} names requested names (subset of the grant list)
   * @param {Record<string,string>} base
   * @returns {Record<string,string>} env with the granted secrets injected
   */
  envFor(principal, names, base = {}) {
    assertPrincipal(principal);
    if (!Array.isArray(names)) throw new TypeError('names must be an array');
    const allowed = this.#grants.get(principal);
    const env = { ...base };
    const granted = [];
    const denied = [];
    for (const name of names) {
      assertEnvName(name);
      if (allowed && allowed.has(name)) {
        // decrypt on demand; a granted name that is absent in the vault is a
        // config error, not a security event — surface it loudly.
        const plaintext = this.#vault.get(name);
        if (plaintext === null) throw new Error(`granted secret "${name}" not present in vault`);
        env[name] = plaintext;
        granted.push(name);
      } else {
        denied.push(name);
      }
    }
    this.#log('secrets.access', { principal, granted, denied });
    if (denied.length) {
      throw new Error(`secret access denied for "${principal}": ${denied.join(', ')}`);
    }
    return env;
  }

  /** Grant + set in one call (the CLI 'set' path). */
  setAndGrant(principal, name, plaintext) {
    assertEnvName(name);
    this.#vault.set(name, plaintext);
    this.grant(principal, name);
    return this;
  }

  #log(type, payload) {
    if (this.#bus) {
      const ev = makeEvent(type, payload, 'secrets');
      this.#bus.emit(ev);
    }
  }
}

const PRINCIPAL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function assertPrincipal(principal) {
  if (typeof principal !== 'string' || !PRINCIPAL_RE.test(principal)) {
    throw new TypeError(`invalid principal "${principal}"`);
  }
}

function assertEnvName(name) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new TypeError(`secret name must be UPPER_SNAKE (got "${name}")`);
  }
}
