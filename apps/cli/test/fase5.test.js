// Fase 5: project-doc loader + compaction + token counting
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  findProjectDoc, loadProjectDocs, scaffoldProjectDoc,
} from '../src/project-doc.js';
import { contextWindow, countTokens, estimateHistoryTokens, shouldCompact, compactHistory } from '../src/compact.js';

// temp HOME so the global ~/.nexus/NEXUS.md test doesn't touch the real one
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'nx-home-'));
const REAL_HOME = homedir();
process.env.HOME = FAKE_HOME; // used by homedir() on posix

test('findProjectDoc: NEXUS.md > AGENTS.md > CLAUDE.md', () => {
  const d = mkdtempSync(join(tmpdir(), 'nx-pd-'));
  try {
    assert.equal(findProjectDoc(d), null);
    writeFileSync(join(d, 'CLAUDE.md'), 'claude');
    assert.equal(findProjectDoc(d).name, 'CLAUDE.md');
    writeFileSync(join(d, 'AGENTS.md'), 'agents');
    assert.equal(findProjectDoc(d).name, 'AGENTS.md');
    writeFileSync(join(d, 'NEXUS.md'), 'nexus');
    assert.equal(findProjectDoc(d).name, 'NEXUS.md');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('loadProjectDocs: global + root + nested, hierarchical order', () => {
  mkdirSync(join(FAKE_HOME, '.nexus'), { recursive: true });
  writeFileSync(join(FAKE_HOME, '.nexus', 'NEXUS.md'), 'GLOBAL RULE');
  const root = mkdtempSync(join(tmpdir(), 'nx-root-'));
  const sub = join(root, 'packages', 'deep');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(root, 'NEXUS.md'), 'ROOT RULE');
  writeFileSync(join(sub, 'NEXUS.md'), 'DEEP RULE');
  try {
    const docs = loadProjectDocs(root, sub);
    assert.ok(docs.text.includes('GLOBAL RULE'));
    assert.ok(docs.text.indexOf('ROOT RULE') < docs.text.indexOf('DEEP RULE'));
    assert.equal(docs.files.length, 3);
    // from the root itself, no nested
    const docs2 = loadProjectDocs(root, root);
    assert.ok(docs2.text.includes('ROOT RULE'));
    assert.ok(!docs2.text.includes('DEEP RULE'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadProjectDocs: @path imports expand', () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-imp-'));
  try {
    writeFileSync(join(root, 'STYLE.md'), 'style: two-space indent');
    writeFileSync(join(root, 'NEXUS.md'), 'project header\n@STYLE.md\nfooter');
    const docs = loadProjectDocs(root);
    assert.ok(docs.text.includes('style: two-space indent'));
    assert.ok(docs.text.includes('project header'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadProjectDocs: missing import reported, budget truncates', () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-tr-'));
  try {
    writeFileSync(join(root, 'NEXUS.md'), '@NOPE.md\nbody');
    const docs = loadProjectDocs(root);
    assert.ok(docs.text.includes('[missing import: @NOPE.md]'));
    // budget: giant file gets truncated
    writeFileSync(join(root, 'NEXUS.md'), 'x'.repeat(80_000));
    const d2 = loadProjectDocs(root);
    assert.equal(d2.truncated, true);
    assert.ok(d2.text.includes('truncated to fit the budget'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffoldProjectDoc renders structure + symbols', () => {
  const doc = scaffoldProjectDoc({
    files: ['src/app.js', 'lib/util.py', 'readme.md'],
    symbols: { 'src/app.js': [{ name: 'main', kind: 'function', line: 1 }] },
    projectName: 'demo',
  });
  assert.match(doc, /# NEXUS\.md — demo/);
  assert.match(doc, /- `src\/app\.js` — main/);
  assert.match(doc, /## Conventions/);
});

// ---- token counting --------------------------------------------------------
test('countTokens: usage wins, len/4 fallback flagged', () => {
  assert.deepEqual(countTokens({ total_tokens: 42 }, 'whatever'), { tokens: 42, estimated: false });
  const est = countTokens(null, 'a'.repeat(400));
  assert.deepEqual(est, { tokens: 100, estimated: true });
});

test('estimateHistoryTokens + shouldCompact', () => {
  const msgs = [{ role: 'user', content: 'x'.repeat(4000) }];
  assert.equal(estimateHistoryTokens(msgs), 1000);
  const small = shouldCompact(msgs, {});
  assert.equal(small.compact, false);
  const env = { NEXUS_CONTEXT_WINDOW: '1000' }; // 80% = 800 < 1000
  assert.equal(shouldCompact(msgs, env).compact, true);
  assert.equal(contextWindow(env), 1000);
  assert.equal(contextWindow({}), 128000);
});

// ---- compactHistory --------------------------------------------------------
function fakeProvider() {
  return {
    async chat(messages, opts = {}) {
      return { content: `SUMMARY(${messages[0].content.length} chars in, model=${opts.model ?? 'def'})`, usage: null };
    },
  };
}

function bigHistory(n) {
  const out = [{ role: 'system', content: 'SYS' }];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `question ${i} ${'x'.repeat(200)}` });
    out.push({ role: 'assistant', content: `answer ${i}`, tool_calls: i % 3 === 0 ? [{ id: 't' + i, type: 'function', function: { name: 'fs_read', arguments: '{"path":"f"}' } }] : undefined });
    if (i % 3 === 0) out.push({ role: 'tool', tool_call_id: 't' + i, content: 'file content here' });
  }
  return out;
}

test('compactHistory: keeps system + summary + last turns; emits event', async () => {
  const events = [];
  const bus = { emit: (e) => events.push(e) };
  const hist = bigHistory(12); // 12 user turns
  const res = await compactHistory({ messages: hist, provider: fakeProvider(), sessionId: 's1', bus });
  assert.equal(res.compacted, true);
  assert.ok(res.summary.startsWith('SUMMARY('));
  const roles = res.messages.map((m) => m.role);
  assert.equal(roles[0], 'system');
  assert.equal(roles[1], 'user'); // summary message
  assert.match(res.messages[1].content, /compacted/);
  // last 6 user turns kept verbatim
  const userMsgs = res.messages.filter((m) => m.role === 'user');
  assert.ok(userMsgs.some((m) => m.content.includes('question 11')));
  assert.ok(!res.messages.some((m) => m.content.includes('question 1 ')));
  assert.ok(!res.messages.some((m) => m.content.includes('question 2 ')));
  // event emitted, original not passed to bus removal
  assert.equal(events[0].name, 'session.compacted');
  assert.equal(events[0].subject, 's1');
  assert.ok(events[0].data.old_messages > 12, 'old message count (12 turns incl tool msgs)');
});

test('compactHistory: nothing to compact when few turns', async () => {
  const res = await compactHistory({ messages: bigHistory(3), provider: fakeProvider(), sessionId: 's2', bus: null });
  assert.equal(res.compacted, false);
  assert.match(res.reason, /nothing to compact/);
});

test('compactHistory: instructions forwarded', async () => {
  const p = {
    async chat(messages) {
      assert.ok(messages[0].content.includes('keep the DB schema'));
      return { content: 'ok summary' };
    },
  };
  const res = await compactHistory({ messages: bigHistory(10), provider: p, sessionId: 's3', instructions: 'keep the DB schema' });
  assert.equal(res.compacted, true);
});

// restore HOME for other test files in the same process
test('restore HOME', () => {
  process.env.HOME = REAL_HOME;
  rmSync(FAKE_HOME, { recursive: true, force: true });
});
