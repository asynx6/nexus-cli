import { createHash } from 'node:crypto';

/**
 * FakeProvider — provider skrip untuk test.
 * @param {Array<{content?: string|null, tool_calls?: Array<{id: string, name: string, arguments: object}>, usage?: {promptTokens?: number, completionTokens?: number, totalTokens?: number}}>[]} queue
 */
function FakeProvider(queue = []) {
  let idx = 0;
  let streamIdx = 0;
  const model = 'fake/empty';

  async function chat(messages, { tools, signal } = {}) {
    if (signal?.aborted) throw new Error('aborted');
    const turn = queue[idx++] ?? { content: null };
    const text = turn.content ?? '';
    const calls = (turn.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? 'call_' + i,
      name: tc.name,
      arguments: tc.arguments ?? {},
    }));
    return {
      model,
      content: text || null,
      tool_calls: calls,
      tool_call: calls[0] ?? null,
      usage: {
        promptTokens: turn.usage?.promptTokens ?? 0,
        completionTokens: turn.usage?.completionTokens ?? 0,
        totalTokens: turn.usage?.totalTokens ?? 0,
      },
    };
  }

  async function* stream(messages, { tools, signal } = {}) {
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    const turn = queue[streamIdx++ ?? 0] ?? { content: '' };
    const content = turn.content ?? '';
    const text = typeof content === 'string' ? content : '';
    if (turn.tool_calls && turn.tool_calls.length) {
      const argObj = turn.tool_calls[0]?.arguments ?? {};
      let i = 0;
      for (const [k, v] of Object.entries(argObj)) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          delta: {
            index: 0,
            tool_calls: [
              {
                index: 0,
                id: turn.tool_calls[0].id,
                type: 'function',
                function: {
                  name: turn.tool_calls[0].name,
                  arguments: Object.entries(argObj)
                    .slice(0, i + 1)
                    .map(([kk, vv]) => (kk === k ? JSON.stringify(vv) : vv))
                    .join(''),
                },
              },
            ],
          },
        };
        i += 1;
      }
      yield { type: 'tool_calls_done' };
      yield { type: 'usage', usage: turn.usage ?? {} };
      yield { type: 'done' };
      return;
    }
    for (let j = 0; j < text.length; j += 1) {
      yield { type: 'text', delta: { content: text[j] } };
    }
    yield { type: 'done' };
  }

  return {
    model,
    async chat(...args) {
      return chat(...args);
    },
    async list() {
      return { data: [{ id: model }] };
    },
    stream(...args) {
      return stream(...args);
    },
    _getRemaining() {
      return queue.slice(idx);
    },
  };
}

export { FakeProvider };
export default FakeProvider;
