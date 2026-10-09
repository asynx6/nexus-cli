// Integration tests — REQUIRE live Docker (same skip pattern as P03).
// Full stack: real DockerRuntime + PermissionManager + AuditTrail + EventBus,
// exercising the P05 definition of done: write->edit->run python in sandbox,
// and a denied tool rejected with an event reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { ToolRegistry, ToolExecutor, fsTools, terminalTools } from '../index.js';
import { DockerRuntime } from '@asynx6/nexus-sandbox-runtime';
import { EventBus, EventStore } from '@asynx6/nexus-event-system';
import { PermissionManager, AuditTrail } from '@asynx6/nexus-security';
import { newAgentId } from '@asynx6/nexus-shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOCKET = process.env.NEXUS_DOCKER_SOCKET ?? '/var/run/docker.sock';
const hasDocker = fs.existsSync(SOCKET);
const t = hasDocker ? test : test.skip;

let rt, sandboxId, bus, store, pm, audit, executor, dir, agentId;

before(async () => {
  rt = new DockerRuntime({ socketPath: SOCKET });
  await rt.ensureImage('python:3.12-slim');
  sandboxId = await rt.create({ image: 'python:3.12-slim', memoryMb: 256, network: 'none' });
  await rt.start(sandboxId);
  dir = fs.mkdtempSync(join(tmpdir(), 'p05-'));
  store = new EventStore(join(dir, 'events.jsonl'));
  bus = new EventBus();
  bus.on('*', (e) => store.append(e));
  agentId = newAgentId();
  pm = new PermissionManager();
  pm.grant(agentId, 'fs.read', { paths: ['/workspace/**'] });
  pm.grant(agentId, 'fs.write', { paths: ['/workspace/**'] });
  pm.grant(agentId, 'terminal.exec', {});
  audit = new AuditTrail({ bus, runId: agentId });
  const reg = new ToolRegistry();
  for (const tool of [...fsTools(), ...terminalTools()]) reg.register(tool);
  executor = new ToolExecutor({ registry: reg, permissions: pm, audit });
});

after(async () => {
  if (sandboxId) { await rt.stop(sandboxId, 500).catch(() => {}); await rt.rm(sandboxId).catch(() => {}); }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ agentId, sandboxId, runtime: rt, bus });

t('write -> read roundtrip inside sandbox, events on the store', async () => {
  const w = await executor.execute({ tool: 'fs.write', args: { path: '/workspace/hello.txt', content: 'hi nexus\n' } }, ctx());
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.result.created, true);
  const r = await executor.execute({ tool: 'fs.read', args: { path: '/workspace/hello.txt' } }, ctx());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.content, '1\thi nexus'); // Fase 4: numbered lines, trailing newline stripped
  const evs = [...store.replay()];
  const names = evs.map((e) => e.name);
  assert.ok(names.includes('file.created'), `names=${names}`);
  assert.ok(names.includes('agent.tool_called'));
  assert.ok(names.includes('agent.tool_finished'));
});

t('edit: exact single match, then terminal.exec runs the edited script', async () => {
  await executor.execute({ tool: 'fs.write', args: { path: '/workspace/fib.py', content: 'a,b=0,1\nfor _ in range(10):\n    a,b=b,a+b\nprint(a)\n' } }, ctx());
  const e = await executor.execute({ tool: 'fs.edit', args: { path: '/workspace/fib.py', old_text: 'range(10)', new_text: 'range(20)' } }, ctx());
  assert.strictEqual(e.ok, true);
  assert.deepStrictEqual(e.result.replacements, [1]); // Fase 4: per-edit counts
  const amb = await executor.execute({ tool: 'fs.edit', args: { path: '/workspace/fib.py', old_text: 'a', new_text: 'x' } }, ctx());
  assert.strictEqual(amb.ok, false);
  assert.match(amb.reason, /found \d+ matches/);
  const run = await executor.execute({ tool: 'terminal.exec', args: { command: 'python', args: ['/workspace/fib.py'] } }, ctx());
  assert.strictEqual(run.ok, true);
  assert.strictEqual(run.result.stdout.trim(), '6765');
  assert.strictEqual(run.result.exitCode, 0);
});

t('tool without grant -> denied, audit event carries reason', async () => {
  const stranger = newAgentId();
  const out = await executor.execute({ tool: 'fs.read', args: { path: '/workspace/hello.txt' } }, { ...ctx(), agentId: stranger });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'denied');
  const evs = [...store.replay()];
  const pd = evs.filter((e) => e.name === 'security.permission_checked').pop();
  assert.strictEqual(pd.data.allowed, false);
  assert.match(pd.data.reason, /not granted|deny-by-default/);
});

t('path outside allowed roots -> denied even with grant', async () => {
  const out = await executor.execute({ tool: 'fs.read', args: { path: '/etc/passwd' } }, ctx());
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'denied');
  assert.match(out.reason, /outside allowed roots/);
});

t('path traversal attempt -> denied before any sandbox touch', async () => {
  pm.grant(agentId, 'fs.read', { paths: ['/workspace/**', '/etc/**'] }); // matcher sees raw arg
  const out = await executor.execute({ tool: 'fs.read', args: { path: '/workspace/../etc/hostname' } }, ctx());
  // canonical-path rule: raw path hits /workspace/**? no -> denied at permission,
  // and even if a permissive grant matched, safePath rejects non-canonical input.
  assert.strictEqual(out.ok, false);
  assert.match(out.error + out.reason, /denied|outside|canonical|traversal/);
});

t('terminal.exec timeout surfaces as tool timeout error', async () => {
  const out = await executor.execute({ tool: 'terminal.exec', args: { command: 'python', args: ['-c', 'import time; time.sleep(30)'], timeoutMs: 1500 } }, ctx());
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'handler');
  assert.match(out.reason, /timed out/i);
});

t('unknown tool and bad args never reach the sandbox', async () => {
  const u = await executor.execute({ tool: 'fs.nope', args: {} }, ctx());
  assert.strictEqual(u.error, 'validation');
  const b = await executor.execute({ tool: 'fs.write', args: { path: 5 } }, ctx());
  assert.strictEqual(b.error, 'validation');
  assert.match(b.reason, /expected string/);
});
