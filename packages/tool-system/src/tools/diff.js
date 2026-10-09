// Unified diff, zero-dep. Line-based Myers with a search-band cap: falls
// back to a coarse replace-region diff when files are too different (large
// D), which is exactly the trade a CLI needs — bounded time, still correct.
const MAX_D = 2000;

/** splitLines keeps the terminator so CRLF files stay CRLF after a rebuild. */
export function splitLines(s) {
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') { out.push(s.slice(start, i + 1)); start = i + 1; }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

export function unifiedDiff(aText, bText, { fromFile = 'a', toFile = 'b', context = 3 } = {}) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const eq = (i, j) => stripCr(a[i]) === stripCr(b[j]);
  const ops = diffOps(a, b, eq);
  // group into hunks with `context` lines around changed runs
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === 'eq') { i++; continue; }
    let end = i;
    while (end < ops.length) {
      if (ops[end].t === 'eq' && runLen(ops, end) > context * 2) break;
      end++;
    }
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length, end + context);
    hunks.push({ from, to });
    i = end;
  }
  const lines = [`--- ${fromFile}`, `+++ ${toFile}`];
  for (const h of hunks) {
    let aStart = 0; let bStart = 0;
    for (let k = 0; k < h.from; k++) {
      if (ops[k].t !== 'ins') aStart++;
      if (ops[k].t !== 'del') bStart++;
    }
    let aLen = 0; let bLen = 0;
    const body = [];
    for (let k = h.from; k < h.to; k++) {
      const op = ops[k];
      if (op.t === 'eq') { body.push(' ' + printLine(a[op.i])); aLen++; bLen++; }
      else if (op.t === 'del') { body.push('-' + printLine(a[op.i])); aLen++; }
      else { body.push('+' + printLine(b[op.j])); bLen++; }
    }
    lines.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    lines.push(...body);
  }
  return lines.join('\n');
}

function runLen(ops, i) {
  let n = 0;
  while (i + n < ops.length && ops[i + n].t === 'eq') n++;
  return n;
}

function printLine(l) {
  return (l ?? '').replace(/\r?\n$/, '\n');
}

function stripCr(l) {
  return (l ?? '').replace(/\r?\n$/, '');
}

/** Myers greedy with D cap; returns [{t:'eq'|'del'|'ins', i, j}] */
export function diffOps(a, b, eq) {
  const n = a.length; const m = b.length;
  const v = new Int32Array(2 * (n + m) + 1);
  const offset = n + m;
  const trace = [];
  let done = false;
  let fallback = false;
  for (let d = 0; d <= Math.min(n + m, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(x, y)) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
    if (done) break;
  }
  if (!done) fallback = true;
  if (fallback) {
    // coarse: common prefix/suffix, one replace block
    const ops = [];
    let p = 0;
    while (p < n && p < m && eq(p, p)) { ops.push({ t: 'eq', i: p, j: p }); p++; }
    const s = coarseSuffix(a, b, eq, p);
    for (let i = p; i < n - s; i++) ops.push({ t: 'del', i });
    for (let j = p; j < m - s; j++) ops.push({ t: 'ins', i: Math.min(p, n - 1), j });
    return ops;
  }
  // backtrack
  const ops = [];
  let x = n; let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let kPrev;
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) kPrev = k + 1;
    else kPrev = k - 1;
    const prevX = vv[offset + kPrev];
    const prevY = prevX - kPrev;
    while (x > prevX && y > prevY) { ops.push({ t: 'eq', i: --x, j: --y }); }
    if (d > 0) {
      if (x === prevX) ops.push({ t: 'ins', i: x, j: --y });
      else ops.push({ t: 'del', i: --x, j: y });
    }
  }
  ops.reverse();
  return ops;
}

function coarseSuffix(a, b, eq, p) {
  let s = 0;
  while (s < a.length - p && s < b.length - p && eq(a.length - 1 - s, b.length - 1 - s)) s++;
  return s;
}
