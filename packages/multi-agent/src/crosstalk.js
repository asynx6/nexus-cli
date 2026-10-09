// Cross-agent messaging: send() appends one agent.message copy per recipient,
// stamped with the recipient as subject, so each recipient's inbox is a pure
// subject-filtered replay — no shared mutable state, no read cursors needed.
import { AgentStream } from './stream.js';

export class CrossTalk {
  /** @param {import('@asynx6/nexus-event-system').EventStore} store
   *  @param {string[]} roster valid recipient ids */
  constructor(store, roster) {
    this.#store = store;
    this.roster = [...roster];
    this.#streams = new Map(roster.map((id) => [id, new AgentStream(store, id)]));
  }

  #store;
  #streams;

  stream(agentId) {
    const s = this.#streams.get(agentId);
    if (!s) throw new Error(`unknown agent ${agentId}`);
    return s;
  }

  /** Send a message from `from` to one or many recipients. Returns the
   *  per-recipient stored events (one per recipient, in roster order). */
  send(from, to, text, extra = {}) {
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('text must be a non-empty string');
    const recipients = Array.isArray(to) ? to : [to];
    const out = [];
    for (const r of recipients) {
      if (!this.#streams.has(r)) throw new Error(`unknown recipient ${r}`);
      if (r === from && !extra.allowSelf) continue;
      const e = this.stream(r).append('agent.message', { from, to: r, text, ...extra });
      out.push(e);
    }
    return out;
  }

  /** Deliverable messages for `agentId` in arrival (seq) order. */
  *inbox(agentId) {
    yield* this.stream(agentId).inbox();
  }

  /** Reply helper: same store, opposite direction. */
  reply(event, text) {
    const from = event.data.to;
    const to = event.data.from;
    return this.send(from, to, text, { replyTo: event.id })[0];
  }
}
