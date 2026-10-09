// Multi-agent handshake: hello → ack per pair, tracked in the store as
// agent.handshake.hello / agent.handshake.ack events on each agent's stream.
// An agent is 'ready' once it has emitted hello AND seen acks from every
// other member of the roster (or from a configured peer set).
import { AgentStream } from './stream.js';

export class Handshake {
  /** @param {import('@asynx6/nexus-event-system').EventStore} store
   *  @param {string[]} roster all participating agent ids */
  constructor(store, roster) {
    if (!Array.isArray(roster) || roster.length < 2) throw new TypeError('roster needs at least 2 agent ids');
    if (new Set(roster).size !== roster.length) throw new TypeError('roster ids must be unique');
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

  /** agentId announces itself; every other member acks onto agentId's stream. */
  hello(agentId, meta = {}) {
    const s = this.stream(agentId);
    s.append('agent.handshake_hello', { roster: this.roster });
    for (const peer of this.roster) {
      if (peer === agentId) continue;
      this.stream(peer).append('agent.handshake_ack', { ackTo: agentId });
    }
    return this.status(agentId);
  }

  /** @returns {{ agentId: string, hello: boolean, acks: string[], ready: boolean }} */
  status(agentId) {
    const s = this.stream(agentId);
    let hello = false;
    const acks = new Set();
    for (const e of s.events()) {
      if (e.name === 'agent.handshake_hello') hello = true;
      if (e.name === 'agent.handshake_ack') acks.add(e.data.ackTo);
    }
    const peers = this.roster.filter((p) => p !== agentId);
    const ready = hello && peers.every((p) => acks.has(p));
    return { agentId, hello, acks: [...acks], ready };
  }

  /** True when every member is ready. */
  allReady() {
    return this.roster.every((id) => this.status(id).ready);
  }
}
