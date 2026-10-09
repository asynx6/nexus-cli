// @asynx6/telemetry — opt-in, redacting, batched usage metrics.
// OFF by default. Nothing is collected until the user runs `nexus telemetry on`
// (or sets NEXUS_TELEMETRY=1). There is no network call in this package —
// a caller flushes the batch wherever it wants (file, endpoint, or /dev/null).
//
// What is recorded: counts and timings only. Values are never inspected:
// tool names, event names, model ids, exit codes, and durations. No prompts,
// no file paths, no env values, no tokens.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const TELEMETRY_FLAG_FILE = '.nexus/telemetry.json';

/** True only when the user opted in. Respects NEXUS_TELEMETRY=0 as a hard off. */
export function isTelemetryEnabled({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.NEXUS_TELEMETRY === '0') return false;
  if (env.NEXUS_TELEMETRY === '1') return true;
  try {
    const p = join(cwd, TELEMETRY_FLAG_FILE);
    if (!existsSync(p)) return false;
    // The flag file persists the choice in both states; trust its content.
    return JSON.parse(readFileSync(p, 'utf8')).enabled === true;
  } catch { return false; }
}

/** Persist the opt-in choice so later runs do not need the env var. */
export function setTelemetryEnabled(on, { cwd = process.cwd() } = {}) {
  const p = join(cwd, TELEMETRY_FLAG_FILE);
  if (on) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled: true, ts: new Date().toISOString() }, null, 2) + '\n');
    return true;
  }
  if (existsSync(p)) writeFileSync(p, JSON.stringify({ enabled: false, ts: new Date().toISOString() }, null, 2) + '\n');
  return false;
}

/**
 * Buffered counter + timer. Call record() many times, flush() once.
 * Never throws — telemetry must not break the run it is measuring.
 */
export class Telemetry {
  constructor({ enabled, clock = Date.now } = {}) {
    this.enabled = !!enabled;
    this.clock = clock;
    this.counters = new Map();
    this.timers = new Map();
  }

  /** Increment a metric (e.g. record('tool.call', 'fs.read')). */
  record(metric, label = 'total', by = 1) {
    if (!this.enabled) return;
    try {
      const key = `${metric}.${label}`;
      this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    } catch { /* swallow */ }
  }

  /** Start a timer; stop() records the elapsed ms under the same key. */
  start(metric, label = 'total') {
    if (!this.enabled) return () => {};
    const key = `${metric}.${label}`;
    const t0 = this.clock();
    return () => {
      try {
        const ms = this.clock() - t0;
        const arr = this.timers.get(key) ?? [];
        arr.push(ms);
        this.timers.set(key, arr);
      } catch { /* swallow */ }
    };
  }

  /** Snapshot and clear. Returns null when nothing was recorded. */
  flush() {
    if (!this.enabled) return null;
    const counters = Object.fromEntries([...this.counters.entries()].sort());
    const timers = {};
    for (const [k, arr] of [...this.timers.entries()].sort()) {
      timers[k] = { n: arr.length, totalMs: arr.reduce((a, b) => a + b, 0) };
    }
    this.counters.clear();
    this.timers.clear();
    if (Object.keys(counters).length === 0 && Object.keys(timers).length === 0) return null;
    return { version: 1, ts: new Date().toISOString(), counters, timers };
  }
}

/**
 * Default sink: append the flushed batch as one JSON line. Skipped when the
 * caller passes a custom writer or when disabled.
 */
export function writeTelemetryBatch(batch, path) {
  if (!batch || !path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(batch) + '\n', { flag: 'a' });
    return true;
  } catch { return false; }
}
