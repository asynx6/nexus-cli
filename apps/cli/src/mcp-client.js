// MCP client (Fase 6e): JSON-RPC 2.0 over stdio or streamable HTTP, config
// in .nexus/mcp.json. Reuses nothing from packages/mcp-server (that's the
// server side); the wire format is shared by protocol version.
// Tools register as mcp.<server>.<tool>, permission default "ask" via the
// policy gate (web.fetch-style always-ask is overkill; ask-mode default +
// the permission manager handle it).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30_000;

/** Load .nexus/mcp.json: { servers: { name: { command, args, env } | { url } } } */
export function loadMcpConfig(dir = process.cwd()) {
  const p = join(dir, '.nexus', 'mcp.json');
  if (!existsSync(p)) return { servers: {} };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return { servers: doc.servers ?? {} };
  } catch { return { servers: {} }; }
}

class JsonRpcError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}

/** stdio transport */
export class StdioTransport {
  constructor({ command, args = [], env = {}, cwd = process.cwd() }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.proc = null;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = '';
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => this.#onData(d));
    this.proc.stderr.on('data', (d) => { this.lastStderr = String(d).slice(-2000); });
    this.dead = new Promise((resolve) => {
      this.proc.on('exit', (code) => resolve(code));
      this.proc.on('error', (e) => { this.lastError = e; resolve(-1); });
    });
  }

  stop() { try { this.proc?.kill(); } catch { /* already gone */ } }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) reject(new JsonRpcError(msg.error.message ?? 'rpc error', msg.error.code, msg.error.data));
          else resolve(msg.result);
        }
        // notifications (no id) are ignored — we don't subscribe to anything
      } catch { /* partial or garbage line */ }
    }
  }

  request(method, params) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

/** streamable HTTP transport */
export class HttpTransport {
  constructor({ url }) { this.url = url; }

  async start() { /* no session for the simple case */ }

  stop() {}

  async request(method, params) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`mcp http ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      let payload = null;
      if (ct.includes('text/event-stream')) {
        // parse the first data: JSON line with an id
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.id !== undefined) { payload = j; break; }
          } catch { /* skip */ }
        }
      } else {
        payload = await res.json();
      }
      if (!payload) throw new Error('mcp http: no response payload');
      if (payload.error) throw new JsonRpcError(payload.error.message ?? 'rpc error', payload.error.code, payload.error.data);
      return payload.result;
    } finally { clearTimeout(timer); }
  }
}

/** One connected MCP server. */
export class McpClient {
  constructor(name, config, { cwd } = {}) {
    this.name = name;
    this.config = config;
    this.transport = config.url ? new HttpTransport(config) : new StdioTransport({ ...config, cwd });
    this.tools = [];
    this.status = 'stopped'; // stopped | starting | ready | dead
    this.lastError = null;
    this.serverInfo = null;
  }

  async connect() {
    this.status = 'starting';
    try {
      await this.transport.start();
      const init = await this.transport.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'nexus-cli', version: '0.6.0' },
      });
      this.serverInfo = init?.serverInfo ?? null;
      // initialized notification (no response expected)
      this.transport.proc?.stdin?.write?.(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      await this.refreshTools();
      this.status = 'ready';
      return true;
    } catch (e) {
      this.status = 'dead';
      this.lastError = e.message;
      return false;
    }
  }

  async refreshTools() {
    const res = await this.transport.request('tools/list', {});
    this.tools = (res?.tools ?? []).map((t) => ({
      name: `mcp.${this.name}.${t.name}`,
      rawName: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object' },
    }));
    return this.tools;
  }

  async callTool(rawName, args) {
    return this.transport.request('tools/call', { name: rawName, arguments: args ?? {} });
  }

  /** Register tools into a ToolRegistry as ask-permission tools. */
  registerInto(registry) {
    for (const t of this.tools) {
      registry.register({
        name: t.name,
        description: `[mcp:${this.name}] ${t.description}`,
        permission: 'mcp.call',
        timeoutMs: 120_000,
        schema: t.inputSchema,
        handler: async (args) => {
          const res = await this.callTool(t.rawName, args);
          return {
            content: (res?.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') || JSON.stringify(res),
            isError: !!res?.isError,
          };
        },
      });
    }
    return this.tools.length;
  }

  async stop() { this.transport.stop(); this.status = 'stopped'; }
}

/** Connect all configured servers. Returns { clients: [McpClient], errors } */
export async function connectAll(config, { cwd } = {}) {
  const clients = [];
  const errors = [];
  for (const [name, cfg] of Object.entries(config.servers ?? {})) {
    const c = new McpClient(name, cfg, { cwd });
    const ok = await c.connect();
    if (ok) clients.push(c);
    else errors.push(`${name}: ${c.lastError}`);
  }
  return { clients, errors };
}
