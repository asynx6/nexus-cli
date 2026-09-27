import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs, runNexusCli } from '../src/cli.js';

test('parseArgs: --flag=value', () => {
  const r = parseArgs(['run', 'write fib', '--max-steps=8', '--model', 'hermes-agent']);
  assert.strictEqual(r.cmd, 'run');
  assert.strictEqual(r.task, 'write fib');
  assert.strictEqual(r.flags['max-steps'], '8');
  assert.strictEqual(r.flags.model, 'hermes-agent');
});

test('parseArgs: bare flag', () => {
  const r = parseArgs(['healthz', '--quiet']);
  assert.strictEqual(r.cmd, 'healthz');
  assert.strictEqual(r.flags.quiet, true);
});

test('runNexusCli: help returns 0', async () => {
  let buf = '';
  const out = (s) => { buf += s + '\n'; };
  const code = await runNexusCli(['help'], {}, out, () => {});
  assert.strictEqual(code, 0);
  assert.match(buf, /Usage:/);
});

test('runNexusCli: bare unknown word is treated as a run task (no crash)', async () => {
  // Per HELP: "if first arg is not a subcommand, treated as nexus run <task>".
  // So a bare word becomes a task; without a gateway key it surfaces a clear
  // NEXUS_GATEWAY_KEY error, never "unknown command".
  let err = '';
  const code = await runNexusCli(['frobnicate'], {}, () => {}, (s) => { err += s; });
  assert.strictEqual(code, 1);
    assert.match(err, /run: NEXUS_GATEWAY_KEY/);
});

test('runNexusCli: run without task returns 2', async () => {
  let err = '';
  const code = await runNexusCli(['run'], {}, () => {}, (s) => { err += s; });
  assert.strictEqual(code, 2);
  assert.match(err, /task text required/);
});

test('runNexusCli: healthz reports base + models without gateway call', async () => {
  let buf = '';
  const env = { NEXUS_GATEWAY_BASE: 'https://api.test/v1', NEXUS_GATEWAY_MODELS: 'm1,m2' };
  const code = await runNexusCli(['healthz'], env, (s) => { buf += s + '\n'; }, () => {});
  // no key configured -> gateway rejects (401/403) or is unreachable; either way non-zero.
  assert.ok(code !== 0, `expected non-zero exit, got ${code}`);
  assert.match(buf, /base: https:\/\/api.test\/v1/);
  assert.match(buf, /models: m1,m2/);
});

test('parseArgs: --follow flag', () => {
  const r = parseArgs(['replay', '--follow', '--interval=500']);
  assert.strictEqual(r.cmd, 'replay');
  assert.strictEqual(r.flags.follow, true);
  assert.strictEqual(r.flags.interval, '500');
});
