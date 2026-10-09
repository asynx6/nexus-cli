// @asynx6/tool-system audio tool tests — pure factory; mock fetch + env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAudioTools } from '../src/tools/audio.js';

function captureFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error('no mock response queued');
    // `body` may be a string (raw) or object (auto-JSON-encoded).
    const isObject = r.body && typeof r.body === 'object';
    const raw = isObject ? JSON.stringify(r.body) : (r.body ?? '');
    const headers = isObject
      ? { 'content-type': 'application/json', ...(r.headers ?? {}) }
      : { 'content-type': 'text/plain', ...(r.headers ?? {}) };
    return new Response(raw, {
      status: r.status ?? 200,
      headers,
    });
  };
  return { fetchImpl, calls };
}

function toolsWith({ env = {}, responses = [] } = {}) {
  const { fetchImpl, calls } = captureFetch(responses);
  const tools = makeAudioTools({ env, fetchImpl });
  return { tools, calls };
}

test('audio.transcribe: missing WHISPER_API_KEY returns clear error', async () => {
  const { tools } = toolsWith({ env: {} });
  await assert.rejects(
    () => tools[0].handler({ path: '/tmp/nope.mp3' }),
    /WHISPER_API_KEY is not set/,
  );
});

test('audio.transcribe: sends multipart POST to /audio/transcriptions', async () => {
  const { tools, calls } = toolsWith({
    env: { WHISPER_API_KEY: 'sk-test', WHISPER_BASE_URL: 'https://w.example/v1' },
    responses: [{ status: 200, body: { text: 'halo dunia' } }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'nexus-audio-'));
  try {
    const path = join(dir, 'halo.mp3');
    writeFileSync(path, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    const out = await tools[0].handler({ path });
    assert.deepEqual(out, { text: 'halo dunia' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://w.example/v1/audio/transcriptions');
    assert.match(calls[0].opts.headers.authorization, /^Bearer sk-test$/);
    const body = calls[0].opts.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.get('model'), 'whisper-1');
    assert.equal(body.get('response_format'), 'json');
    const file = body.get('file');
    assert.ok(file instanceof Blob);
    assert.equal(file.name, 'halo.mp3');
    assert.match(file.type, /mpeg/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audio.transcribe: buffer + mime path uses buffer and custom mime', async () => {
  const { tools, calls } = toolsWith({
    env: { WHISPER_API_KEY: 'sk-test' },
    responses: [{ status: 200, body: { text: 'ok' } }],
  });
  const out = await tools[0].handler({
    buffer: Buffer.from('audiobytes').toString('base64'),
    mime: 'audio/wav',
    language: 'id',
  });
  assert.equal(out.text, 'ok');
  const fd = calls[0].opts.body;
  assert.equal(fd.get('language'), 'id');
  assert.equal(fd.get('file').type, 'audio/wav');
});

test('audio.transcribe: surfaces non-2xx with status + body excerpt', async () => {
  const { tools } = toolsWith({
    env: { WHISPER_API_KEY: 'sk-test' },
    responses: [{ status: 401, body: { error: 'bad key' }, headers: { 'content-type': 'application/json' } }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'nexus-audio-'));
  try {
    const path = join(dir, 'x.mp3');
    writeFileSync(path, Buffer.from([0]));
    await assert.rejects(() => tools[0].handler({ path }), /401/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audio.transcribe: rejects too-large file before hitting network', async () => {
  const { tools, calls } = toolsWith({
    env: { WHISPER_API_KEY: 'sk-test' },
    responses: [{ status: 200, body: { text: 'never' } }],
  });
  // 26 MiB synthetic file
  const dir = mkdtempSync(join(tmpdir(), 'nexus-audio-'));
  try {
    const path = join(dir, 'big.mp3');
    writeFileSync(path, Buffer.alloc(26 * 1024 * 1024));
    await assert.rejects(() => tools[0].handler({ path }), /file too large/);
    assert.equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
