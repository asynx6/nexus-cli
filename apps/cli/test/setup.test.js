import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSetupArgs, buildEnvFile, runSetup } from '../src/setup.js';

const TMP = join(process.cwd(), '.setup-test-tmp');

test('parseSetupArgs handles --flag=value, --flag, and positional', () => {
  const a = parseSetupArgs(['--base=http://x/v1', '--key', 'pos']);
  assert.strictEqual(a.flags.base, 'http://x/v1');
  assert.strictEqual(a.flags.key, true);
  assert.deepStrictEqual(a.positional, ['pos']);
});

test('buildEnvFile writes the three gateway vars without quotes needed', () => {
  const c = buildEnvFile({ baseUrl: 'http://x/v1', apiKey: 'sekret', models: 'a,b' });
  assert.match(c, /NEXUS_GATEWAY_BASE=http:\/\/x\/v1/);
  assert.match(c, /NEXUS_GATEWAY_KEY=sekret/);
  assert.match(c, /NEXUS_GATEWAY_MODELS=a,b/);
});

test('non-interactive setup writes .env-gateway and exits 0', async () => {
  mkdirSync(TMP, { recursive: true });
  const f = join(TMP, '.env-gateway');
  const lines = [];
  const rc = await runSetup(
    ['--base=http://gw/v1', '--key=abc123', '--model=hermes-agent', '--yes'],
    { stdout: (s) => lines.push(s), cwd: TMP, envPath: f }
  );
  assert.strictEqual(rc, 0);
  const written = readFileSync(f, 'utf8');
  assert.match(written, /NEXUS_GATEWAY_BASE=http:\/\/gw\/v1/);
  assert.match(written, /NEXUS_GATEWAY_KEY=abc123/);
  assert.match(written, /NEXUS_GATEWAY_MODELS=hermes-agent/);
  rmSync(TMP, { recursive: true, force: true });
});

test('non-interactive setup without --key exits 2', async () => {
  mkdirSync(TMP, { recursive: true });
  const errs = [];
  const rc = await runSetup(['--yes'], { stderr: (s) => errs.push(s), cwd: TMP });
  assert.strictEqual(rc, 2);
  assert.ok(errs.join('\n').includes('--key is required'));
  rmSync(TMP, { recursive: true, force: true });
});

test('interactive setup: piped lines (all at once) fill base/key/model', async () => {
  mkdirSync(TMP, { recursive: true });
  const f = join(TMP, '.env-gateway');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  input.end('http://piped/v1\nsk-piped\npiped-model\n');
  const rc = await runSetup([], { stdin: input, stdout: () => {}, stderr: () => {}, cwd: TMP, envPath: f });
  assert.strictEqual(rc, 0);
  const written = readFileSync(f, 'utf8');
  assert.match(written, /NEXUS_GATEWAY_BASE=http:\/\/piped\/v1/);
  assert.match(written, /NEXUS_GATEWAY_KEY=sk-piped/);
  assert.match(written, /NEXUS_GATEWAY_MODELS=piped-model/);
  rmSync(TMP, { recursive: true, force: true });
});

test('interactive setup: blank model line keeps default, EOF without key errors clearly', async () => {
  mkdirSync(TMP, { recursive: true });
  const f = join(TMP, '.env-gateway');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  input.end('http://piped2/v1\nsk-p2\n\n');
  const rc = await runSetup([], { stdin: input, stdout: () => {}, stderr: () => {}, cwd: TMP, envPath: f });
  assert.strictEqual(rc, 0);
  const written = readFileSync(f, 'utf8');
  assert.match(written, /NEXUS_GATEWAY_KEY=sk-p2/);
  assert.match(written, /NEXUS_GATEWAY_MODELS=hermes-agent/);
  rmSync(TMP, { recursive: true, force: true });

  const errs = [];
  const input2 = new PassThrough();
  input2.end('http://piped3/v1\n');
  await runSetup([], { stdin: input2, stdout: () => {}, stderr: (s) => errs.push(s), cwd: TMP, envPath: f });
  assert.ok(errs.join('\n').includes("input ended before 'API key'"));
  rmSync(TMP, { recursive: true, force: true });
});
