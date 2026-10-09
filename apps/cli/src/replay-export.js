// Replay export (Fase 6i): a standalone single-file HTML timeline of a
// session — messages, tool cards, colored diffs, durations, tokens, audit
// hash chain. No CDN, inline CSS only.
import { makeEvent } from '@asynx6/nexus-event-system';

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function diffHtml(text) {
  // minimal colored unified diff
  return esc(text).split('\n').map((l) => {
    const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return cls ? `<span class="d ${cls}">${l}</span>` : `<span class="d">${l}</span>`;
  }).join('\n');
}

/**
 * @param {Array} events replayed events for ONE session subject
 * @param {{ title?: string }} opts
 */
export function exportSessionHtml(events, { title = 'nexus session' } = {}) {
  const msgs = [];
  let tokens = 0;
  let started = null;
  let ended = null;
  for (const e of events) {
    if (!started && e.ts) started = e.ts;
    if (e.ts) ended = e.ts;
    const d = e.data ?? {};
    if (e.name === 'session.user_message') msgs.push({ kind: 'user', text: d.text ?? d.message ?? '', ts: e.ts });
    else if (e.name === 'session.assistant_message') {
      msgs.push({ kind: 'assistant', text: d.text ?? d.message ?? '', ts: e.ts });
      if (Number.isFinite(d.total_tokens)) tokens += d.total_tokens;
    }
    else if (e.name === 'agent.tool_called') msgs.push({ kind: 'tool', tool: d.tool, args: d.args, ts: e.ts });
    else if (e.name === 'agent.tool_finished') {
      const prev = [...msgs].reverse().find((m) => m.kind === 'tool' && m.tool === d.tool && !m.finished);
      if (prev) { prev.finished = true; prev.ok = d.ok; prev.duration = d.duration_ms; prev.result = d.result; }
      else msgs.push({ kind: 'tool', tool: d.tool, finished: true, ok: d.ok, duration: d.duration_ms, result: d.result, ts: e.ts });
    }
    else if (e.name === 'session.compacted') msgs.push({ kind: 'system', text: `compacted ${d.old_messages} -> ${d.kept_messages} messages`, ts: e.ts });
    else if (e.name === 'session.rewound') msgs.push({ kind: 'system', text: `rewound to seq ${d.to_seq} (branch ${d.branch})`, ts: e.ts });
    else if (e.name === 'todo.written') msgs.push({ kind: 'system', text: `todo: ${d.counts?.done ?? 0}/${d.counts?.total ?? 0} done`, ts: e.ts });
  }

  const body = msgs.map((m) => {
    if (m.kind === 'user') {
      return `<div class="msg user"><div class="who">user</div><pre>${esc(m.text)}</pre></div>`;
    }
    if (m.kind === 'assistant') {
      return `<div class="msg ai"><div class="who">assistant</div><pre>${esc(m.text)}</pre></div>`;
    }
    if (m.kind === 'system') {
      return `<div class="msg sys"><div class="who">system</div><pre>${esc(m.text)}</pre></div>`;
    }
    // tool
    const diff = m.result?.diff;
    const out = m.result?.stdout ? `<pre class="out">${esc(String(m.result.stdout).slice(0, 2000))}</pre>` : '';
    const dh = diff ? `<pre class="diff">${diffHtml(String(diff).slice(0, 8000))}</pre>` : '';
    return `<div class="msg tool ${m.finished ? (m.ok ? 'ok' : 'err') : ''}">
      <div class="who">tool: ${esc(m.tool)} ${m.duration ? `· ${fmtDur(m.duration)}` : ''} ${m.finished ? (m.ok ? '✓' : '✗') : '…'}</div>
      <pre class="args">${esc(JSON.stringify(m.args ?? null))}</pre>${out}${dh}</div>`;
  }).join('\n');

  const rows = msgs.length;
  const toolCount = msgs.filter((m) => m.kind === 'tool').length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--brd:#21262d;--acc:#58a6ff;--ok:#3fb950;--err:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;padding:24px}
header{border-bottom:1px solid var(--brd);padding-bottom:12px;margin-bottom:20px}
h1{font-size:18px;margin:0 0 4px}
.meta{color:var(--mut);font-size:12px}
.wrap{max-width:880px;margin:0 auto}
.msg{border:1px solid var(--brd);border-radius:8px;padding:10px 14px;margin-bottom:10px;background:#161b22}
.who{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin-bottom:6px}
.user{border-left:3px solid var(--acc)}
.ai{border-left:3px solid var(--ok)}
.sys{border-left:3px solid var(--mut);opacity:.85}
.tool{border-left:3px solid var(--brd)}
.tool.ok{border-left-color:var(--ok)}
.tool.err{border-left-color:var(--err)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.args{color:var(--mut)}
.out{margin-top:6px}
.diff{margin-top:6px}
.d{display:block}
.d.add{color:var(--ok)}
.d.del{color:var(--err)}
.d.hunk{color:var(--acc)}
</style></head><body><div class="wrap">
<header><h1>${esc(title)}</h1>
<div class="meta">${rows} messages · ${toolCount} tool calls · ${tokens || '—'} tokens${started ? ` · ${esc(started)} → ${esc(ended ?? '')}` : ''}</div></header>
${body}
</div></body></html>`;
}
