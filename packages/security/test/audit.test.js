import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, EventStore } from '@asynx6/nexus-event-system';
import { PermissionManager, AuditTrail, redact } from '../index.js';

test('every decision emits a security.permission_checked event, stored in seq order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-audit-'));
  let store;
  try {
    const bus = new EventBus();
    store = new EventStore(join(dir, 'run.jsonl'));
    bus.on('*', (e) => store.append(e));

    const pm = new PermissionManager();
    const audit = new AuditTrail({ bus, runId: 'run-1' });
    pm.grant('agent-1', 'fs.write', { paths: ['/workspace/**'] });
    audit.logDecision(pm.check('agent-1', 'fs.write', { path: '/workspace/ok.txt' }));
    audit.logDecision(pm.check('agent-1', 'fs.write', { path: '/etc/shadow' }));
    audit.logDecision(pm.check('agent-2', 'terminal.exec', { command: 'id' }));

    const events = [...store.replay({ subject: 'run-1' })];
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(events.map((e) => e.seq), [0, 1, 2]);
    assert.deepStrictEqual(events.map((e) => e.data.allowed), [true, false, false]);
    assert.match(events[1].data.reason, /\/etc\/shadow/);
    assert.strictEqual(events[2].data.reason, 'no grants for agent (deny-by-default)');
  } finally {
    store.close(); // Windows: sqlite keeps .idx locked until closed
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redact masks secret-ish keys and values, keeps shape', () => {
  const r = redact({
    path: '/workspace/.env',
    api_key: 'sk-live-123',
    nested: { Authorization: 'Bearer x', token: 'abc', safe: 'ok' },
    list: [{ password: 'p' }, 'plain'],
  });
  assert.strictEqual(r.path, '/workspace/.env');
  assert.strictEqual(r.api_key, '[redacted]');
  assert.strictEqual(r.nested.Authorization, '[redacted]');
  assert.strictEqual(r.nested.token, '[redacted]');
  assert.strictEqual(r.nested.safe, 'ok');
  assert.strictEqual(r.list[0].password, '[redacted]');
  assert.strictEqual(r.list[1], 'plain');
});

test('audit args are redacted before hitting the bus', () => {
  const bus = new EventBus();
  const audit = new AuditTrail({ bus, runId: 'r' });
  let seen = null;
  bus.on('security.permission_checked', (e) => { seen = e; });
  audit.logDecision({
    allowed: false, reason: 'x', agentId: 'a', tool: 'net.fetch',
    args: { url: 'https://x', bearer_token: 'LEAK' },
  });
  assert.ok(seen);
  assert.strictEqual(seen.data.args.bearer_token, '[redacted]');
  assert.strictEqual(seen.data.args.url, 'https://x');
});
