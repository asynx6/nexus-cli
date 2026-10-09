import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoDiscoverTools, discoverToolFiles, discoverToolPackages } from '../src/auto-discover.js';

function fakeRegistry(existing = []) {
  const tools = new Map(existing.map((n) => [n, { name: n }]));
  return {
    has: (n) => tools.has(n),
    register: (t) => {
      if (tools.has(t.name)) throw new Error('exists');
      tools.set(t.name, t);
    },
    names: () => [...tools.keys()],
  };
}

let dir;
function fresh() { dir = mkdtempSync(join(tmpdir(), 'nexus-autodiscover-')); }

test('discoverToolFiles is empty without .nexus/tools', () => {
  fresh();
  assert.deepEqual(discoverToolFiles(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test('discoverToolFiles finds *.tools.js and *.tools.mjs, skips others', () => {
  fresh();
  mkdirSync(join(dir, '.nexus', 'tools'), { recursive: true });
  const d = join(dir, '.nexus', 'tools');
  writeFileSync(join(d, 'a.tools.js'), '');
  writeFileSync(join(d, 'b.tools.mjs'), '');
  writeFileSync(join(d, 'c.js'), '');
  writeFileSync(join(d, 'README.md'), '');
  const names = discoverToolFiles(dir).map((p) => p.split(/[\\/]/).pop()).sort();
  assert.deepEqual(names, ['a.tools.js', 'b.tools.mjs']);
  rmSync(dir, { recursive: true, force: true });
});

test('discoverToolPackages finds @asynx6/tool-* in dependencies and devDependencies', () => {
  fresh();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@asynx6/tool-weather': '^1.0.0', 'other': '^2.0.0' },
    devDependencies: { '@asynx6/tool-lint': '^0.1.0' },
  }));
  assert.deepEqual(discoverToolPackages(join(dir, 'package.json')).sort(), ['@asynx6/tool-lint', '@asynx6/tool-weather']);
  rmSync(dir, { recursive: true, force: true });
});

test('discoverToolPackages is empty on a missing or broken package.json', () => {
  fresh();
  assert.deepEqual(discoverToolPackages(join(dir, 'package.json')), []);
  writeFileSync(join(dir, 'package.json'), '{ not json');
  assert.deepEqual(discoverToolPackages(join(dir, 'package.json')), []);
  rmSync(dir, { recursive: true, force: true });
});

test('autoDiscoverTools registers tools from a .tools.js file', async () => {
  fresh();
  mkdirSync(join(dir, '.nexus', 'tools'), { recursive: true });
  writeFileSync(join(dir, '.nexus', 'tools', 'wx.tools.js'),
    'export const tools = [{ name: "wx.now", description: "w", handler: async () => {} }];\n');
  const reg = fakeRegistry();
  const res = await autoDiscoverTools(reg, { cwd: dir });
  assert.deepEqual(res.registered, ['wx.now']);
  assert.equal(reg.has('wx.now'), true);
  assert.equal(res.errors.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('autoDiscoverTools skips names already registered (explicit wins)', async () => {
  fresh();
  mkdirSync(join(dir, '.nexus', 'tools'), { recursive: true });
  writeFileSync(join(dir, '.nexus', 'tools', 'dup.tools.js'),
    'export const tools = [{ name: "fs.read", handler: async () => {} }];\n');
  const reg = fakeRegistry(['fs.read']);
  const res = await autoDiscoverTools(reg, { cwd: dir });
  assert.deepEqual(res.registered, []);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].reason, 'already registered');
  rmSync(dir, { recursive: true, force: true });
});

test('autoDiscoverTools accepts tools() function export too', async () => {
  fresh();
  mkdirSync(join(dir, '.nexus', 'tools'), { recursive: true });
  writeFileSync(join(dir, '.nexus', 'tools', 'fn.tools.js'),
    'export function tools() { return [{ name: "fn.run", handler: async () => {} }]; }\n');
  const reg = fakeRegistry();
  const res = await autoDiscoverTools(reg, { cwd: dir });
  assert.deepEqual(res.registered, ['fn.run']);
  rmSync(dir, { recursive: true, force: true });
});

test('autoDiscoverTools reports a file that exports no tools array', async () => {
  fresh();
  mkdirSync(join(dir, '.nexus', 'tools'), { recursive: true });
  writeFileSync(join(dir, '.nexus', 'tools', 'bad.tools.js'), 'export const other = 1;\n');
  const reg = fakeRegistry();
  const res = await autoDiscoverTools(reg, { cwd: dir });
  assert.equal(res.registered.length, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].error, /tools array or tools\(\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('autoDiscoverTools skips a tool without a name', async () => {
  fresh();
  mkdirSync(join(dir, '.nexus', 'tools'), { recursive: true });
  writeFileSync(join(dir, '.nexus', 'tools', 'noname.tools.js'),
    'export const tools = [{ description: "no name" }];\n');
  const reg = fakeRegistry();
  const res = await autoDiscoverTools(reg, { cwd: dir });
  assert.equal(res.registered.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /without a name/);
  rmSync(dir, { recursive: true, force: true });
});

test('autoDiscoverTools never throws on an unreadable directory', async () => {
  fresh();
  // no .nexus/tools at all, plus a package.json referencing a missing package
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@asynx6/tool-missing': '^1.0.0' } }));
  const reg = fakeRegistry();
  const res = await autoDiscoverTools(reg, { cwd: dir });
  assert.equal(res.registered.length, 0);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].source, '@asynx6/tool-missing');
  rmSync(dir, { recursive: true, force: true });
});
