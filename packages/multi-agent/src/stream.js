// Per-agent event stream over a shared EventStore.
// Every event appended through an AgentStream is stamped subject = agentId,
// so replay(filter.subject) gives each agent an isolated, ordered stream.
// Cross-agent messages use the custom event name 'agent.message' with
// data.to addressing; delivery is per-recipient (each recipient gets its own
// copy appended to ITS stream by the delivering stream, so streams stay
// single-owner and append-only).
import { makeEvent, isEnvelope } from '@asynx6/nexus-event-system';

export class AgentStream {
  /** @param {import('@asynx6/nexus-event-system').EventStore} store shared store
   *  @param {string} agentId owner of this stream (subject on every event) */
  constructor(store, agentId) {
    if (!store || typeof store.append !== 'function') throw new TypeError('store must be an EventStore');
    if (typeof agentId !== 'string' || agentId.length === 0) throw new TypeError('agentId must be a non-empty string');
    this.#store = store;
    this.agentId = agentId;
  }

  #store;

  /** Append an event to this agent's stream. Accepts a name + data (convenience)
   *  or a full envelope (subject is forced to this stream's agentId). */
  append(nameOrEvent, data = {}, meta = {}) {
    const event = isEnvelope(nameOrEvent)
      ? { ...nameOrEvent, subject: this.agentId }
      : makeEvent(nameOrEvent, data, this.agentId, meta);
    return this.#store.append(event);
  }

  /** All events on this agent's stream, in seq order. */
  *events(filter = {}) {
    yield* this.#store.replay({ subject: this.agentId, ...filter });
  }

  /** Inbox: agent.message events addressed to this agent that arrived on any
   *  stream. Cross-talk appends one copy per recipient, each stamped with the
   *  recipient as subject, so the inbox is a plain subject-filtered replay. */
  *inbox() {
    for (const e of this.#store.replay({ subject: this.agentId, name: 'agent.message' })) {
      if (e.data.to === this.agentId) yield e;
    }
  }

  /** Undelivered events count for this agent's stream. */
  count() {
    let n = 0;
    for (const _ of this.#store.replay({ subject: this.agentId })) n++;
    return n;
  }
}
