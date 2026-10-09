// ../vendor/cli/index.js ctx builder — wire shared+events+tools+security+provider+loop
// Keeps imports DOWN-only (no other package imports ../vendor/cli/index.js).
// Zero external deps. Node ≥22 ESM.

import { loadEnv, makeLogger, DEFAULT_GATEWAY_BASE } from '@asynx6/nexus-shared';
import { EventBus, EventStore, makeEvent } from '@asynx6/nexus-event-system';
import { ModelProvider } from '@asynx6/nexus-model-providers';
import { ToolRegistry, ToolExecutor, fsTools, terminalTools, todoTools, webTools, repoMapTools, autoDiscoverTools } from '@asynx6/nexus-tool-system';
import { PermissionManager, AuditTrail, Vault, ProjectSecrets, loadSettings } from '@asynx6/nexus-security';
import { HostRuntime, DockerRuntime } from '@asynx6/nexus-sandbox-runtime';
import { loadPromptStore } from './prompts.js';
import { AgentLoop, loopTools } from '@asynx6/nexus-agent-runtime';
import { loadPlugins } from '@asynx6/nexus-plugin-registry';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export { AgentLoop };

/** Build a reusable run context: provider + tools + loop + event bus + store.
 *  Env-driven config (NEXUS_GATEWAY_*) — no secrets in code. */
export async function buildRunCtx(opts = {}) {
  // loadEnv populates process.env without leaking values; read them back.
  // Gateway secrets live in .env-gateway (setup wizard target), not .env.
  loadEnv('.env-gateway');
  const env = opts.env ?? process.env;
  const log = opts.log ?? makeLogger('cli');

  const bus = new EventBus();
  const store = new StoreHandle(opts.storeDir ?? './.nexus/store');
  const audit = new AuditTrail({ bus, runId: opts.runId ?? 'cli' });

  // B2: every bus event lands in the store, in order. Store errors never
  // kill the loop; pending appends flush before close().
  const appendQueue = Promise.resolve();
  let queueTail = appendQueue;
  bus.on('*', (e) => {
    queueTail = queueTail.then(() => store.append(e)).catch(() => {});
  });

  // B1: sandbox backend. host (default) locks execution to cwd; docker mounts
  // cwd at /workspace via --sandbox=docker.
  const sandboxMode = opts.sandbox ?? 'host';
  let runtime = null;
  let sandboxId = null;
  let hostRoot = null;
  if (sandboxMode === 'docker') {
    const socketPath = env.NEXUS_DOCKER_SOCKET ?? '/var/run/docker.sock';
    runtime = new DockerRuntime({ socketPath });
    sandboxId = await runtime.create({ image: env.NEXUS_SANDBOX_IMAGE ?? 'python:3.12-slim', memoryMb: 512, network: 'none' });
    await runtime.start(sandboxId);
  } else {
    hostRoot = process.cwd();
    runtime = new HostRuntime({ root: hostRoot, env: {} });
    sandboxId = await runtime.create({});
  }

  const baseUrl = opts.baseUrl ?? env.NEXUS_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE;
  const apiKey = opts.apiKey ?? env.NEXUS_GATEWAY_KEY;
  if (!apiKey) throw new Error('NEXUS_GATEWAY_KEY required (env or opts)');
  const models = (opts.models ?? env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const provider = new ModelProvider({
    baseUrl, apiKey, models, timeoutMs: opts.timeoutMs ?? 120_000,
    rateLimit: opts.rateLimit ?? (env.NEXUS_RATE_LIMIT_RPM
      ? { rpm: Number(env.NEXUS_RATE_LIMIT_RPM), burst: Number(env.NEXUS_RATE_LIMIT_BURST ?? env.NEXUS_RATE_LIMIT_RPM) }
      : null)
  });
  const registry = new ToolRegistry();
  for (const t of fsTools({ allowedPaths: ['/workspace', process.cwd()] })) registry.register(t);
  for (const t of terminalTools({ timeoutMs: 60_000 })) registry.register(t);
  for (const t of todoTools({ dir: process.cwd() })) registry.register(t);
  for (const t of webTools()) registry.register(t);
  for (const t of repoMapTools({ cacheDir: join(process.cwd(), '.nexus', 'cache') })) registry.register(t);
  const pluginErrors = [];
  if (env.NEXUS_ENABLE_PLUGINS !== '0') {
    const pluginDirs = [join(process.cwd(), '.nexus', 'plugins')];
    if (env.NEXUS_PLUGIN_DIR) pluginDirs.push(env.NEXUS_PLUGIN_DIR);
    const { plugins, errors } = await loadPlugins(pluginDirs);
    for (const pl of plugins) {
      for (const t of pl.tools) {
        if (!registry.has(t.name)) registry.register(t);
      }
    }
    pluginErrors.push(...errors);
    if (errors.length && log) log.warn(`plugins: ${errors.length} failed to load`);
  }
  // Fase 6c: skill.load tool — body loads only on invocation
  registry.register({
    name: 'skill.load',
    description: 'Load a skill body by name (see the skills index in the system prompt). Use before following a skill.',
    permission: 'skill.load',
    timeoutMs: 5_000,
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill name (without slash)' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { loadSkills } = await import('./skills.js');
      const skills = loadSkills(process.cwd());
      const hit = skills['/' + String(args.name).replace(/^\//, '')];
      if (!hit) throw new Error(`unknown skill: ${args.name} (available: ${Object.keys(skills).join(', ') || 'none'})`);
      return { name: hit.name, description: hit.description, body: hit.body };
    },
  });

  // Fase 6e: MCP servers from .nexus/mcp.json (skipped when NEXUS_MCP=0)
  let mcpClients = [];
  let mcpErrors = [];
  if (env.NEXUS_MCP !== '0') {
    const { loadMcpConfig, connectAll } = await import('./mcp-client.js');
    const cfg = loadMcpConfig(process.cwd());
    if (Object.keys(cfg.servers).length) {
      const { clients, errors } = await connectAll(cfg, { cwd: process.cwd() });
      mcpClients = clients;
      mcpErrors = errors;
      for (const c of clients) c.registerInto(registry);
      if (errors.length && log) log.warn(`mcp: ${errors.join('; ')}`);
    }
  }

  // A3 auto-discovery: *.tools.js under .nexus/tools + @asynx6/tool-* deps.
  // Runs after plugins, so an explicit project tool always wins a name clash.
  const auto = await autoDiscoverTools(registry, { cwd: process.cwd() });
  pluginErrors.push(...auto.errors.map((e) => ({ path: e.source, error: e.error })));
  if (auto.errors.length && log) log.warn(`tool discovery: ${auto.errors.length} source(s) failed`);
  const allowedPaths = ['/workspace', process.cwd()];
  let allowedPathPatterns = allowedPaths.flatMap((p) => [p, `${p}/**`]);
  // host mode: the model passes project-relative paths; they must match too
  if (sandboxMode === 'host') allowedPathPatterns = allowedPathPatterns.concat(['**', '']);
  const permissions = new PermissionManager();
  const principal = opts.agentId ?? 'cli';
  permissions.grant(principal, 'fs.read', { paths: allowedPathPatterns });
  permissions.grant(principal, 'fs.write', { paths: allowedPathPatterns });
  permissions.grant(principal, 'fs.edit', { paths: allowedPathPatterns });
  permissions.grant(principal, 'terminal.exec', {});
  permissions.grant(principal, 'todo.write', {});
  permissions.grant(principal, 'web.fetch', {});
  permissions.grant(principal, 'repo.map', {});
  permissions.grant(principal, 'agent.spawn', {});
  permissions.grant(principal, 'skill.load', {});
  permissions.grant(principal, 'mcp.call', {});

  // C2: permission mode gate (hard denylist > rules > mode > interactive ask).
  const settings = opts.policySettings ?? loadSettings(process.cwd());
  const permissionMode = opts.permissionMode ?? settings.permissions?.defaultMode ?? 'ask';
  const { Checkpointer } = await import('@asynx6/nexus-tool-system');
  const checkpointer = new Checkpointer({ root: join(process.cwd(), '.nexus', 'checkpoints'), sessionId: opts.sessionId ?? 'default' });
  // Fase 6b: hooks — reload from disk per call so /permissions edits apply live
  const { runHooks: runHooksFn, loadHooks: loadHooksFn } = await import('./hooks.js');
  const executor = new ToolExecutor({
    registry, permissions, audit,
    policy: { mode: permissionMode, settings, onAsk: opts.onAsk },
    checkpointer,
    hooks: (ev, payload) => {
      let map = {};
      try { map = loadHooksFn(process.cwd()); } catch { /* bad settings — no hooks */ }
      return runHooksFn(map, ev, payload, { cwd: process.cwd() });
    },
  });
  const tools = loopTools({ registry, executor });

  // Fase 6d: agent.spawn — in-process AgentLoop, separate context.
  // Registered after provider/tools exist so the handler gets live refs.
  const { AgentLoop: Loop } = await import('@asynx6/nexus-agent-runtime');
  const { subagentTool } = await import('./subagent.js');
  registry.register(subagentTool({ ctx: { provider, tools, env }, AgentLoop: Loop, maxSubagents: null, executor }));

  // E1: decrypt the per-project vault and materialize granted secrets into the
  // exec env. With no vault configured this is a no-op — P04 behavior unchanged.
  let projectSecrets = null;
  let secretNames = [];
  const pass = opts.passphrase ?? env.NEXUS_PROJECT_PASSPHRASE;
  const vaultPath = opts.vaultPath ?? env.NEXUS_PROJECT_SECRETS_FILE ?? join(process.cwd(), '.nexus', 'secrets.enc');
  if (pass && existsSync(vaultPath)) {
    const vault = Vault.open(pass, readFileSync(vaultPath, 'utf8'));
    projectSecrets = new ProjectSecrets({ vault, bus });
    loadGrantsSidecar(projectSecrets, vaultPath);
    // 'cli' is the principal for a local run; agent ids get grants via the API.
    secretNames = projectSecrets.grantsFor('cli');
    for (const name of secretNames) {
      const plaintext = vault.get(name);
      if (plaintext !== null) env[name] = plaintext;
    }
    if (secretNames.length && log) log.info(`secrets: ${secretNames.length} injected from project vault`);
  }

  // A4: named, versioned system prompts. Load the persisted store (this is the
  // same file `nexus prompts edit` writes) and seed built-ins on top, so a run
  // sees published versions and `--prompt=name@hash` resolves to real bytes.
  const prompts = loadPromptStore(env).registry;

  const { loadSkills } = await import('./skills.js');
  const skills = loadSkills(process.cwd());
  const { loadHooks } = await import('./hooks.js');
  const hooks = loadHooks(process.cwd());
  const { loadAgents: agentsIndex } = await import('./subagent.js');

  return { log, bus, store, audit, provider, registry, permissions, executor, tools, env, pluginErrors,
    projectSecrets, secretNames, prompts, runtime, sandboxId, hostRoot, sandboxMode, permissionMode,
    checkpointer, skills, hooks, mcpClients, mcpErrors, agentDefs: agentsIndex(process.cwd()),
    flushEvents: () => queueTail };
}

/** Grants live in <vault>.grants (names only — never values). */
function loadGrantsSidecar(secrets, vaultPath) {
  const p = vaultPath + '.grants';
  if (!existsSync(p)) return;
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  for (const [principal, names] of Object.entries(doc)) {
    for (const name of names) secrets.grant(principal, name);
  }
}

/** Build a replay context: only event store + bus (read-only). */
export function buildReplayCtx(opts = {}) {
  const store = new StoreHandle(opts.storeDir ?? './.nexus/store');
  const bus = new EventBus();
  return { bus, store };
}

/** Lazy wrapper that opens EventStore on first access and keeps path. */
class StoreHandle {
  constructor(dir) {
    this.dir = dir;
    this._store = null;
  }
  async open() {
    if (!this._store) this._store = new EventStore(this.dir + '/events.jsonl');
    return this._store;
  }
  async append(env) { return this.open().then((s) => s.append(env)); }
  async replay(opts) { return this.open().then((s) => s.replay(opts)); }
  async close() { if (this._store) await this._store.close(); }
}

/** Wait for the bus→store append queue to drain, then close the store. */
export async function closeCtx(ctx) {
  if (ctx?.flushEvents) await ctx.flushEvents();
  await ctx?.store?.close();
}
