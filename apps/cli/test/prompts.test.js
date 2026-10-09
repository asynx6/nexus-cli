// `nexus prompts` (A4) — registry lifecycle + CLI subcommands against a tmp store.
// Covers: seeding, publish/edit versioning, show/diff/rollback, persistence
// (mode 600), name validation, and that `run --prompt=name@hash` resolves
// through the store (a regression that ignored the hash would pin `latest`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompts } from '../src/prompts.js';
import { runNexusCli } from '../src/cli.js';

let out = [];
const stdout = (s) => out.push(String(s));
const stderr = (s) => out.push(String(s));
function reset() { out = []; }

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-prompts-'));
  const env = { NEXUS_PROMPTS_FILE: join(dir, 'prompts.json') };
  return { dir, env };
}

async function run(env, argv, opts = {}) {
  reset();
  const code = await runPrompts(argv, env, stdout, stderr, opts);
  return { code, text: out.join('\n') };
}

/** Publish a body via the store-backed `edit` path without touching $EDITOR. */
async function publish(env, name, body) {
  const editor = (path) => { writeFileSync(path, body); return 0; };
  return run(env, ['edit', name], { editor });
}

/** Active hash short for `name`, as `nexus prompts list` prints it. */
function activeOf(text, name) {
  const line = text.split('\n').find((l) => l.startsWith(name + '\t'));
  if (!line) throw new Error(`list has no row for ${name}: ${text}`);
  return line.split('\t')[1];
}

test('list shows built-in defaults seeded into an empty store', async () => {
  const { env } = project();
  const r = await run(env, ['list']);
  assert.strictEqual(r.code, 0, `unexpected exit: ${r.text}`);
  assert.match(r.text, /cli\.default/);
  assert.match(r.text, /v1/);
});

test('edit publishes a second version and bumps the count', async () => {
  const { env } = project();
  const r1 = await run(env, ['show', 'cli.default']);
  const r2 = await publish(env, 'cli.default', 'You are a NEXUS agent. Be terse. Report only results.');
  assert.strictEqual(r2.code, 0, r2.text);
  assert.match(r2.text, /published cli\.default -> [0-9a-f]{12} \(2 versions\)/);
  const r3 = await run(env, ['show', 'cli.default']);
  assert.notStrictEqual(r3.text, r1.text);
});

test('edit with an unchanged body publishes nothing', async () => {
  const { env } = project();
  const cur = await run(env, ['show', 'cli.default']);
  const editor = (path) => { writeFileSync(path, cur.text); return 0; };
  const r = await run(env, ['edit', 'cli.default'], { editor });
  assert.strictEqual(r.code, 0);
  assert.match(r.text, /no changes/);
});

test('edit refuses an empty body', async () => {
  const { env } = project();
  const editor = (path) => { writeFileSync(path, '   \n\n'); return 0; };
  const r = await run(env, ['edit', 'cli.default'], { editor });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /empty body refused/);
});

test('a non-zero editor exit is reported, nothing published', async () => {
  const { env } = project();
  const editor = () => 2;
  const r = await run(env, ['edit', 'cli.default'], { editor });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /editor exited 2/);
});

test('diff reports added and removed lines between two hashes', async () => {
  const { env } = project();
  await publish(env, 'cli.default', 'Line one.\nLine two.\nLine three.');
  const active = activeOf((await run(env, ['list'])).text, 'cli.default');
  // the pre-edit version is the only other one on disk; find it there rather
  // than guessing a prefix from a possibly-reordered list output.
  const doc = JSON.parse(readFileSync(env.NEXUS_PROMPTS_FILE, 'utf8'));
  const prompt = doc.prompts.find((p) => p.name === 'cli.default');
  const oldVersion = prompt.versions.find((v) => v.body.includes('NEXUS agent working in a real project directory'));
  assert.ok(oldVersion, 'pre-edit version should be persisted');
  const old = oldVersion.hash;
  const r = await run(env, ['diff', 'cli.default', old, active]);
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /\+ Line one\./);
  assert.match(r.text, /\+ Line two\./);
  assert.match(r.text, /- You are a NEXUS agent/);
  assert.match(r.text, /- You are a NEXUS agent/);
});

test('diff of a version against itself reports identical', async () => {
  const { env } = project();
  const h = activeOf((await run(env, ['list'])).text, 'cli.default');
  const r = await run(env, ['diff', 'cli.default', h, h]);
  assert.strictEqual(r.code, 0);
  assert.match(r.text, /identical/);
});

test('rollback re-pins an old version and survives reload', async () => {
  const { env } = project();
  const before = (await run(env, ['show', 'cli.default'])).text;
  const oldActive = activeOf((await run(env, ['list'])).text, 'cli.default');
  await publish(env, 'cli.default', 'Rolled forward body.');
  const r = await run(env, ['rollback', 'cli.default', oldActive]);
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /rolled back/);
  const after = (await run(env, ['show', 'cli.default'])).text;
  assert.strictEqual(after, before);
});

test('store file is mode 600 after a mutation', async () => {
  const { env } = project();
  await publish(env, 'cli.default', 'Secrecy.');
  assert.ok(existsSync(env.NEXUS_PROMPTS_FILE));
  assert.strictEqual(statSync(env.NEXUS_PROMPTS_FILE).mode & 0o777, 0o600);
});

test('show with an unknown name exits 1', async () => {
  const { env } = project();
  const r = await run(env, ['show', 'nope.nope']);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /unknown name\/rev/);
});

test('invalid prompt names are rejected', async () => {
  const { env } = project();
  const editor = (path) => { writeFileSync(path, 'body'); return 0; };
  const r = await run(env, ['edit', 'Bad Name!'], { editor });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /invalid prompt name/);
});

test('unknown subcommand exits 2', async () => {
  const { env } = project();
  const r = await run(env, ['frobnicate']);
  assert.strictEqual(r.code, 2);
  assert.match(r.text, /unknown subcommand/);
});

test('run --prompt=<name>@<hash> pins the exact bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-prompt-run-'));
  const env = { ...process.env, NEXUS_GATEWAY_KEY: 'test-only-key', NEXUS_GATEWAY_BASE: 'http://127.0.0.1:1/v1',
    NEXUS_PROMPTS_FILE: join(dir, 'prompts.json') };
  await publish(env, 'cli.default', 'Pinned body 42.');
  const doc = JSON.parse(readFileSync(env.NEXUS_PROMPTS_FILE, 'utf8'));
  const prompt = doc.prompts.find((p) => p.name === 'cli.default');
  const pinned = prompt.versions.find((v) => v.body === 'Pinned body 42.').hash;
  const prev = process.cwd();
  process.chdir(dir);
  try {
    let err = '';
    // No model key in env -> the run fails, but only AFTER the prompt resolved,
    // so an unresolvable ref still surfaces as its own distinct error.
    const code = await runNexusCli(['run', 'noop', `--prompt=cli.default@${pinned}`], env, () => {}, (s) => { err += s; });
    assert.notStrictEqual(code, 0);
    assert.ok(!/unknown prompt reference/.test(err), `prompt ref should have resolved: ${err}`);
  } finally {
    process.chdir(prev);
  }
});

test('run --prompt=<name>@<bogus> is rejected before the model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-prompt-run-'));
  const env = { ...process.env, NEXUS_GATEWAY_KEY: 'test-only-key', NEXUS_GATEWAY_BASE: 'http://127.0.0.1:1/v1',
    NEXUS_PROMPTS_FILE: join(dir, 'prompts.json') };
  const prev = process.cwd();
  process.chdir(dir);
  try {
    let err = '';
    await assert.rejects(() => runNexusCli(['run', 'noop', '--prompt=cli.default@0000000000000000000000000000000000000000000000000000000000000000'], env, () => {}, (s) => { err += s; }),
      /unknown prompt reference/);
  } finally {
    process.chdir(prev);
  }
});

test('regression: store round-trips every version (not just the active one)', async () => {
  const { env } = project();
  await publish(env, 'cli.default', 'Second body.');
  await publish(env, 'cli.default', 'Third body.');
  const r = await run(env, ['list']);
  assert.match(r.text, /cli\.default\t[0-9a-f]{12}\tv3/);
});

test('regression: rollback survives a reload of the store', async () => {
  const { env } = project();
  const oldActive = activeOf((await run(env, ['list'])).text, 'cli.default');
  await publish(env, 'cli.default', 'Rolled forward.');
  const back = await run(env, ['rollback', 'cli.default', oldActive]);
  assert.strictEqual(back.code, 0, back.text);
  assert.strictEqual((await run(env, ['show', 'cli.default'])).text.includes('NEXUS agent working in a real project directory'), true);
});
