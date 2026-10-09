// terminal background + shell mode
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRuntime } from '@asynx6/nexus-sandbox-runtime';
import { terminalTools, backgroundRegistry } from '../src/tools/terminal.js';

const ctxOf = (root) => ({ runtime: new HostRuntime({ root }), sandboxId: 't', hostRoot: root, agentId: 'a' });
const tool = (n) => terminalTools().find((t) => t.name === n);

test('shell:true runs via sh -c (pipes/redirections work)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-term-'));
  try {
    const r = await tool('terminal.exec').handler({
      command: 'echo one two | tr " " "_" > out.txt && cat out.txt',
      shell: true,
    }, ctxOf(root));
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /one_two/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background: run_in_background + terminal.output + exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-term-'));
  try {
    const ctx = ctxOf(root);
    const start = await tool('terminal.exec').handler({
      command: 'node -e "process.stdout.write(\'bg-start\');setTimeout(()=>process.stdout.write(\' bg-done\'),300)" && echo finish',
      run_in_background: true,
      shell: true,
    }, ctx);
    assert.ok(start.background);
    assert.match(start.bg_id, /^bg-\d+$/);
    // wait for exit
    await new Promise((r) => setTimeout(r, 700));
    const out = await tool('terminal.output').handler({ bg_id: start.bg_id }, ctx);
    assert.equal(out.running, false);
    assert.equal(out.exitCode, 0);
    assert.match(out.new_output, /bg-start bg-done/);
    assert.match(out.new_output, /finish/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background: terminal.output incremental drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-term-'));
  try {
    const ctx = ctxOf(root);
    const start = await tool('terminal.exec').handler({
      command: 'node -e "process.stdout.write(\'part1 \');setTimeout(()=>process.stdout.write(\'part2\'),250)"',
      run_in_background: true,
    }, ctx);
    const first = await tool('terminal.output').handler({ bg_id: start.bg_id, wait: 0.5 }, ctx);
    assert.match(first.new_output, /part1/);
    assert.ok(first.new_output.includes('part2'), '250ms writer done within 500ms wait');
    const second = await tool('terminal.output').handler({ bg_id: start.bg_id, wait: 0.1 }, ctx);
    assert.equal(second.new_output, '', 'drained output must not repeat');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background: terminal.kill stops a long process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-term-'));
  try {
    const ctx = ctxOf(root);
    const start = await tool('terminal.exec').handler({
      command: 'node -e "setInterval(()=>process.stdout.write(\'tick\\n\'),100)"',
      run_in_background: true,
    }, ctx);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(tool('terminal.output') && true, true);
    const out1 = await tool('terminal.output').handler({ bg_id: start.bg_id }, ctx);
    assert.match(out1.new_output, /tick/);
    assert.equal(out1.running, true);
    const k = await tool('terminal.kill').handler({ bg_id: start.bg_id }, ctx);
    assert.equal(k.killed, true);
    await new Promise((r) => setTimeout(r, 200));
    const out2 = await tool('terminal.output').handler({ bg_id: start.bg_id }, ctx);
    assert.equal(out2.running, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown bg_id errors', async () => {
  await assert.rejects(() => tool('terminal.output').handler({ bg_id: 'bg-999' }, ctxOf('/tmp')), /unknown bg_id/);
  await assert.rejects(() => tool('terminal.kill').handler({ bg_id: 'bg-999' }, ctxOf('/tmp')), /unknown bg_id/);
});
