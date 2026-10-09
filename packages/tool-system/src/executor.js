// ToolExecutor — the single funnel every tool call passes through:
// registry lookup -> arg validation -> PermissionManager check -> audit ->
// events (agent.tool_called / agent.tool_finished) -> handler with hard
// timeout. Denials and validation failures are RESULTS, never thrown
// exceptions, so the agent loop can feed them back to the model (plan P05:
// "tool tanpa izin ditolak dengan event reason").
import { EVENTS, newEventId } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';
import { redact } from '@nexus/security';

/** Escape hatch: emit an event with an arbitrary canonical name. */
function emit(ctx, name, data) {
  if (!ctx.bus) return;
  ctx.bus.emit(makeEvent(name, data, ctx.agentId ?? null));
}

export class ToolExecutor {
  #registry;
  #permissions;
  #checkpointer;
  #hooks;
  #audit;
  #policy;

  /**
   * @param {{ registry: import('./registry.js').ToolRegistry,
   *   permissions?: import('@nexus/security').PermissionManager,
   *   audit?: import('@nexus/security').AuditTrail,
   *   policy?: { mode?: string, settings?: object,
   *     onAsk?: (call: {tool: string, args: object}) => Promise<boolean> } }} opts
   *   permissions/audit optional for pure unit tests; production wiring
   *   always supplies both (deny-by-default comes from PermissionManager).
   *   policy: permission mode gate (ask/accept-edits/plan/auto) + persistent
   *   rules + hard denylist. onAsk is the interactive prompt callback.
   */
  constructor({ registry, permissions = null, audit = null, policy = null, checkpointer = null, hooks = null }) {
    if (!registry) throw new TypeError('registry required');
    this.#registry = registry;
    this.#permissions = permissions;
    this.#checkpointer = checkpointer;
    this.#hooks = typeof hooks === 'function' ? hooks : null;
    this.#audit = audit;
    this.#policy = policy;
  }

  /**
   * @param {object} call { tool, args } (model-facing shape) or name/params
   * @param {{ agentId: string, sandboxId?: string, bus?: object,
   *   runtime?: object, env?: Record<string,string> }} ctx
   * @returns {Promise<{ ok: boolean, tool: string, result?: object,
   *   error?: string, reason?: string, durationMs: number }>}
   */
  async execute(call, ctx = {}) {
    const started = Date.now();
    const name = call?.tool ?? call?.name;
    const args = call?.args ?? call?.params ?? {};
    const base = { tool: String(name ?? 'unknown') };

    const tool = this.#registry.get(name);
    if (!tool) {
      return this.#finish(ctx, base, { ok: false, error: 'validation', reason: `unknown tool: ${name}`, durationMs: Date.now() - started });
    }

    const schemaErrors = this.#registry.validate(name, args);
    if (schemaErrors.length > 0) {
      return this.#finish(ctx, base, { ok: false, error: 'validation', reason: schemaErrors.join('; '), durationMs: Date.now() - started });
    }

    if (this.#policy) {
      const gate = await this.#policyGate(tool, args, ctx);
      if (!gate.allowed) {
        return this.#finish(ctx, base, { ok: false, error: 'denied', reason: gate.reason, durationMs: Date.now() - started });
      }
    }

    // Fase 6b: PreToolUse hooks — exit 2 blocks the action; stderr becomes
    // model feedback through the result reason.
    if (this.#hooks) {
      const h = await this.#hooks('PreToolUse', { tool: tool.name, args });
      if (h.blocked) {
        return this.#finish(ctx, base, { ok: false, error: 'blocked_by_hook', reason: h.feedback, durationMs: Date.now() - started });
      }
      if (h.patch?.args) Object.assign(args, h.patch.args);
    }

    if (this.#permissions) {
      // permission rules match on args.path; tools that root elsewhere
      // (fs.glob uses cwd) get it normalized before the check
      const permArgs = (tool.name === 'fs.glob' && args.path === undefined && args.cwd !== undefined)
        ? { ...args, path: args.cwd } : args;
      const decision = this.#permissions.check(ctx.agentId, tool.permission, permArgs);
      if (this.#audit) this.#audit.logDecision(decision);
      emit(ctx, EVENTS.PERMISSION_DECISION, {
        tool: tool.name, permission: tool.permission,
        allowed: decision.allowed, reason: decision.reason,
      });
      if (!decision.allowed) {
        return this.#finish(ctx, base, { ok: false, error: 'denied', reason: decision.reason, durationMs: Date.now() - started });
      }
    }

    emit(ctx, EVENTS.AGENT_TOOL_CALLED, { tool: tool.name, args });
    // Fase 6a: snapshot before mutating tools so /rewind can restore code
    if (this.#checkpointer && /^(fs|terminal)\./.test(tool.name)) {
      try {
        const cp = await this.#checkpointer.beforeTool({ tool: tool.name, args, ctx });
        if (cp) emit(ctx, 'tool.checkpointed', { tool: tool.name, checkpoint: cp.checkpoint, files: cp.files });
      } catch { /* checkpoint failure must not block the tool */ }
    }
    try {
      const result = await this.#withTimeout(tool.handler(args, { ...ctx, tool }), tool.timeoutMs);
      if (this.#hooks) {
        const h = await this.#hooks('PostToolUse', { tool: tool.name, args, result });
        if (h.patch?.result) Object.assign(result, h.patch.result);
      }
      return this.#finish(ctx, base, { ok: true, result, durationMs: Date.now() - started });
    } catch (err) {
      const reason = err?.message === '__tool_timeout__' ? `tool timed out after ${tool.timeoutMs}ms` : String(err?.message ?? err);
      return this.#finish(ctx, base, { ok: false, error: 'handler', reason, durationMs: Date.now() - started });
    }
  }

  /** Switch the permission mode at runtime (REPL /plan toggle). */
  setPolicyMode(mode) { if (this.#policy) this.#policy.mode = mode; }

  getPolicyMode() { return this.#policy?.mode ?? null; }

  /** Permission-mode gate: hard denylist > persistent rules > mode > ask. */
  async #policyGate(tool, args, ctx) {
    const { isHardDeniedCommand, isHardDeniedPath, isWriteAction, isReadTool, evalRules } = await import('@nexus/security');
    // 1. hard denylist — never bypassed, any mode
    if (tool.name === 'terminal.exec' && isHardDeniedCommand(String(args.command ?? ''))) {
      return { allowed: false, reason: 'hard deny: command is on the blocklist' };
    }
    const pathArg = args.path !== undefined ? args.path : (tool.name === 'fs.glob' ? args.cwd : undefined);
    if (pathArg !== undefined && isHardDeniedPath(String(pathArg))) {
      return { allowed: false, reason: 'hard deny: path is on the blocklist' };
    }
    // 2. persistent rules from .nexus/settings.json
    const settings = this.#policy.settings;
    if (settings) {
      const rule = evalRules(settings, tool.name, args);
      if (rule === 'deny') return { allowed: false, reason: `denied by rule: ${tool.name}` };
      if (rule === 'allow') return { allowed: true };
    }
    // 2b. web.fetch always asks (unless a persistent allow rule matched above)
    if (tool.name === 'web.fetch') return this.#ask(tool, args, ctx);
    // 2c. shell mode exec asks in every mode (stricter than plain exec)
    if (tool.name === 'terminal.exec' && args.shell) {
      const mode0 = this.#policy.mode ?? 'ask';
      if (mode0 !== 'auto') return this.#ask(tool, args, ctx);
    }
    // 3. mode
    const mode = this.#policy.mode ?? 'ask';
    if (mode === 'auto') return { allowed: true };
    if (mode === 'plan' && isWriteAction(tool.name, args)) {
      return { allowed: false, reason: 'plan mode: read-only, write actions denied' };
    }
    if (mode === 'accept-edits') {
      // accept-edits: file edits auto-approved; exec and everything else asks
      if (/^fs\.(write|edit)$/.test(tool.name)) return { allowed: true };
      if (isReadTool(tool.name)) return { allowed: true };
      return this.#ask(tool, args, ctx);
    }
    // mode === 'ask' (default)
    if (isReadTool(tool.name)) return { allowed: true }; // reads never prompt
    return this.#ask(tool, args, ctx);
  }

  async #ask(tool, args, ctx) {
    const onAsk = this.#policy?.onAsk;
    if (!onAsk) return { allowed: false, reason: `permission required for ${tool.name} (mode: ask, no interactive prompt available)` };
    try {
      const ok = await onAsk({ tool: tool.name, args });
      return ok ? { allowed: true } : { allowed: false, reason: `user denied ${tool.name}` };
    } catch (err) {
      return { allowed: false, reason: `permission prompt failed: ${String(err?.message ?? err)}` };
    }
  }

  #withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('__tool_timeout__'), { timedOut: true })), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  #finish(ctx, base, out) {
    // C2: redact secret-looking values from tool results before they land in
    // the event store (and from there, the model context).
    let result = out.result;
    if (out.ok && result !== undefined && result !== null) {
      try { result = redact(result); } catch { result = { redacted: true }; }
    }
    emit(ctx, EVENTS.AGENT_TOOL_FINISHED, {
      tool: base.tool, ok: out.ok,
      error: out.error ?? null, reason: out.ok ? null : out.reason,
      duration_ms: out.durationMs,
      ...(result !== undefined ? { result } : {}),
    });
    return { ...base, ...out, ...(result !== undefined ? { result } : {}) };
  }
}
