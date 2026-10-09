// Cluster supervisor: spawns workers, distributes tasks, recovers on failure.
// Uses @asynx6/multi-agent.Cluster for membership + leader election + queue;
// the supervisor IS the leader that assigns tasks. Workers register their
// availability; when one dies, its claimed tasks go back on the queue.
//
// One supervisor instance per process. The leader process runs the schedule;
// followers idle (a real deployment runs one supervisor per node and lets
// Cluster pick the leader).
import { Cluster } from '@asynx6/nexus-multi-agent';
import { AgentStream } from '@asynx6/nexus-multi-agent';
import { makeEvent } from '@asynx6/nexus-event-system';

export class Supervisor {
  /**
   * @param {object} opts
   *   store      : shared EventStore
   *   roster     : member (worker) ids, eg ['worker-a','worker-b']
   *   agentId    : this process's id (the supervisor's own id; must be in roster)
   *   maxSteps   : default task budget per worker assignment
   */
  constructor({ store, roster, agentId, maxSteps = 16 }) {
    // The supervisor joins the roster at runtime via cluster.join; allow it
    // to be absent initially so bootstrap() can claim membership in order.
    if (!Array.isArray(roster) || roster.length < 1) throw new Error('roster needs at least 1 member');
    // agentId is appended to Cluster's roster; dedupe so a worker that runs a
    // supervisor role (agentId also in roster) does not create a duplicate.
    const members = [...new Set([...roster, agentId])];
    this.cluster = new Cluster(store, members);
    this.store = store;
    this.agentId = agentId;
    this.roster = [...roster];
    this.maxSteps = maxSteps;
    this.#streams = new Map();
  }

  #streams;

  stream(memberId) {
    if (!this.#streams.has(memberId)) this.#streams.set(memberId, new AgentStream(this.store, memberId));
    return this.#streams.get(memberId);
  }

  /** Join as supervisor + tell workers to join. Returns the leader at this moment. */
  bootstrap() {
    this.cluster.join(this.agentId);
    for (const w of this.roster) this.cluster.join(w);
    return this.cluster.leader();
  }

  leader() { return this.cluster.leader(); }
  isLeader() { return this.leader() === this.agentId; }

  /** Enqueue a task for any available worker. Returns {queueId, taskId}. */
  scheduleTask(text, meta = {}) {
    const taskId = makeTaskId();
    this.cluster.enqueue('tasks', taskId, { text, maxSteps: this.maxSteps });
    this.stream(this.agentId).append('cluster.scheduled', { taskId, text });
    return { queueId: 'tasks', taskId };
  }

  /** A worker calls this to pull its next task (null if the queue is drained
   * or the worker has been fenced out by a re-election). */
  nextTask(workerId) {
    if (!this.roster.includes(workerId)) throw new Error(`unknown worker ${workerId}`);
    // If leadership changed, do not hand out work — let the new leader reschedule.
    if (!this.isLeader()) return null;
    const t = this.cluster.claimNext(workerId, 'tasks');
    if (!t) return null;
    const task = /** @type {{ id: string, payload: { text: string, maxSteps: number } }} */ (t);
    return { workerId, taskId: task.id, text: task.payload.text, maxSteps: task.payload.maxSteps };
  }

  /** Worker reports completion (or failure) of a claimed task. */
  completeTask(workerId, taskId, ok, result = {}, meta = {}) {
    const name = ok ? 'cluster.done' : 'cluster.failed';
    this.stream(workerId).append(name, { taskId, result }, meta);
    this.stream(this.agentId).append(name, { workerId, taskId, ok, result }, meta);
  }

  /**
   * Re-enqueue any task claimed by a worker that is no longer in the active
   * member set. Call after a leave/re-election.
   */
  recoverOrphanedTasks() {
    const active = new Set(this.cluster.members());
    const claimed = new Map();
    for (const ev of this.store.replay()) {
      if (ev.name === 'cluster.claimed' && ev.data.queue === 'tasks') {
        claimed.set(ev.data.id, { by: ev.data.by, seq: ev.seq });
      }
    }
    // For simplicity, re-enqueue the unclaimed-by-active-member slice. In a
    // real deployment we would inspect whether the task was completed vs.
    // in-flight; here we trust the completion event is the source of truth.
    let re = 0;
    for (const [id, info] of claimed) {
      if (!active.has(info.by)) {
        const newId = `orphan_${id}_${Date.now()}_${re}`;
        this.cluster.enqueue('tasks', newId, { text: `<orphan ${id}>`, maxSteps: this.maxSteps });
        re++;
      }
    }
    return re;
  }
}

let _n = 0;
function makeTaskId() {
  return `task_${Date.now()}_${++_n}`;
}
