// Deny-by-default tool permissions per agent (plan sec 6-7).
// A grant is: agentId -> tool -> rule with optional arg matchers.
// No grant = deny. Failing matcher = deny with machine-readable reason.

function matchPath(patterns, p) {
  if (typeof p !== 'string') return false;
  for (const pat of patterns) {
    // host mode: '**' admits RELATIVE paths only (no leading /); absolute
    // escape is rejected here and enforced again by hostPath in the tool.
    if (pat === '**') {
      if (p.length > 0 && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) return true;
      continue;
    }
    if (pat.endsWith('/**')) {
      const base = pat.slice(0, -3);
      if (p === base || p.startsWith(base + '/')) return true;
    } else if (pat === p) {
      return true;
    }
  }
  return false;
}

export class PermissionManager {
  #grants = new Map(); // agentId -> Map(tool -> rule)

  /**
   * @param {string} agentId
   * @param {string} tool e.g. 'fs.read' | 'fs.write' | 'terminal.exec' | 'net.fetch'
   * @param {{ paths?: string[], commands?: string[], hosts?: string[] }} [rule]
   *   matchers absent = that arg dimension unconstrained
   */
  grant(agentId, tool, rule = {}) {
    if (typeof agentId !== 'string' || !agentId) throw new TypeError('agentId required');
    if (typeof tool !== 'string' || !tool) throw new TypeError('tool required');
    let tools = this.#grants.get(agentId);
    if (!tools) { tools = new Map(); this.#grants.set(agentId, tools); }
    tools.set(tool, { ...rule });
  }

  revoke(agentId, tool) {
    const tools = this.#grants.get(agentId);
    if (!tools) return false;
    if (tool === undefined) { this.#grants.delete(agentId); return true; }
    return tools.delete(tool);
  }

  listGrants(agentId) {
    const tools = this.#grants.get(agentId);
    return tools ? [...tools.keys()] : [];
  }

  /**
   * @param {string} agentId
   * @param {string} tool
   * @param {object} [args] { path } | { command } | { url }
   * @returns {{ allowed: boolean, reason: string, agentId: string, tool: string, args: object }}
   */
  check(agentId, tool, args = {}) {
    const d = (allowed, reason) => ({ allowed, reason, agentId, tool, args });
    const tools = this.#grants.get(agentId);
    if (!tools) return d(false, 'no grants for agent (deny-by-default)');
    const rule = tools.get(tool);
    if (!rule) return d(false, `tool "${tool}" not granted to agent`);

    if (rule.paths && !matchPath(rule.paths, args.path)) {
      return d(false, `path "${args.path}" outside allowed roots`);
    }
    if (rule.commands && !rule.commands.includes(args.command)) {
      return d(false, 'command not in allowlist');
    }
    if (rule.hosts) {
      let h = null;
      if (typeof args.url === 'string') { try { h = new URL(args.url).hostname; } catch { h = null; } }
      if (!h || !rule.hosts.includes(h)) return d(false, 'host not in network allowlist');
    }
    return d(true, 'grant matched');
  }
}
