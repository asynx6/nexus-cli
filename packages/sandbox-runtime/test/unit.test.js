// Unit tests (no Docker required): stream demux, tar writer, socket client basics.
import { test } from 'node:test';
import assert from 'node:assert';
import { demuxExecStream } from '../lib/sockhttp.js';
import { dechunk } from '../lib/sockhttp.js';
import { tarCreate } from '../lib/tar.js';
import { NAME } from '../index.js';

test('facade exports', () => {
  assert.strictEqual(NAME, '@asynx6/nexus-sandbox-runtime');
});

function frame(type, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf[0] = type;
  buf.writeUInt32BE(payload.length, 4);
  payload.copy(buf, 8);
  return buf;
}

test('demuxExecStream separates stdout/stderr frames', () => {
  const s = Buffer.concat([
    frame(1, Buffer.from('hello ')),
    frame(2, Buffer.from('bad ')),
    frame(1, Buffer.from('world')),
    frame(2, Buffer.from('input')),
  ]);
  const r = demuxExecStream(s);
  assert.strictEqual(r.stdout, 'hello world');
  assert.strictEqual(r.stderr, 'bad input');
});

test('demuxExecStream handles empty buffer', () => {
  const r = demuxExecStream(Buffer.alloc(0));
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

test('dechunk reassembles chunked body', () => {
  const raw = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
  assert.strictEqual(dechunk(raw).toString(), 'hello world');
});

test('tarCreate produces valid ustar header', () => {
  const tar = tarCreate([{ name: 'app.py', content: 'print(1)\n' }]);
  assert.strictEqual(tar.length % 512, 0);
  assert.strictEqual(tar.subarray(0, 6).toString(), 'app.py');
  const ustar = tar.subarray(257, 263).toString('latin1').replace(/\0.*/, '');
  assert.strictEqual(ustar, 'ustar');
  const size = parseInt(tar.subarray(124, 136).toString('latin1').trim(), 8);
  assert.strictEqual(size, 9);
  // checksum validates
  const stored = parseInt(tar.subarray(148, 154).toString('latin1').trim(), 8);
  const blk = Buffer.from(tar.subarray(0, 512));
  blk.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of blk) sum += b;
  assert.strictEqual(sum, stored);
});
