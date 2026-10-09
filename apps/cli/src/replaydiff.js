// `nexus replay diff <left> <right>` — compare two runs in the event store
// (TASK-LEONARS-B3). Reads both subjects, aligns them with @asynx6/event-system
// diffRuns, prints a compact unified report. --json emits the raw op list.
//
// ponytail: subjects are matched by exact id; a fuzzier run picker (latest N
// runs, --last) is out of scope until the store indexes runs as a set.

import { diffRuns, summarize } from '@asynx6/nexus-event-system';

export const REPLAY_DIFF_HELP = `nexus replay diff <left> <right> [--json] [--limit=N]  compare two runs event-by-event
                                                          left/right are subject ids (task ids).
                                                          --json   emit the raw diff ops as JSON
                                                          --limit=N cap events read per run (default 20000)`;

const DEFAULT_LIMIT = 20000;

function readRun(store, subject, limit) {
  const out = [];
  for (const env of store.replay({ subject, limit })) {
    out.push(env);
    if (out.length >= limit) break;
  }
  return out;
}

function fmtVal(v) {
  if (v === undefined || v === null) return String(v);
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function fmtEvent(e, tag) {
  const seq = e.seq ?? '?';
  const name = e.name;
  const bits = [];
  const d = e.data ?? {};
  for (const k of Object.keys(d).slice(0, 3)) {
    const v = fmtVal(d[k]);
    bits.push(`${k}=${v.length > 60 ? v.slice(0, 57) + '...' : v}`);
  }
  return `  ${tag} [seq ${seq}] ${name}${bits.length ? '  ' + bits.join('  ') : ''}`;
}

/**
 * Run the diff subcommand.
 * @param {string[]} argv args after `replay diff`
 * @param {{ store: { open: () => Promise<object> } }} ctx replay ctx
 * @param {(s: string) => void} stdout
 * @param {(s: string) => void} stderr
 * @returns {Promise<number>} exit code
 */
/**
 * Run the diff subcommand.
 * @param {string[]} argv positional args after `replay diff`
 * @param {{ store: { open: () => Promise<object> } }} ctx replay ctx
 * @param {(s: string) => void} stdout
 * @param {(s: string) => void} stderr
 * @param {object} [flags] pre-parsed --flags from the CLI dispatcher
 * @returns {Promise<number>} exit code
 */
export async function runReplayDiff(argv, ctx, stdout, stderr, flags = {}) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else flags[a.slice(2)] = true;
  }
  if (flags.help) { stdout(REPLAY_DIFF_HELP); return 0; }

  const left = positional[0] ?? flags.left;
  const right = positional[1] ?? flags.right;
  if (!left || !right) {
    stderr('replay diff: two subjects required: `nexus replay diff <left> <right>`');
    return 2;
  }
  const limit = Number(flags.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) {
    stderr('replay diff: --limit must be a positive integer');
    return 2;
  }

  const store = await ctx.store.open();
  try {
    const a = readRun(store, left, limit);
    const b = readRun(store, right, limit);
    if (a.length === 0) { stderr(`replay diff: no events for subject ${left}`); return 1; }
    if (b.length === 0) { stderr(`replay diff: no events for subject ${right}`); return 1; }

    const ops = diffRuns(a, b);
    const s = summarize(ops);

    if (flags.json) {
      stdout(JSON.stringify({ left, right, summary: s, ops }, null, 2));
      return 0;
    }

    stdout(`replay diff: ${left} → ${right}`);
    stdout(`  events: ${a.length} vs ${b.length}`);
    stdout(`  same ${s.same}  modified ${s.mod}  added ${s.added}  removed ${s.removed}`);
    if (s.identical) {
      stdout('  identical: both runs produced the same event spine and payloads');
      return 0;
    }
    stdout('');
    for (const op of ops) {
      if (op.op === 'same') continue;
      if (op.op === 'added') {
        stdout(`+ added (only in ${right})`);
        stdout(fmtEvent(op.b, '+'));
      } else if (op.op === 'removed') {
        stdout(`- removed (only in ${left})`);
        stdout(fmtEvent(op.a, '-'));
      } else {
        stdout(`~ modified (${op.a.name})`);
        for (const c of op.changes) {
          const from = fmtVal(c.from), to = fmtVal(c.to);
          stdout(`    ${c.field}: ${from.length > 80 ? from.slice(0, 77) + '...' : from} → ${to.length > 80 ? to.slice(0, 77) + '...' : to}`);
        }
      }
    }
    return 0;
  } finally {
    await store.close();
  }
}
