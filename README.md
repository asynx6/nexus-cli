<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22">
  <img src="https://img.shields.io/badge/runtime_dependencies-0-brightgreen" alt="zero deps">
  <img src="https://img.shields.io/badge/tests-636%20passing-success" alt="tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

# NEXUS

**An open-source AI Agent Operating Environment.** Give an LLM a sandboxed shell, real file tools, and a memory that survives the run — then record every single step as a replayable event.

Agents run tasks in an isolated Docker sandbox, write code, execute terminal commands, fix their own errors, and persist every decision as an append-only event log you can replay, diff, export, and audit.

> Zero external runtime dependencies. Node ≥ 22. Any OpenAI-compatible endpoint as the model backend.

---

## Highlights

| | |
|---|---|
| 🖥️ **Interactive REPL** | Streaming TUI with slash commands, line editor, plan mode — or headless `nexus run` / `-p` |
| 🧰 **Real coding tools** | Myers diff, multi-edit `fs.edit` (whitespace-tolerant match, CRLF/BOM safe), `fs.glob/grep/list`, background terminal jobs, todo, web fetch, repo symbol map |
| ⏪ **Checkpoints + `/rewind`** | Snapshot before every mutating tool; restore code, conversation, or both |
| 🪝 **Hooks** | PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart / SessionEnd — exit 2 blocks with stderr feedback to the model |
| 🤖 **Subagents** | In-process `agent.spawn` (explore / plan / general + custom agents), read-only enforcement, grants inherit the parent principal |
| 🔌 **MCP client** | JSON-RPC 2.0 over stdio + streamable HTTP; tools appear as `mcp.<server>.<tool>` |
| 📄 **Project context** | Hierarchical `NEXUS.md` → `AGENTS.md` → `CLAUDE.md` with `@import`, auto context compaction, `/init` scaffold, `/memory` |
| 🔒 **Permission model** | Denylist → persistent rules → mode (`ask` / `accept-edits` / `plan` / `auto`) → interactive prompt, full audit trail |
| 🌲 **Git aware** | Dirty-tree warning, `/diff`, `--worktree` sessions, `--auto-commit` (always asks, never pushes) |
| 🧾 **Event-sourced** | Every tool call, permission decision, and result is an event: replay, diff two runs, export to a shareable standalone HTML page |

## Install

```sh
npm install -g @asynx6/nexus-cli
nexus --version
```

From GitHub Packages:

```sh
echo "@asynx6:registry=https://npm.pkg.github.com" >> .npmrc
# add your GitHub token with read:packages scope to .npmrc first
npm install -g @asynx6/nexus-cli
```

Or from source:

```sh
git clone https://github.com/asynx6/nexus-cli
cd nexus-cli && npm install
node apps/cli/bin.mjs --version
```

Requirements: **Node ≥ 22** (`node:sqlite`, built-in test runner), Docker only for sandbox isolation, and an OpenAI-compatible chat-completions endpoint.

## Quick start

```sh
# 1. point NEXUS at any OpenAI-compatible gateway
nexus setup                      # interactive wizard -> .env-gateway

# 2. chat with the agent (streaming REPL)
nexus

# 3. or run a one-shot task
nexus run "write a fibonacci function in fib.py"
```

Environment variables (`.env-gateway`, gitignored):

```
NEXUS_GATEWAY_BASE=https://api.example.com/v1   # any OpenAI-compatible base URL
NEXUS_GATEWAY_KEY=sk-...
NEXUS_GATEWAY_MODELS=model-a,model-b            # fallback chain, cheapest first
```

The provider tries each model in order on 401/404/timeout — put your cheapest reliable model first.

## The REPL

`nexus` (no args, in a TTY) drops you into a streaming session:

```
nexus repl — your-model | mode: ask | session: session-7d3a…
type /help for commands, Ctrl+C twice to exit

nexus> refactor src/auth.js to use async/await
▊ streaming response…
```

Slash commands: `/plan` `/diff` `/rewind` `/compact` `/memory` `/skills` `/mcp` `/cost` `/status` `/resume` `/permissions` `/doctor` `/init` and more.

### Modes

| Mode | Behavior |
|---|---|
| `ask` | every mutating tool asks first (default) |
| `accept-edits` | file edits auto-approved, terminal still asks |
| `plan` | read-only; agent produces a plan for your approval |
| `auto` | no prompts — requires `--dangerously-auto` |

### Checkpoints & rewind

Every `fs.write` / `fs.edit` snapshots the touched files into `.nexus/checkpoints/` first. `/rewind` lists them and restores code, conversation, or both — the event log itself is append-only, rewinding just opens a new branch from event N.

### Subagents

Define agents in `.nexus/agents/*.md` (frontmatter: `name`, `description`, `tools`, `permissionMode`; body = system prompt). The main agent spawns them with `agent.spawn`, gets a summary back, and never shares its own context. Default `explore` agent is read-only.

### MCP

Drop servers into `.nexus/mcp.json`:

```json
{ "servers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } } }
```

Their tools appear to the agent as `mcp.github.<tool>`, permission-gated like every other tool. `/mcp` shows connection status.

### Hooks

```json
{
  "hooks": {
    "PreToolUse": [{ "match": "fs.write|fs.edit", "command": "node", "args": ["scripts/check-path.mjs"] }],
    "Stop": [{ "command": "npm", "args": ["test", "--silent"] }]
  }
}
```

Hook receives the event as JSON on stdin. Exit `0` = continue, exit `2` = block the action and feed stderr back to the model. No shell unless you opt in.

### Skills & project docs

- `.nexus/skills/<name>/SKILL.md` — standard frontmatter format; name + description enter the system prompt, the body loads on invocation (`skill.load`).
- `NEXUS.md` at the project root (falls back to `AGENTS.md` → `CLAUDE.md`, supports `@import` of sibling docs) is injected as project instructions every session.

### Sessions, replay & export

```sh
nexus run "fix the flaky test" --continue        # resume the last session in this directory
nexus sessions                                   # list sessions
nexus replay export <session-id> --html          # standalone shareable HTML page
nexus replay diff <left> <right>                 # event-by-event comparison of two runs
nexus replay --port 9090                         # live browser dashboard
```

## Operators

```sh
nexus doctor                        # environment health check (--fix to repair)
nexus healthz                       # gateway reachability
nexus secrets set OPENAI_API_KEY    # per-project encrypted vault (AES-256-GCM)
nexus prompts list                  # content-addressed, versioned system prompts
nexus webhooks add <url>            # HMAC-signed event subscriptions
nexus plugins --dir=.nexus/tools    # drop-in third-party tools
nexus telemetry on                  # opt-in counts/timings only, never content
```

Prompts are versioned by content hash, so a recorded run can be replayed against the exact instruction bytes it used:

```sh
nexus prompts show cli.default --rev=<hash>         # body of one version
nexus run "write fib" --prompt=cli.default@<hash>   # pin an exact version
```

Secrets live in an encrypted vault at `.nexus/secrets.enc` — never in `.env`, logs, or events. Values surface in the agent's exec environment only:

```sh
nexus secrets init                # create the vault (asks a passphrase)
nexus secrets grant agent-1 OPENAI_API_KEY
```

Webhook deliveries are HMAC-SHA256 signed (`X-NEXUS-Signature`) with exponential-backoff retries:

```sh
nexus webhooks add https://your-service/hooks/nexus --events=task.completed --secret=wh-secret
nexus webhooks test hook-<id>
```

Plugins: drop a `*.tools.js` in `.nexus/tools/` and its tools are auto-discovered on the next run:

```js
// .nexus/tools/weather.tools.js
export const tools = [{ name: "wx.now", description: "current weather", handler: async () => ({}) }];
```

Telemetry is off by default; `nexus telemetry on` records only counts and timings — never prompts, paths, or tokens.

## Architecture

```
nexus/
├── packages/
│   ├── shared/           # event contracts, ids, env loader
│   ├── event-system/     # EventBus + JSONL store + sqlite index + replay/diff
│   ├── sandbox-runtime/  # Docker engine API over raw socket
│   ├── security/         # permissions, denylist, audit trail, secrets vault
│   ├── tool-system/      # registry, executor, checkpoints, built-in tools
│   ├── model-providers/  # OpenAI-compatible client, fallback + streaming
│   ├── agent-runtime/    # agent loop, tool bridge
│   ├── memory/           # pluggable memory + event-recall index
│   ├── mcp-server/       # expose NEXUS to other MCP-aware clients
│   ├── consensus/        # multi-model voting
│   ├── multi-agent/      # cluster supervisor, work queue
│   ├── prompts/          # content-addressed prompt registry
│   ├── plugin-registry/  # third-party tool discovery
│   └── telemetry/        # opt-in usage metrics
└── apps/
    ├── cli/              # the nexus command
    └── api/              # control-plane REST (webhooks, auth)
```

Every package is independently published to [GitHub Packages](https://github.com/asynx6?tab=packages&q=nexus) as `@asynx6/nexus-*` — one public surface per package (`index.js`), implementation in `src/`.

## Development

```sh
npm install
npm run lint          # syntax-check all 115 modules
npm test              # 636 tests
```

Conventions: ESM only, zero external runtime dependencies (Node stdlib first), `node:test` — no Jest/Vitest/Mocha.

## License

[MIT](LICENSE)
