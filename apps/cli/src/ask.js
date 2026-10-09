// nexus ask "<question>" — one-shot model Q&A without a project or sandbox.
// Reuses the run context's provider but skips the agent loop: no tools, no
// store writes, no sandbox. The cheapest possible way to query the gateway.
//
// --model overrides the primary model. --raw prints the raw completion JSON.
// Exit 0 on a reply, 1 on a gateway error.
import { ModelProvider } from '@asynx6/nexus-model-providers';
import { DEFAULT_GATEWAY_BASE } from '@asynx6/nexus-shared';

export function parseAskArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      flags[k] = rest.length ? rest.join('=') : true;
    } else positional.push(a);
  }
  return { flags, question: positional.join(' ').trim() };
}

export async function runAsk(argv, env = process.env, stdout = console.log, stderr = console.error) {
  const { flags, question } = parseAskArgs(argv);
  if (!question) { stderr('ask: a question is required (nexus ask "what is 2+2")'); return 2; }

  const baseUrl = (env.NEXUS_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE).replace(/\/+$/, '');
  const apiKey = env.NEXUS_GATEWAY_KEY;
  if (!apiKey) { stderr('ask: NEXUS_GATEWAY_KEY required — run: nexus setup'); return 2; }
  const models = (flags.model ?? env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const provider = new ModelProvider({ baseUrl, apiKey, models, timeoutMs: 60_000 });
  try {
    const res = await provider.chat(
      [{ role: 'user', content: question }],
      { maxTokens: Number(flags['max-tokens'] ?? flags.maxTokens ?? 1024) }
    );
    if (flags.raw) { stdout(JSON.stringify(res, null, 2)); return 0; }
    stdout(res.content ?? '');
    if (res.usage) stderr(`(model: ${res.model}, tokens: ${res.usage.total_tokens ?? '?'})`);
    return 0;
  } catch (e) {
    stderr(`ask: ${e.message || e}`);
    return 1;
  }
}
