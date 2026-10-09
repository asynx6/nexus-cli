import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostRuntime, hostPath } from '../src/host.js';

async function mkroot() {
  return mkdtemp(join(tmpdir(), 'host-rt-'));
}

test('hostPath: relative resolves against root', () => {
  const r = hostPath('/proj', 'src/a.js');
  assert.strictEqual(r, resolve('/proj/src/a.js'));
});

test('hostPath: absolute inside root accepted', () => {
  const r = hostPath('/proj', '/proj/x.txt');
  assert.strictEqual(r, '/proj/x.txt');
});

test('hostPath: traversal .. rejected', () => {
  assert.throws(() => hostPath('/proj', '../etc/passwd'), /escapes/);
  assert.throws(() => hostPath('/proj', '/proj/../../etc'), /escapes/);
});

test('hostPath: windows drive path rejected on posix-style roots', () => {
  assert.throws(() => hostPath('/proj', 'C:\\Windows\\system32'), /escapes/);
});

test('exec: echo returns stdout, exit 0', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  await rt.start(id);
  const r = await rt.exec(id, [process.execPath, '-e', 'console.log("hello nexus")']);
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.stdout, /hello nexus/);
  await rm(root, { recursive: true, force: true });
});

test('exec: nonzero exit propagates', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  const r = await rt.exec(id, [process.execPath, '-e', 'process.exit(3)']);
  assert.strictEqual(r.exitCode, 3);
  await rm(root, { recursive: true, force: true });
});

test('exec: cwd locked to root; workdir resolves inside', async () => {
  const root = await mkroot();
  await mkdir(join(root, 'sub'));
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  const r = await rt.exec(id, [process.execPath, '-e', 'console.log(process.cwd())'], { workdir: 'sub' });
  assert.ok(r.stdout.startsWith(resolve(root)));
  await rm(root, { recursive: true, force: true });
});

test('exec: workdir outside root rejected', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  await assert.rejects(rt.exec(id, [process.execPath, '-v'], { workdir: '..' }), /escapes/);
  await rm(root, { recursive: true, force: true });
});

test('exec: timeout kills the process, timedOut=true', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  const t0 = Date.now();
  const r = await rt.exec(id, [process.execPath, '-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 3000, 'must not wait the full 5s');
  await rm(root, { recursive: true, force: true });
});

test('exec: env allowlist — only allowed vars forwarded', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root, allowEnv: [] });
  const id = await rt.create();
  const r = await rt.exec(id, [process.execPath, '-e', 'console.log(typeof process.env.PATH, typeof process.env.NEXUS_TEST_LEAK)'], { env: { NEXUS_TEST_LEAK: 'x' } });
  assert.match(r.stdout, /undefined undefined/);
  await rm(root, { recursive: true, force: true });
});

test('copyIn: writes file, mkdir -p parent, round-trips content', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  await rt.copyIn(id, [{ path: 'deep/dir/a.txt', content: 'hi\n' }]);
  assert.strictEqual(await readFile(join(root, 'deep/dir/a.txt'), 'utf8'), 'hi\n');
  await rm(root, { recursive: true, force: true });
});

test('copyIn: absolute path inside root ok; outside rejected', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  await rt.copyIn(id, [{ path: join(root, 'ok.txt'), content: 'x' }]);
  assert.strictEqual(await readFile(join(root, 'ok.txt'), 'utf8'), 'x');
  await assert.rejects(rt.copyIn(id, [{ path: '/etc/nexus-pwn.txt', content: 'x' }]), /escapes/);
  await rm(root, { recursive: true, force: true });
});

test('copyIn: symlink escape rejected', async () => {
  const root = await mkroot();
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  await mkdir(join(root, 'd'), { recursive: true });
  await symlink(outside, join(root, 'd', 'evil'));
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  await assert.rejects(rt.copyIn(id, [{ path: 'd/evil/pwn.txt', content: 'x' }]), /escapes/);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('exec: unknown binary -> exitCode -1 with error in stderr', async () => {
  const root = await mkroot();
  const rt = new HostRuntime({ root });
  const id = await rt.create();
  const r = await rt.exec(id, ['definitely-not-a-binary-xyz']);
  assert.strictEqual(r.exitCode, -1);
  assert.ok(r.stderr.length > 0);
  await rm(root, { recursive: true, force: true });
});
