// Fase 6 unit tests: hooks, skills, subagent defs, mcp client, replay export
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
import { createServer } from 'node:http';

// ---- hooks -----------------------------------------------------------------
test('hooks: load from settings, match, block (exit 2), patch, timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-hooks-'));
  try {
    mkdirSync(join(dir, '.nexus'), { recursive: true });
    writeFileSync(join(dir, '.nexus', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ match: 'fs.write', command: `node -e "process.exit(2)"` }],
        PostToolUse: [{ match: 'fs.edit|fs.write', command: `node -e "console.log(JSON.stringify({result:{linted:true}}))"` }],
        Stop: [{ command: `node -e "setTimeout(()=>{},50)"`, timeoutMs: 100 }],
      },
    }));
    const { loadHooks, runHooks } = await import('../src/hooks.js');
    const hooks = loadHooks(dir);
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'Stop']);

    // PreToolUse blocks fs.write
    const b = await runHooks(hooks, 'PreToolUse', { tool: 'fs.write', args: {} }, { cwd: dir });
    assert.equal(b.blocked, true);
    // but not fs.read
    const ok = await runHooks(hooks, 'PreToolUse', { tool: 'fs.read', args: {} }, { cwd: dir });
    assert.equal(ok.blocked, false);

    // PostToolUse patch merges
    const p = await runHooks(hooks, 'PostToolUse', { tool: 'fs.edit', result: {} }, { cwd: dir });
    assert.deepEqual(p.patch, { result: { linted: true } });

    // timeout: hook that sleeps past its cap does not block
    writeFileSync(join(dir, 'slow.js'), 'setTimeout(()=>{},5000)');
    const t = await runHooks({ Stop: [{ command: `node ${join(dir, 'slow.js')}`, timeoutMs: 80 }] }, 'Stop', {}, { cwd: dir });
    assert.equal(t.blocked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hooks: stderr becomes feedback on block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-hooks-'));
  try {
    const { runHooks } = await import('../src/hooks.js');
    const r = await runHooks(
      { PreToolUse: [{ command: `node -e "console.error('path not allowed'); process.exit(2)"` }] },
      'PreToolUse', { tool: 'fs.write' }, { cwd: dir },
    );
    assert.equal(r.blocked, true);
    assert.match(r.feedback, /path not allowed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- skills ------------------------------------------------------------------
test('skills: parse frontmatter, load, index render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-sk-'));
  try {
    mkdirSync(join(dir, '.nexus', 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(dir, '.nexus', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy the app to prod\ndisallowed-tools: fs.write, terminal.exec\n---\n\nDeploy steps here.');
    const { loadSkills, renderSkillIndex, parseSkillMd } = await import('../src/skills.js');
    const skills = loadSkills(dir);
    assert.ok(skills['/deploy']);
    assert.equal(skills['/deploy'].description, 'Deploy the app to prod');
    assert.deepEqual(skills['/deploy'].disallowedTools, ['fs.write', 'terminal.exec']);
    assert.ok(skills['/deploy'].body.includes('Deploy steps'));
    const idx = renderSkillIndex(skills);
    assert.match(idx, /- \/deploy: Deploy the app to prod/);
    // no frontmatter -> skipped
    mkdirSync(join(dir, '.nexus', 'skills', 'bad'), { recursive: true });
    writeFileSync(join(dir, '.nexus', 'skills', 'bad', 'SKILL.md'), 'no frontmatter');
    assert.ok(!loadSkills(dir)['/bad']);
    // parseSkillMd without frontmatter returns raw body
    assert.equal(parseSkillMd('plain').body, 'plain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- subagent defs -----------------------------------------------------------
test('subagent: defaults + custom .nexus/agents override', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-ag-'));
  try {
    const { loadAgents } = await import('../src/subagent.js');
    const base = loadAgents(dir);
    assert.ok(base.explore && base.plan && base.general);
    assert.equal(base.explore.permissionMode, 'plan');
    mkdirSync(join(dir, '.nexus', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.nexus', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Code reviewer\npermissionMode: plan\n---\nReview carefully.');
    const withCustom = loadAgents(dir);
    assert.equal(withCustom.reviewer.permissionMode, 'plan');
    assert.ok(withCustom.reviewer.body.includes('Review'));
    assert.ok(withCustom.explore, 'defaults preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- mcp client --------------------------------------------------------------
test('mcp: stdio JSON-RPC handshake + tools/list + tools/call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-mcp-'));
  try {
    // minimal MCP server over stdio
    writeFileSync(join(dir, 'server.mjs'), `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'test', version: '1' }, capabilities: {} });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: 'echo:' + msg.params.arguments.text }], isError: false });
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
`);
    const { McpClient } = await import('../src/mcp-client.js');
    const c = new McpClient('test', { command: 'node', args: [join(dir, 'server.mjs')] }, { cwd: dir });
    const ok = await c.connect();
    assert.equal(ok, true);
    assert.equal(c.status, 'ready');
    assert.equal(c.tools.length, 1);
    assert.equal(c.tools[0].name, 'mcp.test.echo');
    const res = await c.callTool('echo', { text: 'hi' });
    assert.equal(res.content[0].text, 'echo:hi');
    await c.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mcp: http transport (SSE-style response)', async () => {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      const msg = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'http-ok' }] } })}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { McpClient } = await import('../src/mcp-client.js');
    const c = new McpClient('h', { url: `http://127.0.0.1:${srv.address().port}` });
    // skip initialize (server is a stub); call directly
    const res = await c.transport.request('tools/call', { name: 'x', arguments: {} });
    assert.equal(res.content[0].text, 'http-ok');
  } finally { srv.close(); }
});

test('mcp: dead server reported, not thrown', async () => {
  const { McpClient } = await import('../src/mcp-client.js');
  const c = new McpClient('dead', { command: 'definitely-not-a-real-binary-xyz' });
  const ok = await c.connect();
  assert.equal(ok, false);
  assert.equal(c.status, 'dead');
  assert.ok(c.lastError);
});

// ---- replay export -----------------------------------------------------------
test('replay export: standalone HTML with messages, tools, diff colors', async () => {
  const { exportSessionHtml } = await import('../src/replay-export.js');
  const events = [
    { name: 'session.user_message', ts: '2026-10-09T10:00:00Z', data: { text: 'fix the bug' } },
    { name: 'agent.tool_called', ts: '2026-10-09T10:00:01Z', data: { tool: 'fs.edit', args: { path: 'a.js' } } },
    { name: 'agent.tool_finished', ts: '2026-10-09T10:00:02Z', data: { tool: 'fs.edit', ok: true, duration_ms: 120, result: { diff: '--- a.js\n+++ a.js\n@@ -1 +1 @@\n-old\n+new' } } },
    { name: 'session.assistant_message', ts: '2026-10-09T10:00:03Z', data: { text: 'done', total_tokens: 42 } },
  ];
  const html = exportSessionHtml(events, { title: 'demo session' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('http://') || !html.includes('cdn'), 'no external deps');
  assert.ok(html.includes('fix the bug'));
  assert.ok(html.includes('fs.edit'));
  assert.ok(html.includes('class="d add"'));
  assert.ok(html.includes('42'));
  assert.ok(html.includes('demo session'));
});

// ── MCP client vs REAL nexus-mcp server (stdio) ──────────────────
test('mcp: real stdio server round-trip', async () => {
  const { loadMcpConfig, connectAll } = await import('../src/mcp-client.js');
  const { McpClient } = await import('../src/mcp-client.js');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-real-'));
  mkdirSync(join(dir, '.nexus'), { recursive: true });
  writeFileSync(join(dir, '.nexus', 'events.jsonl'),
    JSON.stringify({ seq: 0, id: 'e1', ts: '2026-10-09T00:00:00Z', name: 'task.started', subject: 'task-t1', data: { task: 'demo', taskId: 'task-t1', agentId: 'a1' } }) + '\n');
  writeFileSync(join(dir, '.nexus', 'mcp.json'), JSON.stringify({
    servers: { local: { command: process.execPath, args: [resolvePath(REPO, 'packages/mcp-server/src/cli.js'), 'stdio', '--event-store', join(dir, '.nexus', 'events.jsonl')] } },
  }));
  const { clients, errors } = await connectAll(loadMcpConfig(dir), { cwd: dir });
  assert.equal(errors.length, 0);
  assert.equal(clients.length, 1);
  const c = clients[0];
  assert.equal(c.status, 'ready');
  assert.equal(c.serverInfo.name, 'nexus-mcp');
  assert.ok(c.tools.some((t) => t.rawName === 'nexus_query_events'));
  const r = await c.callTool('nexus_query_events', { subject: 'task-t1' });
  const text = (r?.content ?? []).map((x) => x.text).join('');
  assert.ok(text.includes('task.started'));
  await c.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('mcp: registry accepts 3-segment mcp.<srv>.<tool> names', async () => {
  const { ToolRegistry } = await import('@nexus/tool-system');
  const reg = new ToolRegistry();
  reg.register({ name: 'mcp.local.echo', description: 'x', schema: { type: 'object' }, handler: async () => ({ ok: 1 }) });
  assert.ok(reg.list().some((t) => t.name === 'mcp.local.echo'));
});
