// P09 e2e gate: one agent, real LLM (gateway), real Docker sandbox, real
// tools — create + run + test a Python Fibonacci program, events recorded,
// replayable. Requires: NEXUS_GATEWAY_* env + docker daemon + pulls
// python:3.12-slim. Skips cleanly when Docker/gateway absent (CI has no
// DinD), so it runs on Leo's box / any Docker host.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// load .env-gateway from repo root if present and env not already set
const here = decodeURIComponent(new URL('.', import.meta.url).pathname);
const root = join(here, '..', '..', '.env-gateway');
if (existsSync(root)) {
  for (const line of readFileSync(root, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && process.env[line.slice(0, i)] === undefined) process.env[line.slice(0, i)] = line.slice(i + 1).trim();
  }
}
// unix-path fix on Windows (import() needs file url for node_modules lookup)
const facades = {};
async function load(name) {
  if (!facades[name]) facades[name] = await import(name);
  return facades[name];
}

let docker = false;
try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', timeout: 15000 }); docker = true; } catch { /* no daemon */ }
const hasGw = !!process.env.NEXUS_GATEWAY_KEY && !!process.env.NEXUS_GATEWAY_BASE;

test('e2e fibonacci agent (docker + gateway required)', {
  skip: !docker ? 'no docker' : !hasGw ? 'no gateway env' : false,
  timeout: 300_000,
}, async () => {
  const { DockerRuntime } = await load('@asynx6/nexus-sandbox-runtime');
  const { ModelProvider } = await load('@asynx6/nexus-model-providers');
  const { AgentLoop, loopTools } = await load('@asynx6/nexus-agent-runtime');
  const { ToolRegistry, ToolExecutor, fsTools, terminalTools } = await load('@asynx6/nexus-tool-system');
  const { PermissionManager, AuditTrail } = await load('@asynx6/nexus-security');
  const { EventBus, EventStore, EVENTS } = await load('@asynx6/nexus-event-system');
  const { newAgentId } = await load('@asynx6/nexus-shared');

  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const bus = new EventBus();
  const store = new EventStore(join(dir, 'events.jsonl'));
  bus.on('*', (e) => store.append(e));

  const agentId = newAgentId();
  const runtime = new DockerRuntime();
  let sandboxId = null;
  try {
    await runtime.ensureImage('python:3.12-slim');
    sandboxId = await runtime.create({ image: 'python:3.12-slim', name: 'nexus-e2e-fib', network: 'none', memoryMb: 256 });
    await runtime.start(sandboxId);

    const reg = new ToolRegistry();
    for (const t of [...fsTools(), ...terminalTools()]) reg.register(t);
    const pm = new PermissionManager();
    pm.grant(agentId, 'fs.read', { paths: ['/workspace/**'] });
    pm.grant(agentId, 'fs.write', { paths: ['/workspace/**'] });
    pm.grant(agentId, 'fs.edit', { paths: ['/workspace/**'] });
    pm.grant(agentId, 'terminal.exec', {});
    const audit = new AuditTrail({ bus, runId: agentId });
    const executor = new ToolExecutor({ registry: reg, permissions: pm, audit });
    const provider = new ModelProvider({
      baseUrl: process.env.NEXUS_GATEWAY_BASE,
      apiKey: process.env.NEXUS_GATEWAY_KEY,
      models: (process.env.NEXUS_GATEWAY_MODELS || 'bai/qwen3.8-flash').split(',').map((s) => s.trim()).filter(Boolean),
      timeoutMs: 90_000,
    });
    const tools = loopTools({ registry: reg, executor });
    const loop = new AgentLoop({ provider, tools, bus });

    const ctxBase = { agentId, runtime, sandboxId, bus };
    const result = await loop.run(
      'Create /workspace/fib.py with function fibonacci(n) iterative (fibonacci(0)=0, fibonacci(1)=1, fibonacci(10)=55). ' +
      'Then create /workspace/test_fib.py that asserts fibonacci(0)==0, fibonacci(1)==1, fibonacci(10)==55 from fib import fibonacci. ' +
      'Run it with terminal.exec command "python" args ["/workspace/test_fib.py"]. ' +
      'Finish by answering exactly: PASS (if exit code 0) or the failing output otherwise.',
      { ...ctxBase, maxSteps: 16,
        system: 'You are a coding agent inside an isolated sandbox. HARD RULES: every file path must be absolute and start with /workspace/ (writes elsewhere are denied and waste steps); create files ONLY with fs.write, run things ONLY with terminal.exec; do not explore, do not read /root, do not probe the environment. Plan in at most: write fib.py, write test_fib.py, run test, answer.' },
    );
    assert.strictEqual(result.done, true, 'agent did not converge, last message: ' + JSON.stringify(result.history.at(-1))?.slice(0, 400));

    // events recorded + replayable
    const events = [...store.replay({ subject: agentId })];
    assert.ok(events.length >= 3, 'expected multiple recorded events');
    const names = events.map((e) => e.name);
    assert.ok(names.includes(EVENTS.AGENT_STARTED));
    assert.ok(names.includes(EVENTS.AGENT_TOOL_CALLED), 'tool call events: ' + names.join(','));
    assert.ok(names.includes(EVENTS.TASK_COMPLETED), 'completion event missing: ' + names.join(','));
    assert.ok(names.includes(EVENTS.TERMINAL_STARTED), 'terminal events missing: ' + names.join(','));
    assert.ok(events.every((e, i) => i === 0 || events[i - 1].seq <= e.seq), 'replay is seq-ordered');

    // ground truth inside the sandbox (independent of the model's claim)
    const gt = await runtime.exec(sandboxId, ['python', '/workspace/test_fib.py'], { timeoutMs: 30_000 });
    assert.strictEqual(gt.exitCode, 0, 'ground-truth test failed: ' + (gt.stderr || gt.stdout).slice(0, 300));
  } finally {
    if (sandboxId) await runtime.stop(sandboxId).catch(() => {});
    if (sandboxId) await runtime.rm(sandboxId).catch(() => {});
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
