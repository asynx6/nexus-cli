// Bridge @nexus/tool-system's ToolExecutor into the AgentLoop's tools contract.
// The executor is the single funnel (validation + permissions + audit +
// events + timeout); the loop therefore runs WITHOUT its own permission gate
// when wired through this adapter — no double checks, no double audit rows.
import { ToolRegistry, ToolExecutor } from '@nexus/tool-system';

/** OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$; nexus tool names
 *  use dots (fs.read). Sanitize for the wire, map back on execute. */
export function wireName(name) {
  return name.replace(/\./g, '_');
}

/**
 * @param {{ registry: ToolRegistry, executor: ToolExecutor }} parts
 * @returns {{ list(): Array<{name,description,parameters}>,
 *   execute(name: string, args: object, ctx: object): Promise<{ok: boolean, output: string}> }}
 */
export function loopTools({ registry, executor }) {
  if (!registry || !executor) throw new TypeError('registry + executor required');
  // wire name -> real registry name — LAZY lookup so late-registered tools
  // (mcp.*, agent.spawn) resolve without rebuilding the map.
  const realName = (wire) => {
    for (const t of registry.list()) if (wireName(t.name) === wire) return t.name;
    return wire; // already a registry name (or unknown — executor reports it)
  };
  return {
    // plain schema list (provider wraps into OpenAI shape itself)
    list: () => registry.list().map((t) => ({ name: wireName(t.name), description: t.description, parameters: t.schema })),
    async execute(name, args, ctx) {
      const real = realName(name);
      const out = await executor.execute({ tool: real, args }, ctx);
      const output = out.ok
        ? (typeof out.result === 'string' ? out.result : JSON.stringify(out.result ?? {}))
        : ((out.error === 'denied' ? 'PERMISSION DENIED: ' : out.error === 'validation' ? 'INVALID CALL: ' : 'TOOL ERROR: ') + (out.reason ?? 'unknown'));
      return { ok: out.ok, output };
    },
  };
}
