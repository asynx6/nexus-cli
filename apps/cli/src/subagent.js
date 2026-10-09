// Subagents (Fase 6d): .nexus/agents/<name>.md (frontmatter: name,
// description, tools, model, permissionMode; body = system prompt).
// Defaults: explore (read-only), plan (read-only), general.
// agent.spawn runs a NEW AgentLoop with a separate context and returns only
// a summary to the parent — the parent context stays small.
//
// Why not packages/multi-agent: its Supervisor/Cluster solve distributed
// hermes-link membership + leader election over a shared store — not needed
// for one CLI process spawning short-lived loops. In-process AgentLoop reuse
// keeps events flowing through the same bus with a distinct subject and a
// parentSessionId link (P13 link rule preserved).
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEvent } from '@asynx6/nexus-event-system';
import { parseSkillMd } from './skills.js';

export const DEFAULT_AGENTS = {
  explore: {
    name: 'explore',
    description: 'Read-only explorer: searches the repo and reports findings. Cannot write or exec.',
    tools: 'fs.read, fs.glob, fs.grep, fs.list, repo.map',
    model: '',
    permissionMode: 'plan',
    body: 'You are a read-only explorer agent. Search, read, and summarize. Never modify anything. Report concise findings: file paths, symbols, and how things connect.',
  },
  plan: {
    name: 'plan',
    description: 'Read-only planner: investigates and produces a step-by-step plan.',
    tools: 'fs.read, fs.glob, fs.grep, fs.list, repo.map',
    model: '',
    permissionMode: 'plan',
    body: 'You are a planning agent. Investigate the codebase read-only, then produce a numbered implementation plan with files to touch, risks, and verification steps.',
  },
  general: {
    name: 'general',
    description: 'General-purpose subagent for delegated multi-step work.',
    tools: '',
    model: '',
    permissionMode: 'ask',
    body: 'You are a focused subagent. Complete the delegated task and report a compact summary.',
  },
};

/** Load .nexus/agents/*.md merged over the defaults. */
export function loadAgents(dir = process.cwd()) {
  const root = join(dir, '.nexus', 'agents');
  const out = { ...structuredClone(DEFAULT_AGENTS) };
  if (!existsSync(root)) return out;
  for (const f of readdirSync(root)) {
    if (!f.endsWith('.md')) continue;
    try {
      const { meta, body } = parseSkillMd(readFileSync(join(root, f), 'utf8'));
      if (!meta.name) continue;
      out[meta.name] = {
        name: meta.name,
        description: meta.description ?? '',
        tools: meta.tools ?? '',
        model: meta.model ?? '',
        permissionMode: meta.permissionmode ?? meta.permissionMode ?? 'ask',
        body,
      };
    } catch { /* skip */ }
  }
  return out;
}

/** Serialize agent definitions to disk (used by setup/defaults writer). */
export function writeDefaultAgents(dir) {
  const root = join(dir, '.nexus', 'agents');
  mkdirSync(root, { recursive: true });
  for (const a of Object.values(DEFAULT_AGENTS)) {
    const fm = [
      '---',
      `name: ${a.name}`,
      `description: ${a.description}`,
      `tools: ${a.tools}`,
      `permissionMode: ${a.permissionMode}`,
      '---',
      '',
      a.body,
      '',
    ].join('\n');
    writeFileSync(join(root, `${a.name}.md`), fm);
  }
}

/**
 * Build the agent.spawn tool. Requires the parent's ctx (provider, bus,
 * registry factory) plus AgentLoop. Concurrency capped by NEXUS_MAX_SUBAGENTS
 * (default 4).
 */
export function subagentTool({ ctx, AgentLoop, maxSubagents = null, executor = null }) {
  const limit = maxSubagents ?? Number(ctx.env.NEXUS_MAX_SUBAGENTS ?? 4);
  let active = 0;
  const runs = [];
  return {
    name: 'agent.spawn',
    description: `Run a named subagent (explore/plan/general or from .nexus/agents) with a delegated task in a separate context. Returns the subagent's final summary only. Max ${limit} concurrent. Available agents are listed in the system prompt.`,
    permission: 'agent.spawn',
    timeoutMs: 600_000,
    schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'agent name (explore, plan, general, or custom)' },
        task: { type: 'string', description: 'self-contained task for the subagent' },
        max_turns: { type: 'number', description: 'default 12' },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    handler: async (args, toolCtx) => {
      const agents = loadAgents(process.cwd());
      const def = agents[args.agent];
      if (!def) throw new Error(`unknown agent "${args.agent}" — available: ${Object.keys(agents).join(', ')}`);
      if (active >= limit) throw new Error(`subagent limit reached (${limit} concurrent)`);
      active++;
      const subject = `subagent:${def.name}:${Date.now().toString(36)}`;
      try {
        toolCtx.bus?.emit(makeEvent('subagent.started', {
          agent: def.name, subject, parentSession: toolCtx.sessionId ?? null, task: String(args.task).slice(0, 200),
        }, subject));
        const loop = new AgentLoop({
          provider: ctx.provider,
          tools: ctx.tools,
          bus: toolCtx.bus,
        });
        // agentId = the PARENT's principal so permission grants apply; the
        // distinct `subject` above keeps subagent events separately queryable.
        // Read-only agents (plan mode) tighten the SHARED executor for the
        // duration — ponytail: parallel subagents with different modes share
        // one executor, so the strictest mode wins while any runs.
        let prevMode = null;
        if (executor?.setPolicyMode && def.permissionMode) {
          prevMode = executor.getPolicyMode?.() ?? null;
          executor.setPolicyMode(def.permissionMode);
        }
        const result = await (async () => loop.run(String(args.task), {
          agentId: toolCtx.agentId ?? 'cli',
          sandbox: ctx.sandboxId,
          runtime: toolCtx.runtime ?? ctx.runtime,
          hostRoot: toolCtx.hostRoot ?? ctx.hostRoot,
          sandboxId: toolCtx.sandboxId ?? ctx.sandboxId,
          maxSteps: Math.min(30, Number(args.max_turns) || 12),
          env: ctx.env,
          system: def.body,
        }))().finally(() => {
          if (prevMode !== null && executor?.setPolicyMode) executor.setPolicyMode(prevMode);
        });
        const summary = {
          agent: def.name,
          done: result.done ?? false,
          steps: result.steps ?? 0,
          answer: String(result.answer ?? '').slice(0, 8000),
        };
        runs.push(summary);
        toolCtx.bus?.emit(makeEvent('subagent.finished', { agent: def.name, subject, steps: summary.steps, ok: summary.done }, subject));
        return summary;
      } finally {
        active--;
      }
    },
  };
}
