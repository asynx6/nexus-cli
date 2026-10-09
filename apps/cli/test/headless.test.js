// Headless mode: -p task, output formats, stdin, exit codes, allowed-tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runHeadless } from '../src/headless.js';

function fakeGateway(script) {
  // script: array of { content } or { tool_calls: [{name, arguments}] }
  let turn = 0;
  const bodies = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      const step = script[Math.min(turn, script.length - 1)];
      turn++;
      const msg = step.tool_calls
        ? { content: null, tool_calls: step.tool_calls.map((tc, i) => ({ id: 'c' + i, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }
        : { content: step.content };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 7 }, id: 'x' }));
    });
  });
  return { srv, bodies };
}

function fakeStdin(data) {
  const s = new PassThrough();
  if (data) { s.write(data); }
  s.end();
  s.isTTY = false;
  return s;
}

async function run(script, { task = 'do it', flags = {}, stdinData = '' } = {}) {
  const { srv, bodies } = fakeGateway(script);
  await new Promise((r) => srv.listen(18920, '127.0.0.1', r));
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-headless-'));
  const prev = process.cwd();
  process.chdir(cwd);
  let out = '', err = '';
  const code = await runHeadless({
    task, flags, stdin: fakeStdin(stdinData),
    env: { NEXUS_GATEWAY_BASE: 'http://127.0.0.1:18920/v1', NEXUS_GATEWAY_KEY: 'k', NEXUS_GATEWAY_MODELS: 'fake-model' },
    stdout: { write: (s) => out += s, isTTY: false },
    stderr: { write: (s) => err += s, isTTY: false },
  });
  process.chdir(prev);
  const events = existsSync(join(cwd, '.nexus/store/events.jsonl'))
    ? readFileSync(join(cwd, '.nexus/store/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).name)
    : [];
  rmSync(cwd, { recursive: true, force: true });
  srv.close();
  return { code, out, err, bodies, events };
}

test('text format: answer printed, exit 0', async () => {
  const r = await run([{ content: 'the answer' }]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'the answer');
  assert.ok(r.events.includes('task.completed'));
  assert.ok(r.events.includes('session.assistant_message'));
});

test('json format: structured output', async () => {
  const r = await run([{ content: 'ans' }], { flags: { 'output-format': 'json' } });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out.trim());
  assert.equal(j.answer, 'ans');
  assert.equal(j.steps, 1);
  assert.match(j.session, /^session-/);
});

test('stream-json format: JSONL events', async () => {
  const r = await run([{ content: 'streamed' }], { flags: { 'output-format': 'stream-json' } });
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.type === 'text_delta'));
  assert.ok(lines.length >= 1);
});

test('stdin piped into the task', async () => {
  const r = await run([{ content: 'ok' }], { stdinData: 'LOG LINE 1\nLOG LINE 2' });
  assert.equal(r.code, 0);
  const sent = r.bodies[0].messages.find((m) => m.role === 'user').content;
  assert.match(sent, /--- stdin ---/);
  assert.match(sent, /LOG LINE 1/);
});

test('max steps -> exit 3', async () => {
  // model keeps calling a tool forever
  const r = await run([{ tool_calls: [{ name: 'fs_read', arguments: { path: 'x' } }] }], { flags: { 'max-turns': 2 } });
  assert.equal(r.code, 3);
  assert.match(r.err, /stopped at/);
});

test('usage error -> exit 2', async () => {
  const r = await run([{ content: 'x' }], { task: '', flags: {} });
  assert.equal(r.code, 2);
});

test('bad output-format -> exit 2', async () => {
  const r = await run([{ content: 'x' }], { flags: { 'output-format': 'yaml' } });
  assert.equal(r.code, 2);
});

test('auto mode without --dangerously-auto -> exit 2', async () => {
  const r = await run([{ content: 'x' }], { flags: { 'permission-mode': 'auto' } });
  assert.equal(r.code, 2);
});

test('allowed-tools filters the tool list sent to the model', async () => {
  const r = await run([{ content: 'ok' }], { flags: { 'allowed-tools': 'fs.read' } });
  assert.equal(r.code, 0);
  const tools = r.bodies[0].tools ?? [];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, 'fs_read');
});

test('tool call round-trip: file actually written (accept-edits default)', async () => {
  const { srv } = fakeGateway([
    { tool_calls: [{ name: 'fs_write', arguments: { path: 'made.txt', content: 'hi' } }] },
    { content: 'written' },
  ]);
  await new Promise((r) => srv.listen(18921, '127.0.0.1', r));
  const cwd = mkdtempSync(join(tmpdir(), 'nexus-headless2-'));
  const prev = process.cwd();
  process.chdir(cwd);
  const code = await runHeadless({
    task: 'write', flags: {},
    stdin: fakeStdin(''),
    env: { NEXUS_GATEWAY_BASE: 'http://127.0.0.1:18921/v1', NEXUS_GATEWAY_KEY: 'k', NEXUS_GATEWAY_MODELS: 'fake-model' },
    stdout: { write: () => {}, isTTY: false },
    stderr: { write: () => {}, isTTY: false },
  });
  const wrote = existsSync(join(cwd, 'made.txt'));
  const content = wrote ? readFileSync(join(cwd, 'made.txt'), 'utf8') : '';
  process.chdir(prev);
  rmSync(cwd, { recursive: true, force: true });
  srv.close();
  assert.equal(code, 0);
  assert.equal(wrote, true);
  assert.equal(content, 'hi');
});
