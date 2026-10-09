// @asynx6/tool-system audio tools — audio.transcribe via OpenAI-compatible
// Whisper API (audio.transcriptions endpoint). The provider is configurable
// via WHISPER_BASE_URL (default https://api.openai.com/v1) and WHISPER_API_KEY.
// When no key is set, the tool returns a clear error rather than silently
// failing — agents should learn to opt in or surface the gap.
//
// Inputs: either {path} (file on disk) or {buffer, mime} (in-memory bytes).
// Output: {text, language?, duration?}. Errors map to user-friendly messages.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_BYTES = 25 * 1024 * 1024; // Whisper API limit: 25 MiB

function resolveConfig(env = process.env) {
  const base = (env.WHISPER_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = env.WHISPER_API_KEY ?? '';
  return { base, key };
}

async function transcribeOnce({ buffer, filename, mime, config, language, response_format = 'json', fetch: fetchImpl = globalThis.fetch }) {
  if (!config.key) {
    throw new Error('audio.transcribe: WHISPER_API_KEY is not set');
  }
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', response_format);
  if (language) form.append('language', language);
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  const r = await fetchImpl(`${config.base}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${config.key}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`audio.transcribe: ${r.status} ${r.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  if (response_format === 'verbose_json') {
    return await r.json();
  }
  // Whisper's default `json` format returns `{"text": "..."}` — parse it so
  // callers get a usable object instead of a stringified envelope.
  const raw = await r.text();
  try { return JSON.parse(raw); }
  catch { return { text: raw }; }
}

/** Pure factory — the tool registry wraps it; tests call this directly. */
export function makeAudioTools({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = resolveConfig(env);
  return [
    {
      name: 'audio.transcribe',
      description: 'Transcribe an audio file (mp3/m4a/wav/webm, ≤25 MiB) to text via Whisper.',
      permission: 'network.out',
      timeoutMs: 65_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path to the audio file' },
          buffer: { description: 'base64-encoded audio bytes (use if path is unavailable)' },
          mime: { type: 'string', description: 'mime type when passing buffer (e.g. audio/mpeg)' },
          language: { type: 'string', description: 'ISO-639-1 hint (e.g. "id", "en"); optional' },
          response_format: { enum: ['json', 'verbose_json'], default: 'json' },
        },
        oneOf: [
          { required: ['path'] },
          { required: ['buffer', 'mime'] },
        ],
        additionalProperties: false,
      },
      handler: async (args) => {
        // Check key first so missing-config errors surface before fs errors.
        if (!config.key) {
          throw new Error('audio.transcribe: WHISPER_API_KEY is not set');
        }
        let buffer, filename, mime = args.mime;
        if (args.path) {
          const st = statSync(args.path);
          if (st.size > MAX_BYTES) throw new Error(`audio.transcribe: file too large (${st.size} > ${MAX_BYTES})`);
          buffer = readFileSync(args.path);
          filename = basename(args.path);
          if (!mime) {
            const ext = filename.split('.').pop()?.toLowerCase();
            mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' }[ext] ?? 'application/octet-stream';
          }
        } else {
          buffer = Buffer.from(args.buffer, 'base64');
          filename = `clip.${(mime || 'audio/mpeg').split('/')[1] ?? 'mp3'}`;
          if (buffer.length > MAX_BYTES) throw new Error(`audio.transcribe: buffer too large (${buffer.length} > ${MAX_BYTES})`);
        }
        return await transcribeOnce({
          buffer, filename, mime,
          config, language: args.language, response_format: args.response_format ?? 'json',
          fetch: fetchImpl,
        });
      },
    },
  ];
}

export default makeAudioTools;
