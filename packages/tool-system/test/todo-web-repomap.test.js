// todo.write + web.fetch + repo.map unit/integration tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { todoTools, renderTodos } from '../src/tools/todo.js';
import { webTools } from '../src/tools/web.js';
import { repoMapTools, extractSymbols } from '../src/tools/repo-map.js';

const tool = (list, n) => list.find((t) => t.name === n);

// ---- todo -----------------------------------------------------------------
test('todo.write persists + event emitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-todo-'));
  try {
    const events = [];
    const bus = { emit: (e) => events.push(e) };
    const r = await tool(todoTools({ dir }), 'todo.write').handler({
      todos: [
        { content: 'step one', status: 'done' },
        { content: 'step two', status: 'in_progress' },
        { content: 'step three', status: 'pending' },
      ],
    }, { bus, agentId: 'a1' });
    assert.equal(r.todos, 3);
    const doc = JSON.parse(readFileSync(join(dir, '.nexus', 'todo.json'), 'utf8'));
    assert.equal(doc.todos.length, 3);
    assert.equal(events[0].name, 'todo.written');
    assert.deepEqual(events[0].data.counts, { total: 3, done: 1, in_progress: 1 });
    const back = await tool(todoTools({ dir }), 'todo.read').handler({}, {});
    assert.equal(back.todos[1].content, 'step two');
    assert.deepEqual(renderTodos(back.todos), ['[x] step one', '[~] step two', '[ ] step three']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('todo.write validates items', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-todo-'));
  try {
    await assert.rejects(() => tool(todoTools({ dir }), 'todo.write').handler(
      { todos: [{ content: 'x', status: 'bogus' }] }, {}),
      /status/);
    await assert.rejects(() => tool(todoTools({ dir }), 'todo.write').handler(
      { todos: [{ content: '', status: 'done' }] }, {}),
      /content/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- web.fetch ------------------------------------------------------------
test('web.fetch: GET text, redirects, json', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    if (req.url === '/final') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>hello</h1>'); return; }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const events = [];
  const bus = { emit: (e) => events.push(e) };
  try {
    const r1 = await tool(webTools(), 'web.fetch').handler({ url: `${base}/hop` }, { bus, agentId: 'a1' });
    assert.equal(r1.status, 200);
    assert.ok(r1.url.endsWith('/final'));
    assert.ok(r1.content.includes('hello'));
    const r2 = await tool(webTools(), 'web.fetch').handler({ url: `${base}/json` }, { bus });
    assert.ok(r2.content.includes('"ok"'));
    assert.equal(events[0].name, 'web.fetched');
    await assert.rejects(() => tool(webTools(), 'web.fetch').handler({ url: `${base}/nope` }, { bus }), /404/);
    await assert.rejects(() => tool(webTools(), 'web.fetch').handler({ url: 'ftp://x' }, { bus }), /http\/https/);
    await assert.rejects(() => tool(webTools(), 'web.fetch').handler({ url: 'not a url' }, { bus }), /invalid url/);
  } finally { srv.close(); }
});

// ---- repo.map -------------------------------------------------------------
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'nx-repo-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'export function main() {}\nconst cb = (x) => x;\nclass Foo {}\n');
  writeFileSync(join(root, 'src', 'util.py'), 'def helper():\n    pass\nclass Bar:\n    pass\n');
  writeFileSync(join(root, 'gamemode.pwn'), 'public OnGameModeInit()\n{\n}\nstock LoadConfig()\n{\n}\n#define MAX_PLAYERS 100\nforward TimerTick();\n');
  writeFileSync(join(root, 'lib.rs'), 'pub fn run() {}\nstruct Item;\nenum Mode { A }\n');
  writeFileSync(join(root, 'go.mod'), 'module x\n'); // not source
  return root;
}

test('repo.map: symbols across languages, cache on second run', async () => {
  const root = makeRepo();
  const cacheDir = join(root, '.nexus', 'cache');
  const { HostRuntime } = await import('@nexus/sandbox-runtime');
  const rt = new HostRuntime({ root });
  const ctx = { runtime: rt, sandboxId: 't', hostRoot: root, agentId: 'a1' };
  try {
    const events = [];
    const bus = { emit: (e) => events.push(e) };
    const r = await tool(repoMapTools({ cacheDir }), 'repo.map').handler({}, { ...ctx, bus });
    assert.equal(r.files, 4);
    assert.equal(r.scanned, 4);
    assert.equal(r.cached, 0);
    const js = r.map['src/app.js'];
    assert.ok(js.some((s) => s.name === 'main' && s.kind === 'function'));
    assert.ok(js.some((s) => s.name === 'Foo' && s.kind === 'class'));
    const py = r.map['src/util.py'];
    assert.ok(py.some((s) => s.name === 'helper'));
    const pawn = r.map['gamemode.pwn'];
    assert.ok(pawn.some((s) => s.name === 'OnGameModeInit'));
    assert.ok(pawn.some((s) => s.name === 'LoadConfig'));
    assert.ok(pawn.some((s) => s.name === 'MAX_PLAYERS' && s.kind === 'define'));
    const rs = r.map['lib.rs'];
    assert.ok(rs.some((s) => s.name === 'run'));
    assert.equal(events[0].name, 'repo.mapped');
    assert.ok(existsSync(join(cacheDir, 'repo-map.json')));

    // second run: all cached
    const r2 = await tool(repoMapTools({ cacheDir }), 'repo.map').handler({}, ctx);
    assert.equal(r2.cached, 4);
    assert.equal(r2.scanned, 0);

    // touch a file -> rescan just that one
    writeFileSync(join(root, 'src', 'app.js'), 'export function main() {}\nexport function extra() {}\n');
    // bump mtime explicitly (same-size writes may keep mtime at fs granularity)
    const { utimesSync } = await import('node:fs');
    utimesSync(join(root, 'src', 'app.js'), new Date(), new Date(Date.now() + 2000));
    const r3 = await tool(repoMapTools({ cacheDir }), 'repo.map').handler({}, ctx);
    assert.equal(r3.scanned, 1);
    assert.ok(r3.map['src/app.js'].some((s) => s.name === 'extra'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('extractSymbols: caps per file', () => {
  const src = Array.from({ length: 400 }, (_, i) => `function f${i}() {}`).join('\n');
  const syms = extractSymbols('x.js', src);
  assert.equal(syms.length, 300);
});
