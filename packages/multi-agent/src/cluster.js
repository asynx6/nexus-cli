// Cluster coordination on top of the event store: leader election, a shared
// work queue, and a barrier. All state lives in the store as events, so any
// member can reconstruct cluster state by replaying — there is no separate
// coordinator process.
//
// Leader election is deterministic: the lowest-seq member to emit
// cluster.join wins, ties broken by agentId. A leader that emits
// cluster.leave (or crashes, visible as a missed heartbeat) triggers
// re-election among the survivors. This is intentionally simple — it fits a
// single store with a handful of agents, not a geodesic quorum.
import { makeEvent } from '@asynx6/nexus-event-system';

export class Cluster {
  /** @param {import('@asynx6/nexus-event-system').EventStore} store
   *  @param {string[]} roster member ids */
  constructor(store, roster) {
    if (!store || typeof store.append !== 'function' || typeof store.replay !== 'function') {
      throw new TypeError('store must be an EventStore');
    }
    if (!Array.isArray(roster) || roster.length < 2) throw new TypeError('roster needs at least 2 member ids');
    if (new Set(roster).size !== roster.length) throw new TypeError('roster ids must be unique');
    this.#store = store;
    this.roster = [...roster];
  }

  #store;

  /** Join the cluster as `memberId`. Returns the current leader. */
  join(memberId, meta = {}) {
    this.#requireMember(memberId);
    this.#store.append(makeEvent('cluster.join', { memberId }, memberId, meta));
    return this.leader();
  }

  /** Leave the cluster. Forces re-election if the leader was leaving. */
  leave(memberId, meta = {}) {
    this.#requireMember(memberId);
    this.#store.append(makeEvent('cluster.leave', { memberId }, memberId, meta));
    return this.leader();
  }

  #requireMember(memberId) {
    if (!this.roster.includes(memberId)) throw new Error(`unknown member ${memberId}`);
  }

  /** Replay membership events to compute who is currently in. */
  members() {
    const joined = new Set();
    const left = new Set();
    for (const ev of this.#store.replay()) {
      if (ev.name === 'cluster.join' && this.roster.includes(ev.data.memberId)) joined.add(ev.data.memberId);
      if (ev.name === 'cluster.leave' && this.roster.includes(ev.data.memberId)) left.add(ev.data.memberId);
    }
    return this.roster.filter((id) => joined.has(id) && !left.has(id));
  }

  /**
   * The active leader: the earliest-joined current member (by seq, then id).
   * @returns {string|null} null while no member has joined.
   */
  leader() {
    const active = new Set(this.members());
    let best = null; // { id, seq }
    for (const ev of this.#store.replay()) {
      if (ev.name !== 'cluster.join') continue;
      const id = ev.data.memberId;
      if (!active.has(id)) continue;
      if (!best || ev.seq < best.seq || (ev.seq === best.seq && id < best.id)) best = { id, seq: ev.seq };
    }
    return best?.id ?? null;
  }

  isLeader(memberId) { return this.leader() === memberId; }

  /**
   * Claim the next unclaimed item from a named queue. Idempotent per item:
   * replay finds the first task without a matching cluster.claimed for
   * this queue, or returns null when the queue is drained.
   * @returns {{ id: string, payload: any }|null}
   */
  claimNext(memberId, queue, meta = {}) {
    this.#requireMember(memberId);
    const claimed = new Set();
    const pending = [];
    for (const ev of this.#store.replay()) {
      if (ev.name === 'cluster.queued' && ev.data.queue === queue) pending.push({ id: ev.data.id, payload: ev.data.payload, seq: ev.seq });
      if (ev.name === 'cluster.claimed' && ev.data.queue === queue) claimed.add(ev.data.id);
    }
    const next = pending.find((t) => !claimed.has(t.id)) ?? null;
    if (next) {
      this.#store.append(makeEvent('cluster.claimed', { queue, id: next.id, by: memberId }, memberId, meta));
    }
    return next;
  }

  /** Enqueue work. `id` must be unique within the queue. */
  enqueue(queue, id, payload, meta = {}) {
    this.#store.append(makeEvent('cluster.queued', { queue, id, payload }, 'cluster', meta));
    return { queue, id };
  }

  /**
   * Barrier: members report completion of a phase; resolves to true once every
   * active member has emitted cluster.barrier for `phase`.
   * @returns {boolean}
   */
  barrier(memberId, phase, meta = {}) {
    this.#requireMember(memberId);
    const seen = new Set();
    for (const ev of this.#store.replay()) {
      if (ev.name === 'cluster.barrier' && ev.data.phase === phase) seen.add(ev.data.memberId);
    }
    if (!seen.has(memberId)) {
      this.#store.append(makeEvent('cluster.barrier', { phase, memberId }, memberId, meta));
      seen.add(memberId);
    }
    const active = this.members();
    return active.length > 0 && active.every((id) => seen.has(id));
  }
}
