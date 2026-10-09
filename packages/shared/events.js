// Event taxonomy — plan §11. Every event MUST use one of these names.
// Payload envelope (frozen shape): { id, ts, name, subject, data }
//   id      unique per event (newEventId)
//   ts      ISO-8601 UTC
//   name    one of EVENTS
//   subject primary entity id: agent-… / sandbox-… / task-… (nullable)
//   data    name-specific payload, never secrets (see SECURITY notes)
export const EVENT_SCHEMA_VERSION = 1;

export const EVENTS = Object.freeze({
  AGENT_CREATED: 'agent.created',
  AGENT_STARTED: 'agent.started',
  AGENT_THINKING: 'agent.thinking',
  AGENT_TOOL_CALLED: 'agent.tool_called',
  AGENT_TOOL_FINISHED: 'agent.tool_finished',
  AGENT_FINISHED: 'agent.finished',
  AGENT_FAILED: 'agent.failed',
  SANDBOX_CREATED: 'sandbox.created',
  SANDBOX_STARTED: 'sandbox.started',
  SANDBOX_STOPPED: 'sandbox.stopped',
  SANDBOX_DESTROYED: 'sandbox.destroyed',
  SANDBOX_SNAPSHOTTED: 'sandbox.snapshotted',
  SANDBOX_RESTORED: 'sandbox.restored',
  FILE_CREATED: 'file.created',
  FILE_MODIFIED: 'file.modified',
  FILE_DELETED: 'file.deleted',
  TERMINAL_STARTED: 'terminal.started',
  TERMINAL_FINISHED: 'terminal.finished',
  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  MEMORY_CREATED: 'memory.created',
  ARTIFACT_CREATED: 'artifact.created',
  PERMISSION_DECISION: 'permission.decision',
  PROVIDER_REQUEST: 'provider.request',
  PROVIDER_RESPONSE: 'provider.response',
  CONSENSUS_ROUND: 'consensus.round',     // data: { round, models, votes, agreement }
  CONSENSUS_VERDICT: 'consensus.verdict',  // data: { mode, models, winner, agreement, reason }
  POLICY_DECISION: 'policy.decision',     // data: { allow, reason, ruleIndex, ctx }
  TODO_WRITTEN: 'todo.written',           // data: { todos, counts }
  WEB_FETCHED: 'web.fetched',             // data: { url, status, bytes, contentType }
  REPO_MAPPED: 'repo.mapped',             // data: { path, files, symbols, scanned, cached }
  SESSION_COMPACTED: 'session.compacted', // data: { session, compacted_from, old_messages, kept_messages, summary_chars }
  SESSION_REWOUND: 'session.rewound',     // data: { from, to_seq, branch, restored }
  SUBAGENT_STARTED: 'subagent.started',   // data: { agent, subject, parentSession, task }
  SUBAGENT_FINISHED: 'subagent.finished', // data: { agent, subject, steps, ok }
});
