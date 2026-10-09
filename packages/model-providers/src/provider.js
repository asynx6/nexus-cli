// @asynx6/model-provider — OpenAI-compatible chat client for the NEXUS gateway.
// Zero deps: global fetch + AbortSignal.timeout. No keys in logs, ever.
// Secrets reach this module only via explicit `apiKey` option (caller pulls
// from SecretStore / env — plan sec 22).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal token bucket, inlined so this package stays zero-dep.
// Capacity = burst; refills steadily at capacity/rpm per ms.
export class MiniBucket {
  constructor({ rpm, burst }) {
    this.capacity = burst;
    this.perMs = rpm / 60_000;
    this.tokens = burst;
    this.last = Date.now();
  }
  waitMs(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    if (this.tokens >= cost) return 0;
    return Math.ceil((cost - this.tokens) / this.perMs);
  }
  consume(cost = 1) { this.tokens -= cost; }
}

/** Parse an SSE chat-completions body into the final aggregated response.
 *  Accumulates content AND tool_call deltas per index (name + argument
 *  fragments arrive across chunks). */
function parseSseBody(text) {
  const acc = { choices: [{ message: { content: '' } }] };
  const toolAcc = new Map(); // index -> { id, name, args }
  let sawChunk = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      sawChunk = true;
      const dc = chunk.choices?.[0]?.delta;
      if (dc?.content) acc.choices[0].message.content += dc.content;
      if (Array.isArray(dc?.tool_calls)) {
        for (const tc of dc.tool_calls) {
          const idx = tc.index ?? 0;
          let slot = toolAcc.get(idx);
          if (!slot) { slot = { id: null, name: '', args: '' }; toolAcc.set(idx, slot); }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
      if (chunk.usage) acc.usage = chunk.usage;
      if (chunk.model) acc.model = chunk.model;
    } catch { /* skip malformed frames */ }
  }
  if (toolAcc.size > 0) {
    const calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => ({
      index: i,
      id: s.id,
      type: 'function',
      function: { name: s.name, arguments: s.args },
    }));
    acc.choices[0].message.tool_calls = calls;
  }
  return sawChunk ? acc : null;
}

export class ModelProvider {
  #base; #key; #models; #timeoutMs; #retries; #rateLimit;

  /**
   * @param {{ baseUrl: string, apiKey?: string, models?: string[], timeoutMs?: number, retries?: number, rateLimit?: { rpm?: number, burst?: number } }} opts
   *   models: ordered fallback list; first entry is primary.
   *   rateLimit: optional client-side throttle — rpm = sustained calls/min,
   *     burst = max instant calls. Prevents burning quota on a tight loop.
   */
  constructor({ baseUrl, apiKey = process.env.NEXUS_GATEWAY_KEY, models = ['hermes-agent'], timeoutMs = 60000, retries = 1, rateLimit = null }) {
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) throw new TypeError('baseUrl must be an http(s) URL');
    if (!apiKey) throw new Error('apiKey required (pass explicitly or set NEXUS_GATEWAY_KEY)');
    if (!Array.isArray(models) || models.length === 0) throw new TypeError('models must be a non-empty array');
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#key = apiKey;
    this.#models = [...models];
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#rateLimit = rateLimit ? new MiniBucket({
      rpm: rateLimit.rpm ?? 1,
      burst: rateLimit.burst ?? rateLimit.rpm ?? 1
    }) : null;
  }

  get models() { return [...this.#models]; }

  /** Sleep until the rate limiter allows a call. No-op when unconfigured. */
  async #awaitRateLimit() {
    if (!this.#rateLimit) return;
    const waitMs = this.#rateLimit.waitMs();
    if (waitMs > 0) await sleep(waitMs);
    this.#rateLimit.consume();
  }

  /**
   * Chat completion with fallback across configured models.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ model?: string, maxTokens?: number, temperature?: number }} [opts]
   * @returns {Promise<{ model: string, content: string, usage: object|null }>}
   */
  async chat(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages must be a non-empty array');
    const order = opts.model ? [opts.model, ...this.#models.filter((m) => m !== opts.model)] : this.#models;
    let lastErr;
    for (const model of order) {
      for (let attempt = 0; attempt <= this.#retries; attempt++) {
        try {
          await this.#awaitRateLimit();
          return await this.#oneCall(model, messages, opts);
        } catch (e) {
          lastErr = e;
          // 4xx (except 429) = permanent, try next model immediately
          if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
          if (attempt < this.#retries) await sleep(400 * (attempt + 1));
        }
      }
    }
    throw new Error('all models failed; last: ' + (lastErr?.message || 'unknown'));
  }

  async #oneCall(model, messages, opts) {
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs);
    const body = {
      model,
      // internal metadata (ok, etc.) must never reach the API
      messages: messages.map((m) => {
        const out = { role: m.role };
        if (m.content !== undefined) out.content = m.content ?? '';
        if (m.name !== undefined) out.name = m.name;
        if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
        if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
        return out;
      }),
      max_tokens: opts.maxTokens ?? Number(process.env.NEXUS_MAX_TOKENS ?? 4096),
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    // native OpenAI function calling: caller passes plain [{name,description,parameters}]
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: t }));
      // some gateways (api.asynx6.tech) reject tools without an explicit tool_choice
      body.tool_choice = 'auto';
    }
    const r = await fetch(this.#base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.#key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      const err = new Error('provider ' + r.status + ' on ' + model);
      err.status = r.status;
      throw err;
    }
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = parseSseBody(text); // gateway sometimes replies SSE (data: {...}) to non-stream calls
    }
    if (!j) { const err = new Error('provider returned unparseable body for ' + model); err.status = 502; throw err; }
    // gateway may add non-standard fields (e.g. _manifest); choices must exist
    const choice = Array.isArray(j.choices) && j.choices[0];
    if (!choice) { const err = new Error('provider returned no choices for ' + model); err.status = 502; throw err; }
    return this.#normalize(model, j);
  }

  /** Shared response normalization (chat + stream fallback). */
  #normalize(model, j) {
    const msg = (Array.isArray(j.choices) && j.choices[0])?.message ?? {};
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const tool_calls = rawCalls.map((native) => {
      let args = native.function?.arguments ?? '{}';
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { _raw: args }; } }
      return { id: native.id ?? null, name: native.function?.name, arguments: args };
    }).filter((c) => c.name);
    return {
      model, content: msg.content ?? null,
      tool_calls, tool_call: tool_calls[0] ?? null,
      usage: j.usage ?? null, id: j.id ?? null,
    };
  }


  /**
   * Streaming chat (Fase 3): async generator over SSE chunks.
   * Yields {type:'text', delta}, {type:'tool_call_delta', index, id, name,
   * argsFragment}, {type:'usage', usage}, {type:'done', result} where result
   * matches the chat() contract. Falls back to non-stream chat() when the
   * gateway rejects streaming (non-200 or non-SSE body). Honors opts.signal.
   */
  async *stream(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages must be a non-empty array');
    const model = opts.model ?? this.#models[0];
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs);
    const body = {
      model,
      messages: messages.map((m) => {
        const out = { role: m.role };
        if (m.content !== undefined) out.content = m.content ?? '';
        if (m.name !== undefined) out.name = m.name;
        if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
        if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
        return out;
      }),
      max_tokens: opts.maxTokens ?? Number(process.env.NEXUS_MAX_TOKENS ?? 4096),
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }

    let r;
    try {
      r = await fetch(this.#base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.#key, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      r = null; // network error -> fallback below
    }
    const isSse = r && r.ok && (r.headers.get('content-type') ?? '').includes('event-stream');
    if (!isSse) {
      let res = null;
      if (r && r.ok) {
        // 200 but not SSE: the gateway answered a normal completion — parse it
        // directly instead of re-asking (no double billing, no lost turn).
        const text = await r.text().catch(() => '');
        let j = null;
        try { j = JSON.parse(text); } catch { j = parseSseBody(text); }
        if (j?.choices?.[0]) res = this.#normalize(model, j);
      }
      if (!res) {
        // stream rejected (non-200 / network) -> plain non-stream call
        const out = await this.chat(messages, opts);
        res = out;
      }
      if (res.content) yield { type: 'text', delta: res.content };
      if (res.usage) yield { type: 'usage', usage: res.usage };
      yield { type: 'done', result: res };
      return;
    }

    // incremental SSE parse
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let usage = null;
    const toolAcc = new Map();
    const finish = () => {
      const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([i, slot]) => {
        let args = slot.args || '{}';
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { _raw: args }; } }
        return { id: slot.id, name: slot.name, arguments: args };
      }).filter((c) => c.name);
      return {
        model, content: content || null,
        tool_calls: toolCalls, tool_call: toolCalls[0] ?? null,
        usage, id: null,
      };
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') {
            yield { type: 'done', result: finish() };
            return;
          }
          try {
            const chunk = JSON.parse(payload);
            const dc = chunk.choices?.[0]?.delta;
            if (dc?.content) { content += dc.content; yield { type: 'text', delta: dc.content }; }
            if (Array.isArray(dc?.tool_calls)) {
              for (const tc of dc.tool_calls) {
                const i = tc.index ?? 0;
                let slot = toolAcc.get(i);
                if (!slot) { slot = { id: null, name: '', args: '' }; toolAcc.set(i, slot); }
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name += tc.function.name;
                if (tc.function?.arguments) slot.args += tc.function.arguments;
                yield { type: 'tool_call_delta', index: i, id: slot.id, name: slot.name, argsFragment: tc.function?.arguments ?? '' };
              }
            }
            if (chunk.usage) { usage = chunk.usage; yield { type: 'usage', usage: chunk.usage }; }
          } catch { /* skip malformed frames */ }
        }
      }
      // stream ended without [DONE]
      yield { type: 'done', result: finish() };
    } finally {
      try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
    }
  }

  /** List model ids from /models (gateway-provided). */
  async listModels() {
    const r = await fetch(this.#base + '/models', {
      headers: { Authorization: 'Bearer ' + this.#key, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!r.ok) { const e = new Error('listModels ' + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    return (j.data || j).map?.((m) => m.id ?? m) ?? [];
  }
}
