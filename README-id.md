<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22">
  <img src="https://img.shields.io/badge/runtime_dependencies-0-brightgreen" alt="zero deps">
  <img src="https://img.shields.io/badge/tests-636%20passing-success" alt="tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

# NEXUS

> [English](README.md) · **Bahasa Indonesia**

**AI Agent Operating Environment open-source.** Kasih LLM shell ter-sandbox, tool file beneran, dan memori yang bertahan lintas run — lalu rekam setiap langkah jadi event yang bisa di-replay.

Agent jalanin task di sandbox Docker terisolasi, nulis kode, eksekusi perintah terminal, perbaiki error sendiri, dan setiap keputusan tercatat di event log append-only yang bisa di-replay, di-diff, di-export, dan diaudit.

> Nol dependency eksternal saat runtime. Node ≥ 22. Endpoint OpenAI-compatible apapun bisa jadi model backend.

---

## Fitur Utama

| | |
|---|---|
| 🖥️ **REPL interaktif** | TUI streaming dengan slash command, line editor, plan mode — atau headless `nexus run` / `-p` |
| 🧰 **Tool coding beneran** | Myers diff, `fs.edit` multi-edit (whitespace-tolerant, aman CRLF/BOM), `fs.glob/grep/list`, terminal background job, todo, web fetch, repo symbol map |
| ⏪ **Checkpoint + `/rewind`** | Snapshot sebelum setiap tool yang mengubah file; restore kode, percakapan, atau keduanya |
| 🪝 **Hooks** | PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart / SessionEnd — exit 2 blokir aksi + stderr jadi feedback buat model |
| 🤖 **Subagent** | `agent.spawn` in-process (explore / plan / general + agen kustom), read-only di-enforce, grant mewarisi principal parent |
| 🔌 **MCP client** | JSON-RPC 2.0 via stdio + streamable HTTP; tool muncul sebagai `mcp.<server>.<tool>` |
| 📄 **Konteks proyek** | Hierarki `NEXUS.md` → `AGENTS.md` → `CLAUDE.md` dengan `@import`, auto context compaction, scaffold `/init`, `/memory` |
| 🔒 **Model permission** | Denylist → rule persisten → mode (`ask` / `accept-edits` / `plan` / `auto`) → prompt interaktif, audit trail lengkap |
| 🌲 **Sadar git** | Peringatan dirty tree, `/diff`, sesi `--worktree`, `--auto-commit` (selalu minta konfirmasi, tidak pernah push) |
| 🧾 **Event-sourced** | Setiap tool call, keputusan permission, dan hasil = event: replay, diff dua run, export ke halaman HTML standalone |

## Install

```sh
npm install -g @asynx6/nexus-cli
nexus --version
```

Dari GitHub Packages:

```sh
echo "@asynx6:registry=https://npm.pkg.github.com" >> .npmrc
# tambahkan token GitHub dengan scope read:packages ke .npmrc dulu
npm install -g @asynx6/nexus-cli
```

Atau dari source:

```sh
git clone https://github.com/asynx6/nexus-cli
cd nexus-cli && npm install
node apps/cli/bin.mjs --version
```

Kebutuhan: **Node ≥ 22** (`node:sqlite`, test runner bawaan), Docker cuma buat isolasi sandbox, dan endpoint chat-completions OpenAI-compatible.

## Mulai Cepat

```sh
# 1. arahkan NEXUS ke gateway OpenAI-compatible apapun
nexus setup                      # wizard interaktif -> .env-gateway

# 2. ngobrol sama agent (REPL streaming)
nexus

# 3. atau jalanin task sekali jalan
nexus run "tulis fungsi fibonacci di fib.py"
```

Environment variable (`.env-gateway`, di-gitignore):

```
NEXUS_GATEWAY_BASE=https://api.example.com/v1   # base URL OpenAI-compatible
NEXUS_GATEWAY_KEY=sk-...
NEXUS_GATEWAY_MODELS=model-a,model-b            # fallback chain, murah dulu
```

Provider coba satu-satu kalau 401/404/timeout — taruh model paling murah + reliable di depan.

## REPL

`nexus` (tanpa argumen, di TTY) masuk sesi streaming:

```
nexus repl — model-lo | mode: ask | session: session-7d3a…
type /help for commands, Ctrl+C twice to exit

nexus> refactor src/auth.js ke async/await
▊ respons streaming…
```

Slash command: `/plan` `/diff` `/rewind` `/compact` `/memory` `/skills` `/mcp` `/cost` `/status` `/resume` `/permissions` `/doctor` `/init` dan lainnya.

### Mode

| Mode | Perilaku |
|---|---|
| `ask` | setiap tool yang mengubah file minta izin dulu (default) |
| `accept-edits` | edit file auto-approve, terminal tetap tanya |
| `plan` | read-only; agent bikin rencana buat lo approve |
| `auto` | tanpa prompt — wajib `--dangerously-auto` |

### Checkpoint & rewind

Setiap `fs.write` / `fs.edit` snapshot file yang disentuh ke `.nexus/checkpoints/` dulu. `/rewind` menampilkan daftarnya dan restore kode, percakapan, atau keduanya — event log sendiri append-only, rewind cuma buka cabang baru dari event N.

### Subagent

Definisikan agen di `.nexus/agents/*.md` (frontmatter: `name`, `description`, `tools`, `permissionMode`; isi = system prompt). Agen utama spawn mereka pakai `agent.spawn`, terima ringkasan saja, dan tidak pernah berbagi konteks sendiri. Agen `explore` default read-only.

### MCP

Taruh server di `.nexus/mcp.json`:

```json
{ "servers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } } }
```

Tool mereka muncul ke agent sebagai `mcp.github.<tool>`, lewat permission gate sama seperti tool lain. `/mcp` menampilkan status koneksi.

### Hooks

```json
{
  "hooks": {
    "PreToolUse": [{ "match": "fs.write|fs.edit", "command": "node", "args": ["scripts/check-path.mjs"] }],
    "Stop": [{ "command": "npm", "args": ["test", "--silent"] }]
  }
}
```

Hook terima event sebagai JSON di stdin. Exit `0` = lanjut, exit `2` = blokir aksi dan stderr dikirim balik ke model. Tanpa shell kecuali diminta.

### Skills & dokumen proyek

- `.nexus/skills/<nama>/SKILL.md` — format frontmatter standar; nama + deskripsi masuk system prompt, isi dimuat saat dipanggil (`skill.load`).
- `NEXUS.md` di root proyek (fallback ke `AGENTS.md` → `CLAUDE.md`, support `@import` dokumen sebelah) diinjeksi sebagai instruksi proyek setiap sesi.

### Sesi, replay & export

```sh
nexus run "perbaiki test yang flaky" --continue   # lanjut sesi terakhir di direktori ini
nexus sessions                                    # daftar sesi
nexus replay export <session-id> --html           # halaman HTML standalone buat dibagikan
nexus replay diff <kiri> <kanan>                  # bandingkan dua run event-per-event
nexus replay --port 9090                          # dashboard browser live
```

## Operator

```sh
nexus doctor                        # cek kesehatan environment (--fix buat perbaiki)
nexus healthz                       # cek gateway reachable
nexus secrets set OPENAI_API_KEY    # vault terenkripsi per-proyek (AES-256-GCM)
nexus prompts list                  # system prompt content-addressed + versioned
nexus webhooks add <url>            # subscription event HMAC-signed
nexus plugins --dir=.nexus/tools    # tool pihak ketiga drop-in
nexus telemetry on                  # opt-in, cuma hitungan & timing — tanpa konten
```

Prompt diversion berdasarkan content hash, jadi run yang terekam bisa di-replay dengan byte instruksi persis sama:

```sh
nexus prompts show cli.default --rev=<hash>         # isi satu versi
nexus run "tulis fib" --prompt=cli.default@<hash>   # pin versi persis
```

Secrets tersimpan di vault terenkripsi `.nexus/secrets.enc` — tidak pernah di `.env`, log, atau event. Nilai cuma muncul di environment exec agent:

```sh
nexus secrets init                # bikin vault (minta passphrase)
nexus secrets grant agent-1 OPENAI_API_KEY
```

Pengiriman webhook ditandatangani HMAC-SHA256 (`X-NEXUS-Signature`) dengan retry exponential-backoff:

```sh
nexus webhooks add https://service-lo/hooks/nexus --events=task.completed --secret=wh-secret
nexus webhooks test hook-<id>
```

Plugin: taruh `*.tools.js` di `.nexus/tools/`, tool-nya auto-terdeteksi di run berikutnya:

```js
// .nexus/tools/weather.tools.js
export const tools = [{ name: "wx.now", description: "cuaca sekarang", handler: async () => ({}) }];
```

Telemetry mati secara default; `nexus telemetry on` cuma rekam hitungan dan timing — tidak pernah prompt, path, atau token.

## Arsitektur

```
nexus/
├── packages/
│   ├── shared/           # kontrak event, id, env loader
│   ├── event-system/     # EventBus + JSONL store + index sqlite + replay/diff
│   ├── sandbox-runtime/  # Docker engine API lewat raw socket
│   ├── security/         # permission, denylist, audit trail, vault secrets
│   ├── tool-system/      # registry, executor, checkpoint, tool bawaan
│   ├── model-providers/  # klien OpenAI-compatible, fallback + streaming
│   ├── agent-runtime/    # agent loop, tool bridge
│   ├── memory/           # memory pluggable + index recall event
│   ├── mcp-server/       # expose NEXUS ke klien MCP lain
│   ├── consensus/        # voting multi-model
│   ├── multi-agent/      # cluster supervisor, work queue
│   ├── prompts/          # registry prompt content-addressed
│   ├── plugin-registry/  # discovery tool pihak ketiga
│   └── telemetry/        # metrik usage opt-in
└── apps/
    ├── cli/              # perintah nexus
    └── api/              # REST control-plane (webhooks, auth)
```

Setiap package di-publish terpisah ke [GitHub Packages](https://github.com/asynx6?tab=packages&q=nexus) sebagai `@asynx6/nexus-*` — satu public surface per package (`index.js`), implementasi di `src/`.

## Development

```sh
npm install
npm run lint          # syntax-check 115 modul
npm test              # 636 test
```

Konvensi: ESM only, nol dependency runtime eksternal (Node stdlib dulu), `node:test` — tanpa Jest/Vitest/Mocha.

## Lisensi

[MIT](LICENSE)
