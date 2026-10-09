// Nexus MCP Server — Model Context Protocol implementation
// Zero-dep, JSON-RPC 2.0 over stdio (default) or HTTP.
// Compatible with Claude Code, Cursor, and other MCP-aware clients.
// Usage: node src/cli.js [stdio|http] [--port 9090] [--event-store ./events.jsonl]

import { EventStore } from '@nexus/event-system';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// MCP protocol version
const PROTOCOL_VERSION = '2024-11-05';

/** Read events from JSONL file filtered by subject/seq. Used as fallback when
 * EventStore exposes only minimal append/count API. */
function readEvents(eventStore, fallbackPath, { subject, fromSeq = 0, limit = 100 }) {
  const path = fallbackPath;
  if (!path || !existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const matched = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (subject && evt.subject !== subject) continue;
    if (typeof evt.seq === 'number' && evt.seq < fromSeq) continue;
    matched.push(evt);
    if (matched.length >= limit) break;
  }
  return matched;
}

// Available tools exposed to MCP clients
const TOOLS = [
  {
    name: 'nexus_list_tasks',
    description: 'List recent tasks in the NEXUS runtime',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max tasks to return (default 10)' }
      }
    }
  },
  {
    name: 'nexus_get_task',
    description: 'Get a single task by ID with its events',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to fetch' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'nexus_query_events',
    description: 'Query events from the EventStore by subject',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Event subject (e.g., task-123, sandbox-abc)' },
        fromSeq: { type: 'number', description: 'Start sequence (inclusive)' },
        limit: { type: 'number', description: 'Max events to return' }
      },
      required: ['subject']
    }
  },
  {
    name: 'nexus_run_agent',
    description: 'Run a single agent task synchronously and return the result',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User prompt for the agent' },
        model: { type: 'string', description: 'Model ID to use (default: hermes-agent)' },
        maxTokens: { type: 'number', description: 'Max output tokens' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'nexus_replay',
    description: 'Replay events for a subject from a starting sequence',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        fromSeq: { type: 'number' }
      },
      required: ['subject']
    }
  }
];

/** MCP Server class — handles JSON-RPC 2.0 over stdio or HTTP. */
export class NexusMcpServer {
  /** @param {{eventStorePath?: string, agentRuntime?: object}} [opts] */
  constructor(opts = {}) {
    // Always need a path — default to a temp file so we never pass undefined.
    this.eventStorePath = opts.eventStorePath || join(tmpdir(), `nexus-mcp-${randomUUID().slice(0, 8)}.jsonl`);
    this.eventStore = new EventStore(this.eventStorePath);
    this.runtime = opts.agentRuntime || null; // AgentLoop must be injected with provider
    this.tasks = new Map(); // taskId -> { id, prompt, status, events, result }
  }

  /** Close server resources. */
  close() {
    if (this.eventStore && typeof this.eventStore.close === 'function') {
      this.eventStore.close();
    }
  }

  /** @param {string} jsonRpcMessage */
  handle(jsonRpcMessage) {
    let req;
    try {
      req = JSON.parse(jsonRpcMessage);
    } catch (e) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: ' + e.message }
      });
    }

    if (req.jsonrpc !== '2.0' || !req.method) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    // Dispatch
    let handler;
    if (req.method === 'tools/list') handler = this.method_tools_list;
    else if (req.method === 'tools/call') handler = this.method_tools_call;
    else handler = this[`method_${req.method}`] || this.method_unknown;
    // Wrap sync throws so they become Promise rejections
    const promise = new Promise((resolve, reject) => {
      try {
        resolve(Promise.resolve(handler.call(this, req.params || {})));
      } catch (e) {
        reject(e);
      }
    });
    return promise.then(
      result => JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result
      }),
      err => JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: err.message || String(err) }
      })
    );
  }

  // ─── MCP methods ──────────────────────────────────────────────────

  method_initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false }
      },
      serverInfo: {
        name: 'nexus-mcp',
        version: '0.1.0'
      }
    };
  }

  method_initialized() {
    return {}; // notification, no response body needed
  }

  method_ping() {
    return {};
  }

  method_tools_list() {
    return { tools: TOOLS };
  }

  method_tools_call({ name, arguments: args = {} }) {
    const handler = this[`tool_${name}`];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return Promise.resolve(handler.call(this, args)).then(content => ({
      content: Array.isArray(content) ? content : [{ type: 'text', text: JSON.stringify(content, null, 2) }]
    }));
  }

  // ─── Tool implementations ────────────────────────────────────────

  tool_nexus_list_tasks({ limit = 10 } = {}) {
    const tasks = Array.from(this.tasks.values()).slice(-limit);
    return { tasks };
  }

  tool_nexus_get_task({ taskId }) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  tool_nexus_query_events({ subject, fromSeq = 0, limit = 100 } = {}) {
    const events = readEvents(this.eventStore, this.eventStorePath, { subject, fromSeq, limit });
    return { subject, count: events.length, events };
  }

  tool_nexus_replay({ subject, fromSeq = 0 }) {
    const events = readEvents(this.eventStore, this.eventStorePath, { subject, fromSeq, limit: Infinity });
    return { subject, fromSeq, count: events.length, events };
  }

  tool_nexus_run_agent({ prompt, model = 'hermes-agent', maxTokens = 1024 }) {
    if (!this.runtime) {
      throw new Error('AgentRuntime not configured. Pass agentRuntime to NexusMcpServer.');
    }
    const taskId = `task-${randomUUID().slice(0, 8)}`;
    const task = {
      id: taskId,
      prompt,
      model,
      maxTokens,
      status: 'running',
      events: [],
      result: null,
      createdAt: new Date().toISOString()
    };
    this.tasks.set(taskId, task);

    return this.runtime.run({ prompt, model, maxTokens }).then(result => {
      task.status = result.error ? 'failed' : 'completed';
      task.result = result;
      task.completedAt = new Date().toISOString();
      return task;
    });
  }

  method_unknown(reqOrParams, req) {
    const m = (reqOrParams && reqOrParams.method) || (req && req.method);
    throw new Error(`Method not found: ${m || 'undefined'}`);
  }
}

/** Stdio transport — read JSON-RPC messages from stdin, write responses to stdout. */
export async function runStdio(server) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const response = await server.handle(line);
      process.stdout.write(response + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

/** HTTP transport — JSON-RPC over POST /rpc. */
export function runHttp(server, { port = 9090, host = '127.0.0.1' } = {}) {
  return import('node:http').then(({ createServer }) => {
    const srv = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/rpc') {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', async () => {
          const response = await server.handle(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(response);
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    srv.listen(port, host, () => console.log(`nexus-mcp http://${host}:${port}/rpc`));
  });
}
