// Agent loop (plan sec 8): task -> LLM with tool schemas -> parse tool_calls ->
// permission gate -> tool execute -> feed results back -> repeat until final
// answer or maxSteps. Every step emits events on the EventBus (sec 11).
//
// ToolManager contract (implemented by @nexus/tool-system, mocked in tests):
//   list() -> [{ name, description, parameters }]        // JSON schemas
//   execute(name, args, ctx) -> { ok, output } | throws  // ctx: { agentId, sandbox }
// Permission contract (@nexus/security PermissionManager):
//   check(agentId, tool, args) -> { allowed, reason, ... }

import { EVENTS, makeEvent } from '@nexus/event-system';

export class AgentLoop {
  #provider; #tools; #permissions; #audit; #bus; #model; #verdictShortcut;

  /**
   * @param {{ provider: {chat: Function}, tools: {list: Function, execute: Function},
   *           permissions?: {check: Function}, audit?: {logDecision: Function},
   *           bus?: {emit: Function}, model?: string, verdictShortcut?: boolean }} deps
   *   verdictShortcut: opt-in — treat a short PASS/FAIL/ERROR content alongside a
   *   successful tool call as the final answer (P09 e2e behavior). Default false.
   */
  constructor({ provider, tools, permissions = null, audit = null, bus = null, model = null, verdictShortcut = false }) {
    if (!provider?.chat) throw new TypeError('provider with chat() required');
    if (!tools?.list || !tools?.execute) throw new TypeError('tools with list()/execute() required');
    this.#provider = provider;
    this.#tools = tools;
    this.#permissions = permissions;
    this.#audit = audit;
    this.#bus = bus;
    this.#model = model;
    this.#verdictShortcut = verdictShortcut === true;
  }


  /** Model call: streams (text deltas -> onEvent) when the UI asks for it and
   *  the provider supports stream(); otherwise plain chat(). Same result shape. */
  async #callModel(messages, schemas, { signal, onEvent } = {}) {
    const opts = { model: this.#model ?? undefined, tools: schemas.length ? schemas : undefined, ...(signal ? { signal } : {}) };
    if (typeof onEvent !== 'function' || typeof this.#provider.stream !== 'function') {
      return this.#provider.chat(messages, opts);
    }
    let result = null;
    for await (const e of this.#provider.stream(messages, opts)) {
      if (e.type === 'text') {
        try { onEvent({ type: 'text_delta', delta: e.delta }); } catch { /* UI errors never kill the loop */ }
      } else if (e.type === 'tool_call_delta') {
        try { onEvent({ type: 'tool_call_delta', index: e.index, name: e.name, argsFragment: e.argsFragment }); } catch { /* ditto */ }
      } else if (e.type === 'usage') {
        try { onEvent({ type: 'usage', usage: e.usage }); } catch { /* ditto */ }
      } else if (e.type === 'done') {
        result = e.result;
      }
    }
    return result ?? this.#provider.chat(messages, opts);
  }

  /** Switch the model for subsequent calls (REPL /model). */
  setModel(m) { this.#model = m ?? null; }

  #emit(name, data, subject = null) {
    if (!this.#bus) return;
    try { this.#bus.emit(makeEvent(name, data, subject)); } catch { /* observability must never kill the loop */ }
  }

  /**
   * Run a task to completion.
   * @param {string} task user-visible goal
   * @param {{ agentId: string, sandbox?: unknown, maxSteps?: number, system?: string }} ctx
   * @returns {Promise<{ done: boolean, answer: string|null, steps: number, history: Array }>}
   */
  async run(task, { agentId, sandbox = null, maxSteps = 16, system, history = null, signal = null, onEvent = null, ...toolCtx } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new TypeError('task required');
    if (!agentId) throw new TypeError('agentId required');

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    // C1 --continue/--resume: prior conversation spine (user/assistant pairs)
    if (Array.isArray(history)) {
      for (const m of history) {
        if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    messages.push({ role: 'user', content: task });

    const schemas = this.#tools.list();
    if (signal?.aborted) throw new Error('aborted before start');
    this.#emit(EVENTS.TASK_CREATED, { task, agentId }, agentId);
    this.#emit(EVENTS.AGENT_STARTED, { agentId, maxSteps }, agentId);

    let steps = 0;
    for (; steps < maxSteps; steps++) {
      if (signal?.aborted) throw new Error('aborted');
      const res = await this.#callModel(messages, schemas, { signal, onEvent });
      const calls = Array.isArray(res.tool_calls) && res.tool_calls.length
        ? res.tool_calls
        : (res.tool_call ? [res.tool_call] : []);
      const content = res.content ?? null;
      this.#emit('agent.step', { step: steps, model: res.model, usedTool: calls.length > 0 }, agentId);

      if (calls.length === 0) {
        // no tool call -> final answer
        if (content) messages.push({ role: 'assistant', content });
        this.#emit(EVENTS.TASK_COMPLETED, { steps: steps + 1, answerLength: (content || '').length }, agentId);
        return { done: true, answer: content, steps: steps + 1, history: messages };
      }

      // Opt-in (P09): after a successful tool, a short content containing a
      // verdict marker (PASS/FAIL) is the final answer even though a tool_call
      // was also emitted in this step. hermes-agent returns both content +
      // tool_call in one turn for the "run the test, answer PASS" phase.
      if (this.#verdictShortcut) {
        const verdictRe = /\b(PASS|FAIL|FAILED|ERROR)\b/i;
        const trimmedContent = typeof content === 'string' ? content.trim() : '';
        const lastIdx = messages.length - 1;
        const lastMsg = lastIdx >= 0 ? messages[lastIdx] : null;
        const lastToolOk = lastMsg && lastMsg.role === 'tool' && lastMsg.ok !== false
          && !/TOOL ERROR|PERMISSION DENIED/i.test(String(lastMsg.content || ''));
        if (lastToolOk && verdictRe.test(trimmedContent) && trimmedContent.length <= 200) {
          messages.push({ role: 'assistant', content: trimmedContent });
          this.#emit(EVENTS.TASK_COMPLETED, { steps: steps + 1, answerLength: trimmedContent.length, verdict: true }, agentId);
          return { done: true, answer: trimmedContent, steps: steps + 1, history: messages };
        }
      }

      messages.push({
        role: 'assistant',
        content: content ?? '',
        tool_calls: calls.map((c, i) => ({
          id: c.id || 'call_' + steps + '_' + i,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      });

      // Execute every tool call in this turn; one tool message per tool_call_id.
      for (let ci = 0; ci < calls.length; ci++) {
        const call = calls[ci];
        const callId = call.id || 'call_' + steps + '_' + ci;
        const { name, arguments: args = {} } = call;
        this.#emit(EVENTS.AGENT_TOOL_CALLED, { tool: name, args }, agentId);

        const toolMsg = (ok, out) => ({ role: 'tool', tool_call_id: callId, content: out, ok });

        // permission gate (deny-by-default when permissions provided)
        if (this.#permissions) {
          const decision = this.#permissions.check(agentId, name, args);
          this.#audit?.logDecision?.(decision);
          if (!decision.allowed) {
            messages.push(toolMsg(false, 'PERMISSION DENIED: ' + decision.reason));
            this.#emit('agent.tool_denied', { tool: name, reason: decision.reason }, agentId);
            continue;
          }
        }

        let result;
        try {
          // forward toolCtx (runtime, sandboxId, bus, env) untouched — the
          // ToolExecutor funnel owns permission/audit/event wiring (P07b).
          result = await this.#tools.execute(name, args, { agentId, sandbox, bus: this.#bus, ...toolCtx });
          messages.push(toolMsg(true, stringify(result?.output)));
        } catch (e) {
          messages.push(toolMsg(false, 'TOOL ERROR: ' + e.message));
        }
        this.#emit('agent.tool_result', { tool: name, ok: !!result?.ok }, agentId);
      }
    }

    this.#emit('agent.exhausted', { maxSteps }, agentId);
    return { done: false, answer: null, steps, history: messages };
  }
}

const stringify = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
