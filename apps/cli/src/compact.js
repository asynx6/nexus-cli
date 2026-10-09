// Context budget + compaction (Fase 5).
import { makeEvent } from '@nexus/event-system';

const DEFAULT_WINDOW = 128_000;
const COMPACT_AT = 0.8;
const KEEP_TURNS = 6; // user/assistant pairs kept verbatim

export function contextWindow(env = process.env) {
  const n = Number(env.NEXUS_CONTEXT_WINDOW);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW;
}

/** Usage-based token count when available, len/4 estimate otherwise.
 *  Returns { tokens, estimated }. */
export function countTokens(usage, text) {
  if (usage && Number.isFinite(usage.total_tokens)) {
    return { tokens: usage.total_tokens, estimated: false };
  }
  const chars = typeof text === 'string' ? text.length
    : JSON.stringify(text ?? '').length;
  return { tokens: Math.ceil(chars / 4), estimated: true };
}

/** Rough token estimate for a message list (no usage needed). */
export function estimateHistoryTokens(messages = []) {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) chars += JSON.stringify(tc.function ?? {}).length;
    }
  }
  return Math.ceil(chars / 4);
}

export function shouldCompact(messages, env = process.env) {
  const tokens = estimateHistoryTokens(messages);
  return { tokens, window: contextWindow(env), compact: tokens > contextWindow(env) * COMPACT_AT };
}

/**
 * Compact a history: summarise old turns through the model, keep the last
 * KEEP_TURNS user/assistant pairs verbatim, keep the system message and
 * todo state. Emits session.compacted on the bus. Original events are NOT
 * deleted (append-only store) — the compacted-from reference points back.
 *
 * @param {object} p
 * @param {Array} p.messages OpenAI-format history
 * @param {{ chat: Function }} p.provider
 * @param {string} p.sessionId
 * @param {object} [p.bus]
 * @param {string} [p.instructions] extra compaction guidance (/compact arg)
 * @param {import('@nexus/model-providers').ModelProvider} [p.provider]
 */
export async function compactHistory({ messages, provider, sessionId, bus, instructions = '', model = null }) {
  if (!provider || typeof provider.chat !== 'function') throw new TypeError('provider with chat() required');
  const sys = messages.find((m) => m.role === 'system');
  const convo = messages.filter((m) => m.role !== 'system');

  // split point: keep last KEEP_TURNS user messages (and what follows them)
  const userIdx = [];
  convo.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
  const keepFrom = userIdx.length > KEEP_TURNS ? userIdx[userIdx.length - KEEP_TURNS] : 0;
  const old = convo.slice(0, keepFrom);
  const kept = convo.slice(keepFrom);
  if (!old.length) return { messages, compacted: false, reason: 'nothing to compact' };

  // render old turns as text for the summariser
  const transcript = old.map((m) => {
    if (m.role === 'tool') return `[tool result] ${typeof m.content === 'string' ? m.content.slice(0, 800) : JSON.stringify(m.content).slice(0, 800)}`;
    if (Array.isArray(m.tool_calls)) return `[assistant tool_call] ${m.tool_calls.map((tc) => tc.function?.name + '(' + String(tc.function?.arguments ?? '').slice(0, 300) + ')').join(', ')}`;
    return `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 2000) : JSON.stringify(m.content).slice(0, 2000)}`;
  }).join('\n');

  const sysPrompt = `You are a compaction engine for an agent CLI. Summarise the conversation below into a dense, factual brief that a coding agent can continue from. Keep: goals, decisions made, files touched, tool results that matter, open tasks. Drop: pleasantries, redundant tool output. Max 400 words. Output plain text only.${instructions ? `\nExtra guidance: ${instructions}` : ''}`;

  const res = await provider.chat([{ role: 'user', content: sysPrompt + '\n\n---\n' + transcript }], { model });
  const brief = (res.content ?? '').trim() || '(compaction produced empty summary)';

  const summaryMsg = {
    role: 'user',
    content: `[system: earlier conversation compacted — summary follows]\n${brief}\n[summary ends; continue from here]`,
  };
  const out = [...(sys ? [sys] : []), summaryMsg, ...kept];

  if (bus) {
    bus.emit(makeEvent('session.compacted', {
      session: sessionId,
      compacted_from: keepFrom,
      old_messages: old.length,
      kept_messages: kept.length + 1,
      summary_chars: brief.length,
      instructions: instructions || null,
    }, sessionId));
  }
  return { messages: out, compacted: true, summary: brief, oldCount: old.length, keptCount: kept.length + 1 };
}
