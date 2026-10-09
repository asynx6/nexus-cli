// Multi-model consensus engine.
// - Reads NEXUS_CONSENSUS_MODELS env (comma-sep) for the model set to run in parallel.
// - Runs them all in parallel for each chat() step.
// - Aggregates with majority voting on (tool_call.name + tool_call.arguments + content-verdict).
// - Emits consensus.round.{n} per step and consensus.verdict at the end.
// - If only one model is configured OR all parallel calls fail with permanent 401,
//   falls back to single-model (legacy ModelProvider.chat path).
//
// Voting rules:
//   1. Group responses by (tool_call.name + JSON.stringify(args)) OR by content-verdict
//      (PASS/FAIL/FAILED/ERROR) when no tool_call. Tie => no winner, retry once with the
//      primary model; second tie => primary wins (deterministic fallback for demo).
//   2. "majority" = strictly more than half. With 2 models, majority = 2; with 3,
//      majority = 2; with 4, majority = 3. With 5, majority = 3.
//   3. The winner's full response (model + content + tool_call) is what chat() returns.

import { EVENTS, makeEvent } from '@asynx6/nexus-event-system';

/** Parse NEXUS_CONSENSUS_MODELS env into a clean string[]. */
export function parseConsensusModels(env) {
  if (!env) return null;
  const list = String(env)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  return Array.from(new Set(list));
}

/**
 * Majority vote across N responses.
 * Returns { winner, agreement, votes, tied } — `tied` true means no strict majority
 * and the caller should retry or pick a deterministic fallback (primary).
 */
export function majorityVote(responses) {
  if (!Array.isArray(responses) || responses.length === 0) {
    return { winner: null, agreement: 0, votes: 0, tied: true };
  }
  const tally = new Map();
  for (const r of responses) {
    const key = voteKey(r);
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const total = responses.length;
  const need = Math.floor(total / 2) + 1; // strict majority
  let bestKey = null;
  let bestCount = 0;
  for (const [k, c] of tally.entries()) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  const tied = bestCount < need;
  const winner = tied ? null : responses.find((r) => voteKey(r) === bestKey);
  return { winner, agreement: bestCount, votes: total, tied };
}

function voteKey(r) {
  // tool-call key: name + serialized args
  if (r?.tool_call?.name) {
    return 'tc:' + r.tool_call.name + ':' + JSON.stringify(r.tool_call.arguments || {});
  }
  // content-verdict key: PASS / FAIL / FAILED / ERROR (case-insensitive)
  const v = extractVerdict(r?.content);
  if (v) return 'verdict:' + v;
  // plain content (sha-ish key by length to avoid huge strings)
  const c = String(r?.content ?? '');
  return 'content:len:' + c.length + ':' + c.slice(0, 64);
}

function extractVerdict(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/\b(PASS|FAIL|FAILED|ERROR)\b/i);
  return m ? m[1].toUpperCase() : null;
}

export class ConsensusProvider {
  #provider; #models; #bus; #subject;

  /**
   * @param {{ provider: {chat: Function}, models: string[],
   *           bus?: {emit: Function}, subject?: string }} opts
   */
  constructor({ provider, models, bus = null, subject = null }) {
    if (!provider?.chat) throw new TypeError('provider with chat() required');
    if (!Array.isArray(models) || models.length === 0) throw new TypeError('models must be a non-empty array');
    this.#provider = provider;
    this.#models = [...models];
    this.#bus = bus;
    this.#subject = subject;
  }

  get mode() {
    return this.#models.length === 1 ? 'single' : 'consensus';
  }

  get models() {
    return [...this.#models];
  }

  #emit(name, data) {
    if (!this.#bus) return;
    try { this.#bus.emit(makeEvent(name, data, this.#subject)); } catch { /* never kill the loop */ }
  }

  /**
   * Chat completion with consensus.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ maxTokens?: number, temperature?: number, tools?: Array }} [opts]
   * @returns {Promise<{ model: string, content: string|null, tool_call: object|null,
   *                     consensus?: { agreement, votes, models, winner } }>}
   */
  async chat(messages, opts = {}) {
    const models = this.#models;

    // Single-model fast path (still emits a verdict event for log consistency).
    if (models.length === 1) {
      const res = await this.#provider.chat(messages, { ...opts, model: models[0] });
      this.#emit(EVENTS.CONSENSUS_VERDICT, {
        mode: 'single', models, winner: res.model, agreement: 1, votes: 1, reason: 'single-model mode',
      });
      return { ...res, consensus: { agreement: 1, votes: 1, models, winner: res.model } };
    }

    // Parallel run across all models for round 1.
    let round = 1;
    let responses = await this.#runAll(models, messages, opts);
    let vote = majorityVote(responses);

    this.#emit(EVENTS.CONSENSUS_ROUND, {
      round, models, votes: responses.map((r) => r?.model), agreement: vote.agreement, tied: vote.tied,
    });

    // Round 2 if tied: re-run only the tied models (or all if first round was unanimous but
    // still inconsistent on content). If only 2 models and tied, accept primary — demo rule.
    if (vote.tied && models.length >= 3) {
      round = 2;
      const tiedKeys = new Set(responses.map((r) => voteKey(r)).filter((k, i, arr) =>
        arr.indexOf(k) === i && responses.filter((r) => voteKey(r) === k).length === Math.max(...Array.from(new Set(arr)).map((k2) => arr.filter((x) => x === k2).length)),
      ));
      const tiedModels = responses.filter((r) => tiedKeys.has(voteKey(r))).map((r) => r.model);
      const runModels = tiedModels.length > 0 ? tiedModels : models;
      responses = await this.#runAll(runModels, messages, opts);
      vote = majorityVote(responses);
      this.#emit(EVENTS.CONSENSUS_ROUND, {
        round, models: runModels, votes: responses.map((r) => r?.model), agreement: vote.agreement, tied: vote.tied,
      });
    }

    // Final: pick primary on tie (deterministic), otherwise the majority winner.
    const finalPick = vote.tied ? await this.#provider.chat(messages, { ...opts, model: models[0] }) : vote.winner;
    this.#emit(EVENTS.CONSENSUS_VERDICT, {
      mode: 'consensus', models, winner: finalPick.model,
      agreement: vote.tied ? 1 : vote.agreement, votes: vote.tied ? 1 : vote.votes,
      reason: vote.tied ? 'tie — primary model fallback' : 'majority agreement',
    });
    return {
      ...finalPick,
      consensus: { agreement: vote.tied ? 1 : vote.agreement, votes: vote.tied ? 1 : vote.votes, models, winner: finalPick.model },
    };
  }

  async #runAll(models, messages, opts) {
    const out = await Promise.allSettled(
      models.map((m) => this.#provider.chat(messages, { ...opts, model: m })),
    );
    const results = [];
    for (let i = 0; i < models.length; i++) {
      const r = out[i];
      if (r.status === 'fulfilled') results.push(r.value);
      // failures are silently skipped in tally; the caller may emit a follow-up if needed
    }
    if (results.length === 0) {
      throw new Error('all consensus models failed');
    }
    return results;
  }
}
