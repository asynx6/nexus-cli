// @asynx6/memory — EventRecall: sqlite index over EventStore.
// Read-mostly filter for past envelopes by subject/name/ts. Zero external deps.
// Distinct from MemoryManager (which is k-v records with pluggable storage).
// Both share the same package namespace.

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

export class EventRecall {
  #store;
  #db;
  #insert;

  /** @param {{ store: EventStore, dbPath: string }} opts */
  constructor({ store, dbPath }) {
    if (!store) throw new TypeError('store required');
    if (!dbPath) throw new TypeError('dbPath required (sqlite index path)');
    this.#store = store;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(
      'PRAGMA journal_mode = WAL;' +
      'CREATE TABLE IF NOT EXISTS recall_idx (' +
      '  id TEXT NOT NULL UNIQUE,' +
      '  subject TEXT,' +
      '  name TEXT NOT NULL,' +
      '  ts INTEGER NOT NULL' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_recall_subject_ts ON recall_idx (subject, ts);' +
      'CREATE INDEX IF NOT EXISTS idx_recall_name_ts ON recall_idx (name, ts);'
    );
    this.#insert = this.#db.prepare(
      'INSERT OR IGNORE INTO recall_idx (id, subject, name, ts) VALUES (?, ?, ?, ?)'
    );
  }

  /** Index one envelope. Returns true if newly inserted. */
  index(env) {
    if (!env || typeof env.id !== 'string' || typeof env.name !== 'string') return false;
    const ts = typeof env.ts === 'number' ? env.ts : Date.parse(env.ts ?? '') ?? 0;
    const r = this.#insert.run(env.id, env.subject ?? null, env.name, ts);
    return r.changes > 0;
  }

  /** Index a batch inside a single transaction. */
  indexBatch(envs) {
    this.#db.exec('BEGIN');
    let n = 0;
    try {
      for (const e of envs) if (this.index(e)) n++;
      this.#db.exec('COMMIT');
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw err;
    }
    return n;
  }

  /** Bulk-index everything from EventStore. Idempotent. */
  async rebuild() {
    let n = 0;
    const batch = [];
    for await (const env of this.#store.replay({})) {
      batch.push(env);
      if (batch.length >= 256) { n += this.indexBatch(batch); batch.length = 0; }
    }
    if (batch.length) n += this.indexBatch(batch);
    return n;
  }

  /** Recall indexed rows (newest first). */
  recall({ subject, name, sinceTs, untilTs, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (subject !== undefined) { where.push('subject = ?'); args.push(subject); }
    if (name !== undefined)    { where.push('name = ?');    args.push(name); }
    if (Number.isFinite(sinceTs))  { where.push('ts >= ?'); args.push(sinceTs); }
    if (Number.isFinite(untilTs))  { where.push('ts <= ?'); args.push(untilTs); }
    const sql = 'SELECT id, subject, name, ts FROM recall_idx' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY ts DESC LIMIT ?';
    args.push(limit);
    return this.#db.prepare(sql).all(...args);
  }

  /** Recall + hydrate full envelopes from EventStore in same DESC order. */
  async *recallHydrated(opts = {}) {
    const rows = this.recall(opts);
    if (!rows.length) return;
    const byId = new Map();
    for await (const env of this.#store.replay({})) byId.set(env.id, env);
    for (const r of rows) {
      const env = byId.get(r.id);
      if (env) yield env;
    }
  }

  count({ subject, name } = {}) {
    const where = [];
    const args = [];
    if (subject !== undefined) { where.push('subject = ?'); args.push(subject); }
    if (name !== undefined)    { where.push('name = ?');    args.push(name); }
    const sql = 'SELECT COUNT(*) AS n FROM recall_idx' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    return this.#db.prepare(sql).get(...args).n;
  }

  close() {
    try { this.#db.close(); } catch {}
  }
}

/** Convenience: open EventRecall backed by an EventStore at <dir>/events.jsonl,
 *  with the index file at <dir>/recall.idx. */
export function openEventRecall(store, dir) {
  return new EventRecall({ store, dbPath: join(dir, 'recall.idx') });
}
