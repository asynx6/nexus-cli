// image.describe — send a base64 image to a vision-capable model and return
// a textual description. The tool does NOT itself download URLs (sandbox safety);
// the caller must pass either raw base64 bytes or a sandbox-local file path
// that the tool reads via SandboxRuntime.exec(cat).
//
// Provider contract (in ctx): { chat: async (messages, opts) => response }
//   messages can include image content blocks per OpenAI vision API:
//     { role: 'user', content: [{ type: 'text', text: '...' },
//                                { type: 'image_url', image_url: { url: data:... } }] }
//
// Limits:
//   - raw (base64 in args): ≤ 4 MiB decoded (5.3 MiB base64 with 4/3 overhead)
//   - file path: ≤ 8 MiB file size
//   - jpg/jpeg/png/webp/gif only; mime sniffed from magic bytes
//
// Returns: { description, model, usage?, mime, bytes, source }

import { EVENTS } from '@asynx6/nexus-shared';
import { makeEvent } from '@asynx6/nexus-event-system';

const MAX_RAW_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const MIME_TABLE = {
  ffd8ff: 'image/jpeg',
  '89504e47': 'image/png',
  '47494638': 'image/gif',
  '52494646': 'image/webp', // RIFF...WEBP
};

function sniffMime(buf) {
  const hex = buf.subarray(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '89504e47') return 'image/png';
  if (hex === '47494638') return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function emit(ctx, name, data) {
  if (ctx.bus) ctx.bus.emit(makeEvent(name, data, ctx.agentId ?? null));
}

export function imageTools() {
  return [
    {
      name: 'image.describe',
      description: 'Describe an image using a vision-capable model. Pass either a sandbox-local file path or a base64-encoded blob via the `b64` field. Returns a short caption plus the model used.',
      permission: 'image.describe',
      timeoutMs: 60_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path inside the sandbox (mutually exclusive with b64)' },
          b64: { type: 'string', description: 'base64-encoded image bytes (mutually exclusive with path)' },
          prompt: { type: 'string', description: 'custom prompt; default "Describe this image in 1-2 sentences."' },
          model: { type: 'string', description: 'vision-capable model id; default from env or "hermes-vision"' },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { provider } = ctx;
        if (!provider?.chat) throw new Error('image.describe requires ctx.provider with chat()');
        if (!args.path && !args.b64) throw new Error('either path or b64 required');
        if (args.path && args.b64) throw new Error('pass path OR b64, not both');

        let bytes;
        let source;

        if (args.b64) {
          // validate raw base64
          bytes = Buffer.from(args.b64, 'base64');
          if (bytes.length === 0) throw new Error('b64 decoded to 0 bytes');
          if (bytes.length > MAX_RAW_BYTES) throw new Error(`image too large (${bytes.length} > ${MAX_RAW_BYTES} bytes)`);
          source = 'b64';
        } else {
          // read from sandbox
          const { runtime, sandboxId } = ctx;
          if (!runtime?.exec || !sandboxId) throw new Error('image.describe via path requires sandbox runtime in ctx');
          // safe-path check (no escapes)
          if (!/^\/[a-zA-Z0-9_\-./]+$/.test(args.path)) throw new Error('invalid path');
          const size = await runtime.exec(sandboxId, ['wc', '-c', args.path]);
          const n = parseInt(size.stdout.trim(), 10) || 0;
          if (n > MAX_FILE_BYTES) throw new Error(`file too large (${n} > ${MAX_FILE_BYTES} bytes)`);
          const r = await runtime.exec(sandboxId, ['cat', args.path]);
          if (r.exitCode !== 0) throw new Error(`read failed: ${r.stderr.trim() || r.exitCode}`);
          bytes = Buffer.from(r.stdout, 'binary');
          source = 'path';
        }

        const mime = sniffMime(bytes);
        if (!mime) throw new Error('unsupported image format (need jpeg/png/gif/webp)');

        const prompt = args.prompt ?? 'Describe this image in 1-2 sentences.';
        const model = args.model ?? ctx.env?.NEXUS_VISION_MODEL ?? 'hermes-vision';

        const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        const messages = [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }];

        emit(ctx, 'image.describe.request', { model, source, bytes: bytes.length, mime });
        const res = await provider.chat(messages, { model, maxTokens: 256 });
        emit(ctx, 'image.describe.response', { model: res.model, bytes: bytes.length });

        return {
          description: res.content ?? '',
          model: res.model,
          usage: res.usage ?? null,
          mime,
          bytes: bytes.length,
          source,
        };
      },
    },
  ];
}
