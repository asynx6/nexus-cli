# NEXUS

An open-source AI Agent Operating Environment. Agents run tasks in isolated sandboxes, write code, execute terminal commands, fix their own errors, and persist every step as a replayable event log.

Zero external runtime dependencies. Runs on Node 22 with `node:sqlite` and any OpenAI-compatible chat-completions endpoint as the model backend.

## What it gives an agent

- **Isolated sandbox** — filesystem and terminal access inside a Docker container, deny-by-default network and resource limits.
- **Gated tools** — filesystem, terminal, image/audio/upload tools routed through a permission manager with a full audit trail.
- **Append-only event log** — every tool call, decision, and result is an event with a sequence number, timestamp, subject, and structured data. Replayable from any point.
- **Memory** — short-term, long-term, and project scopes, with pluggable storage and an event-stream recall index.
- **Pluggable models** — any OpenAI-compatible endpoint, with model fallback and multi-model consensus.
- **Multi-agent supervision** — leader election, a shared work queue, and task recovery across a cluster.

## Why event-sourcing

Most agent stacks wrap a chat loop. NEXUS is built around the audit trail. Because every action is an event you get, for free:

- **Replay** any run from any point — reproduce or diagnose a failure.
- **Diff** two runs event-by-event to see exactly why they diverged.
- **Audit** which agent touched which file under which grant.
- **Share** an event stream across agents without coupling their runtimes.

## Install

Requirements:

- Node **≥ 22** (for `node:sqlite` and the built-in test runner)
- Docker (only for sandbox isolation; the CLI, dashboard, and unit suites run without it)
- An OpenAI-compatible chat-completions endpoint

```sh
npm install -g @asynx6/nexus-cli
nexus --version
```

Or run from source:

```sh
git clone https://github.com/asynx6/nexus-cli
cd nexus-cli
npm install
node apps/cli/bin.mjs --version
```

## Configure

`nexus setup` opens an interactive wizard that writes `.env-gateway` (gitignored); or set the variables directly:

```
NEXUS_GATEWAY_BASE=https://api.asynx6.tech/v1   # any OpenAI-compatible base URL
NEXUS_GATEWAY_KEY=sk-...                        # your API key
NEXUS_GATEWAY_MODELS=hermes-agent,im/auto       # comma-separated fallback chain
```

The provider tries each model in order on 401/404/timeout — put your cheapest reliable model first.

## Usage

```sh
nexus run "write a fibonacci function in fib.py"   # run an agent on a task
nexus replay                                       # tail the event store live
nexus replay --port 9090                           # browser dashboard + /live /ready probes
nexus replay diff <left> <right>                   # compare two runs event-by-event
nexus ask "what is the capital of France?"         # one-shot Q&A, no sandbox
nexus doctor                                       # environment health check
nexus doctor --fix                                 # auto-repair common setup issues
nexus healthz                                      # verify the gateway is reachable
nexus setup                                        # interactive gateway wizard
nexus --help                                       # all commands
```

`nexus run` creates a sandbox, mounts the working directory at `/workspace`, grants the agent read/write/edit there plus terminal access, and streams every step to the event store.

### Versioned system prompts

Prompts are named and versioned by content hash, so a recorded run can be replayed against the exact instruction bytes it used.

```sh
nexus prompts list                                  # names + active version + counts
nexus prompts show cli.default --rev=<hash>         # body of one version
nexus prompts diff cli.default <left> <right>       # added/removed lines
nexus prompts rollback cli.default <hash>           # re-pin an older version
nexus prompts edit cli.default                      # open $EDITOR, publish on save

nexus run "write fib" --prompt=cli.default          # latest
nexus run "write fib" --prompt=cli.default@<hash>   # exact version
```

### Project secrets

Per-project secrets live in an encrypted vault at `.nexus/secrets.enc`, not in `.env` or the repo. AES-256-GCM with a per-project scrypt-derived key over your passphrase — a stolen vault file is worthless without it. Values surface in the agent's exec environment only; never in logs, events, or disk.

```sh
nexus secrets init                                   # create the vault (asks a passphrase)
export NEXUS_PROJECT_PASSPHRASE=...                  # or set it per run
nexus secrets set OPENAI_API_KEY                     # value prompted, not echoed
nexus secrets list                                   # names only
nexus secrets grant agent-1 OPENAI_API_KEY           # allow an agent to read it
nexus secrets revoke agent-1 OPENAI_API_KEY
```

### Webhooks

Subscribe any HTTP endpoint to the event stream. Deliveries are HMAC-SHA256 signed in the `X-NEXUS-Signature` header (`sha256=<hex>`), with exponential-backoff retries that stop on permanent errors (4xx) and keep going on transient ones (5xx, 429, network).

```sh
export NEXUS_API_BASE=http://localhost:4000
export NEXUS_API_TOKEN=...

nexus webhooks add https://your-service/hooks/nexus --events=task.completed --secret=wh-secret
nexus webhooks list
nexus webhooks test hook-<id>
nexus webhooks pause hook-<id>
```

### Plugins & tools

Drop a `*.tools.js` file in `.nexus/tools/` (or install a `@nexus/tool-*` package) and its tools are auto-discovered on the next run:

```js
// .nexus/tools/weather.tools.js
export const tools = [{ name: "wx.now", description: "current weather", handler: async () => ({}), }];
```

```sh
nexus plugins --dir=.nexus/tools   # list what was discovered
```

### Telemetry

Off by default. `nexus telemetry on` records only counts and timings (tool names, model ids, durations) — never prompts, file paths, env values, or tokens. `NEXUS_TELEMETRY=0` is a hard off.

## Architecture

```
nexus/
├── packages/
│   ├── shared/           # event contracts, id gen, env loader, logger
│   ├── event-system/     # EventBus + JSONL store + sqlite index + replay/diff
│   ├── sandbox-runtime/  # Docker engine API over raw socket, resource limits
│   ├── security/         # PermissionManager + AuditTrail + secrets vault
│   ├── tool-system/      # ToolRegistry + executor + built-in tools + auto-discovery
│   ├── model-providers/  # OpenAI-compatible client, fallback + rate limiting
│   ├── agent-runtime/    # agent loop, tool bridge
│   ├── consensus/        # multi-model voting
│   ├── multi-agent/      # streams, handshake, crosstalk, cluster supervisor
│   ├── memory/           # pluggable memory + event-recall index
│   ├── prompts/          # content-addressed system-prompt registry
│   ├── plugin-registry/  # third-party tool discovery
│   └── telemetry/        # opt-in usage metrics
└── apps/
    ├── cli/              # the nexus command
    ├── api/              # control-plane REST (webhooks, auth)
    └── license-server/   # self-hosted HMAC license verification
```

One public surface per package (`index.js`); implementation files live in `src/`.

## Development

```sh
npm install
node scripts/bundle-cli.mjs   # stage the self-contained publish copy
npm test                       # run the full suite
```

Conventions:

- ESM only, no TypeScript.
- Zero external runtime dependencies — check the Node stdlib first.
- `node:test` for tests. No Jest, Vitest, or Mocha.

## License

[MIT](LICENSE)