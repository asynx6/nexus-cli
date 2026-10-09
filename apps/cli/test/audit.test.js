// @asynx6/cli audit command — integration tests against runAudit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditChain, verify } from '../../../packages/audit/src/chain.js';
import { runAudit } from '../src/audit.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'nexus-audit-cli-'));
  return { dir: d, path: join(d, 'audit.jsonl') };
}

function capture() {
  const out = [], err = [];
  return {
    stdout: (s) => out.push(String(s)),
    stderr: (s) => err.push(String(s)),
    out, err,
  };
}

test('audit verify: clean log returns 0 with count + head', async () => {
  const { dir, path } = tmp();
  try {
    const c = new AuditChain(path);
    c.append({ kind: 'agent.started', id: 'a1' });
    c.append({ kind: 'tool.called', id: 'a1', tool: 'terminal' });
    c.close();
    const cap = capture();
    const code = await runAudit(['verify', `--file=${path}`], {}, cap.stdout, cap.stderr);
    assert.equal(code, 0);
    assert.match(cap.out.join('\n'), /audit verify ok: count=2 head=[a-f0-9]{64}/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit verify: tampered log returns 1 with index + reason', async () => {
  const { dir, path } = tmp();
  try {
    const c = new AuditChain(path);
    c.append({ a: 1 });
    c.append({ a: 2 });
    c.close();
    // mutate the second line's payload
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const second = JSON.parse(lines[1]);
    second.a = 999;
    const orig = JSON.parse(lines[1]);
    lines[1] = JSON.stringify({ ...second, hash: orig.hash, prev_hash: orig.prev_hash });
    writeFileSync(path, lines.join('\n') + '\n');
    const cap = capture();
    const code = await runAudit(['verify', `--file=${path}`], {}, cap.stdout, cap.stderr);
    assert.equal(code, 1);
    assert.match(cap.err.join('\n'), /audit verify FAILED at index 1: hash mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit verify: missing file returns 2', async () => {
  const cap = capture();
  const code = await runAudit(['verify', '--file=/nope/never.jsonl'], {}, cap.stdout, cap.stderr);
  assert.equal(code, 2);
  assert.match(cap.err.join('\n'), /file not found/);
});

test('audit verify: unknown subcommand returns 2', async () => {
  const cap = capture();
  const code = await runAudit(['wat'], {}, cap.stdout, cap.stderr);
  assert.equal(code, 2);
  assert.match(cap.err.join('\n'), /only `audit verify` is supported/);
});
