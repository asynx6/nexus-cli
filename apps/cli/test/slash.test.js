// Slash commands: parse, built-ins, custom .nexus/commands/*.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSlash, loadCustomCommands, resolveSlash, BUILTIN_SLASH } from '../src/slash.js';

test('parseSlash', () => {
  assert.deepEqual(parseSlash('/help'), { cmd: '/help', args: '' });
  assert.deepEqual(parseSlash('/model gpt-x'), { cmd: '/model', args: 'gpt-x' });
  assert.deepEqual(parseSlash('  /resume session-123  '), { cmd: '/resume', args: 'session-123' });
  assert.equal(parseSlash('plain text'), null);
  assert.equal(parseSlash(''), null);
});

test('resolveSlash built-ins', () => {
  assert.deepEqual(resolveSlash('/exit'), { kind: 'builtin', cmd: '/exit', args: '' });
  assert.deepEqual(resolveSlash('/plan'), { kind: 'builtin', cmd: '/plan', args: '' });
  assert.equal(resolveSlash('/nope'), null);
});

test('custom commands from .nexus/commands/*.md with $ARGUMENTS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slash-'));
  try {
    mkdirSync(join(dir, '.nexus', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.nexus', 'commands', 'review.md'), 'Review this code: $ARGUMENTS\nBe thorough.');
    writeFileSync(join(dir, '.nexus', 'commands', 'deploy.md'), 'Deploy now.');
    writeFileSync(join(dir, '.nexus', 'commands', 'ignored.txt'), 'not a command');
    const custom = loadCustomCommands(dir);
    assert.deepEqual(Object.keys(custom).sort(), ['/deploy', '/review']);
    const r = resolveSlash('/review src/app.js', custom);
    assert.equal(r.kind, 'custom');
    assert.equal(r.prompt, 'Review this code: src/app.js\nBe thorough.');
    const r2 = resolveSlash('/deploy', custom);
    assert.equal(r2.prompt, 'Deploy now.');
    // no commands dir -> empty
    assert.deepEqual(loadCustomCommands(join(dir, 'empty')), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUILTIN_SLASH covers the spec list', () => {
  for (const c of ['/help', '/clear', '/model', '/compact', '/plan', '/permissions', '/cost', '/status', '/resume', '/rewind', '/doctor', '/init', '/exit']) {
    assert.ok(BUILTIN_SLASH.includes(c), c);
  }
});
