// fs tools Fase 4: read offset/limit/binary, edit multi/tolerant/CRLF/BOM, glob/grep/list
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRuntime } from '@asynx6/nexus-sandbox-runtime';
import { fsTools } from '../src/tools/fs.js';
import { globToRegex } from '../src/tools/fs.js';

function makeCtx(root) {
  const runtime = new HostRuntime({ root });
  return { runtime, sandboxId: 'test', hostRoot: root, agentId: 't1' };
}

function tool(name) { return fsTools().find((t) => t.name === name); }

test('fs.read: line numbers, offset/limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    const r = await tool('fs.read').handler({ path: 'a.txt', offset: 2, limit: 3 }, makeCtx(root));
    assert.match(r.content, /^2\ttwo/);
    assert.match(r.content, /4\tfour/);
    assert.equal(r.total_lines, 5);
    assert.ok(!r.content.includes('five'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.read: binary file refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'b.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
    await assert.rejects(
      () => tool('fs.read').handler({ path: 'b.bin' }, makeCtx(root)),
      /binary file/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.edit: multi-edit atomic + diff returned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'm.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const r = await tool('fs.edit').handler({
      path: 'm.js',
      edits: [
        { old_text: 'const a = 1;', new_text: 'const a = 10;' },
        { old_text: 'const c = 3;', new_text: 'const c = 30;' },
      ],
    }, makeCtx(root));
    assert.deepEqual(r.replacements, [1, 1]);
    assert.match(r.diff, /-const a = 1;/);
    assert.match(r.diff, /\+const a = 10;/);
    const after = (await tool('fs.read').handler({ path: 'm.js' }, makeCtx(root))).content;
    assert.ok(after.includes('const a = 10;'));
    assert.ok(after.includes('const c = 30;'));
    assert.ok(after.includes('const b = 2;'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.edit: whitespace-tolerant match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'w.js'), 'function  main( ) {\n  return 1;\n}\n');
    const r = await tool('fs.edit').handler({
      path: 'w.js',
      old_text: 'function main() {',
      new_text: 'function main() { // entry',
    }, makeCtx(root));
    assert.equal(r.replacements[0], 1);
    const after = (await tool('fs.read').handler({ path: 'w.js' }, makeCtx(root))).content;
    assert.ok(after.includes('// entry'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.edit: CRLF preserved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'c.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
    await tool('fs.edit').handler({ path: 'c.txt', old_text: 'beta', new_text: 'BETA' }, makeCtx(root));
    const raw = (await import('node:fs')).readFileSync(join(root, 'c.txt'), 'utf8');
    assert.ok(raw.includes('BETA\r\n'));
    assert.ok(!raw.includes('\r\r'));
    assert.equal((raw.match(/\r\n/g) ?? []).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.edit: BOM untouched by edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'bom.txt'), '\uFEFFhello world\n');
    await tool('fs.edit').handler({ path: 'bom.txt', old_text: 'hello', new_text: 'hi' }, makeCtx(root));
    const raw = (await import('node:fs')).readFileSync(join(root, 'bom.txt'), 'utf8');
    assert.ok(raw.startsWith('\uFEFF'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.edit: ambiguous match reports line numbers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'amb.txt'), 'x\nTOKEN\ny\nTOKEN\nz\n');
    await assert.rejects(
      () => tool('fs.edit').handler({ path: 'amb.txt', old_text: 'TOKEN', new_text: 'T' }, makeCtx(root)),
      /found 2 matches at line\(s\) 2, 4/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.edit: multi-edit is atomic — one bad edit, no partial write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    writeFileSync(join(root, 'atom.js'), 'one\ntwo\n');
    await assert.rejects(
      () => tool('fs.edit').handler({
        path: 'atom.js',
        edits: [
          { old_text: 'one', new_text: 'ONE' },
          { old_text: 'nope', new_text: 'X' },
        ],
      }, makeCtx(root)),
      /edit 2/,
    );
    const after = (await tool('fs.read').handler({ path: 'atom.js' }, makeCtx(root))).content;
    assert.ok(after.includes('one'), 'first edit must not be applied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.glob: ** pattern, gitignore respected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.js'), '1');
    writeFileSync(join(root, 'src', 'b.ts'), '2');
    writeFileSync(join(root, 'secret.env'), '3');
    writeFileSync(join(root, '.gitignore'), 'secret.env\n');
    const r = await tool('fs.glob').handler({ pattern: 'src/**' }, makeCtx(root));
    assert.equal(r.total, 2);
    assert.ok(r.files.includes('src/a.js'));
    assert.ok(!r.files.includes('secret.env'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.grep: pattern + context lines + include filter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib', 'x.js'), 'aaa\nMATCH here\nbbb\n');
    writeFileSync(join(root, 'lib', 'y.py'), 'MATCH py\n');
    const r = await tool('fs.grep').handler({
      pattern: 'MATCH', path: '.', include: '*.js', context: 1,
    }, makeCtx(root));
    assert.equal(r.total, 1);
    assert.ok(r.matches[0].path.endsWith('lib/x.js'));
    assert.equal(r.matches[0].line, 2);
    assert.deepEqual(r.matches[0].context.before, ['aaa']);
    assert.deepEqual(r.matches[0].context.after, ['bbb']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fs.list: entries with types', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-fs-'));
  try {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'f.txt'), 'hello');
    const r = await tool('fs.list').handler({ path: '.' }, makeCtx(root));
    const names = r.entries.map((e) => e.name);
    assert.ok(names.includes('sub'));
    assert.ok(names.includes('f.txt'));
    const sub = r.entries.find((e) => e.name === 'sub');
    assert.equal(sub.type, 'dir');
    const f = r.entries.find((e) => e.name === 'f.txt');
    assert.equal(f.type, 'file');
    assert.equal(f.size, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('globToRegex basics', () => {
  assert.ok(globToRegex('**/*.js').test('a.js'));
  assert.ok(globToRegex('**/*.js').test('src/deep/x.js'));
  assert.ok(!globToRegex('**/*.js').test('a.ts'));
  assert.ok(globToRegex('src/**').test('src/a/b.js'));
  assert.ok(!globToRegex('src/**').test('lib/a.js'));
  assert.ok(globToRegex('a?c').test('abc'));
  assert.ok(!globToRegex('a?c').test('ac'));
});
