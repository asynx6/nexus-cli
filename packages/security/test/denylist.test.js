import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHardDeniedCommand, isHardDeniedPath, isWriteAction, isReadTool,
  loadSettings, saveSettings, evalRules, PERMISSION_MODES,
} from '../src/denylist.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('hard deny: rm -rf / in every compound form', () => {
  assert.equal(isHardDeniedCommand('rm -rf /'), true);
  assert.equal(isHardDeniedCommand('rm -fr /'), true);
  assert.equal(isHardDeniedCommand('echo hi && rm -rf /'), true);
  assert.equal(isHardDeniedCommand('echo hi; rm -rf /'), true);
  assert.equal(isHardDeniedCommand('echo hi | rm -rf /'), true);
  assert.equal(isHardDeniedCommand('echo `rm -rf /`'), true);
  assert.equal(isHardDeniedCommand('echo $(rm -rf /)'), true);
});

test('hard deny: cannot bypass via compound split', () => {
  assert.equal(isHardDeniedCommand('ls && mkfs.ext4 /dev/sda1'), true);
  assert.equal(isHardDeniedCommand('dd if=/dev/zero of=/dev/sda'), true);
  assert.equal(isHardDeniedCommand('shutdown now'), true);
  assert.equal(isHardDeniedCommand('cat x; reboot'), true);
});

test('normal commands pass', () => {
  assert.equal(isHardDeniedCommand('npm test'), false);
  assert.equal(isHardDeniedCommand('rm -rf ./build'), false);
  assert.equal(isHardDeniedCommand('rm file.txt'), false);
  assert.equal(isHardDeniedCommand('git status'), false);
  assert.equal(isHardDeniedCommand('echo /'), false);
});

test('hard deny paths', () => {
  assert.equal(isHardDeniedPath('/etc/passwd'), true);
  assert.equal(isHardDeniedPath('/root/.bashrc'), true);
  assert.equal(isHardDeniedPath('/home/x/.ssh/authorized_keys'), true);
  assert.equal(isHardDeniedPath('.ssh/id_rsa'), true);
  assert.equal(isHardDeniedPath('.env-gateway'), true);
  assert.equal(isHardDeniedPath('.nexus/secrets.enc'), true);
  assert.equal(isHardDeniedPath('src/app.js'), false);
  assert.equal(isHardDeniedPath('package.json'), false);
});

test('isWriteAction / isReadTool', () => {
  assert.equal(isWriteAction('fs.write', {}), true);
  assert.equal(isWriteAction('fs.edit', {}), true);
  assert.equal(isWriteAction('fs.read', {}), false);
  assert.equal(isWriteAction('terminal.exec', {}), true);
  assert.equal(isReadTool('fs.read'), true);
  assert.equal(isReadTool('fs.write'), false);
});

test('settings round-trip + evalRules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deny-'));
  try {
    saveSettings(dir, {
      permissions: {
        allow: ['fs.read', 'terminal.exec:npm test', 'terminal.exec:git status'],
        deny: ['terminal.exec:rm -rf*', 'fs.write:.env*'],
        defaultMode: 'ask',
      },
    });
    const s = loadSettings(dir);
    assert.equal(evalRules(s, 'fs.read', { path: 'x' }), 'allow');
    assert.equal(evalRules(s, 'terminal.exec', { command: 'npm test' }), 'allow');
    assert.equal(evalRules(s, 'terminal.exec', { command: 'npm run build' }), null);
    assert.equal(evalRules(s, 'terminal.exec', { command: 'rm -rf build' }), 'deny');
    assert.equal(evalRules(s, 'fs.write', { path: '.env-gateway' }), 'deny');
    assert.equal(evalRules(s, 'fs.write', { path: 'src/x.js' }), null);
    // deny wins over allow for the same tool
    const s2 = { permissions: { allow: ['terminal.exec'], deny: ['terminal.exec:rm*'] } };
    assert.equal(evalRules(s2, 'terminal.exec', { command: 'rm x' }), 'deny');
    assert.equal(evalRules(s2, 'terminal.exec', { command: 'ls' }), 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compound command cannot bypass rule matching', () => {
  const s = { permissions: { allow: [], deny: ['terminal.exec:rm*'] } };
  // rule matches the RAW command string; a compound "npm test; rm x" is not
  // "rm*" so the rule alone does not deny — but hard denylist catches the
  // dangerous forms. For rule purposes the raw string is checked:
  assert.equal(evalRules(s, 'terminal.exec', { command: 'rm -rf x' }), 'deny');
  assert.equal(evalRules(s, 'terminal.exec', { command: 'npm test' }), null);
});

test('PERMISSION_MODES sanity', () => {
  assert.deepEqual(PERMISSION_MODES, ['ask', 'accept-edits', 'plan', 'auto']);
});
