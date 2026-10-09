import { DatabaseSync } from 'node:sqlite';
import { openSync, readSync, writeSync, closeSync, fsyncSync, appendFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isEnvelope } from './events.js';

const INDEX_BATCH = 256;

/**
 * Append-only event store: JSONL data file + SQLite index (node:sqlite).
 * JSONL is the source of truth; the index is rebuildable via rebuildIndex().
 * seq is a store-assigned, gapless, monotonic append order; replay walks seq.
 *
 * Durability model:
 * - append() writes the JSONL line immediately (single buffered fd, no
 *   per-append open/close/stat); the line is on the OS before the call returns.
 * - Index rows are committed in batches of INDEX_BATCH to amortise WAL
 *   overhead; reads flush the pending batch first, so replay never goes blind.
 * - If the process dies between writes, #syncIndex() on next open re-indexes
 *   JSONL lines the index has not seen. Events are never lost, only index
 *   entries lag.
 * - SQLite runs WAL + synchronous = NORMAL: the index is derived data, so
 *   per-row fsync would be pure overhead without added durability.
 */
export class EventStore {
  #db;
  #jsonlPath;
  #insert;
  #metaStmt;
  #seq;
  #fd;
  #offset;      // bytes persisted in the JSONL file
  #wbumps = []; // pending index rows: {rec, offset, length}

  /** @param {string} jsonlPath path to the .jsonl data file (index sits beside it) */
  constructor(jsonlPath) {
    this.#jsonlPath = jsonlPath;
    mkdirSync(dirname(jsonlPath), { recursive: true });
    const idxPath = jsonlPath + '.idx';
    if (!existsSync(jsonlPath)) appendFileSync(jsonlPath, '');
    this.#fd = openSync(jsonlPath, 'a');
    this.#offset = statSync(jsonlPath).size;
    this.#db = new DatabaseSync(idxPath);
    this.#db.exec(
      'PRAGMA journal_mode = WAL;' +
      'PRAGMA synchronous = NORMAL;' +
      'PRAGMA cache_size = -8000;' +
      'CREATE TABLE IF NOT EXISTS events (' +
      '  seq INTEGER PRIMARY KEY,' +
      '  id TEXT NOT NULL UNIQUE,' +
      '  subject TEXT,' +
      '  name TEXT NOT NULL,' +
      '  ts INTEGER NOT NULL,' +
      '  byte_offset INTEGER NOT NULL,' +
      '  byte_length INTEGER NOT NULL' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_events_subject_seq ON events (subject, seq);' +
      'CREATE INDEX IF NOT EXISTS idx_events_name_seq ON events (name, seq);'
    );
    this.#insert = this.#db.prepare(
      'INSERT INTO events (seq, id, subject, name, ts, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    this.#metaStmt = this.#db.prepare('SELECT byte_offset, byte_length FROM events WHERE seq = ?');
    this.#seq = this.#syncIndex();
  }

  #indexBatch(batch) {
    if (batch.length === 0) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const { rec, offset, length } of batch) {
        this.#insert.run(rec.seq, rec.id, rec.subject, rec.name, Date.parse(rec.ts), offset, length);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* tx already gone */ }
      throw err;
    }
  }

  /** Commit any pending index rows. */
  #flushForRead() {
    const batch = this.#wbumps.splice(0, this.#wbumps.length);
    this.#indexBatch(batch);
  }

  /** Persist the JSONL fd position + commit pending index rows + fsync data. */
  sync() {
    this.#flushForRead();
    try { fsyncSync(this.#fd); } catch { /* best-effort */ }
  }

  /**
   * Trust JSONL over the index: index any trailing lines the DB has not seen
   * yet (covers crash-between-write-and-index). Returns next seq.
   */
  #syncIndex() {
    const row = this.#db.prepare('SELECT MAX(seq) AS m FROM events').get();
    let maxSeq = Number(row.m ?? -1);
    let pos = 0;
    if (maxSeq >= 0) {
      const known = this.#metaStmt.get(maxSeq);
      pos = Number(known.byte_offset) + Number(known.byte_length);
    }
    const size = statSync(this.#jsonlPath).size;
    if (pos > size) {
      throw new Error('index offset ' + pos + ' past EOF ' + size + ': data file truncated');
    }
    if (pos === size) return maxSeq + 1;
    const fd = openSync(this.#jsonlPath, 'r');
    try {
      let base = pos;
      let carry = Buffer.alloc(0);
      while (base < size) {
        const buf = Buffer.allocUnsafe(Math.min(65536, size - base));
        const got = readSync(fd, buf, 0, buf.length, base);
        if (got === 0) break;
        const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        const start = base - carry.length;
        let i = 0;
        let nl = data.indexOf(0x0a, i);
        while (nl !== -1) {
          const text = data.subarray(i, nl).toString('utf8').trim();
          if (text.length > 0) {
            const rec = JSON.parse(text);
            const absOffset = start + i;
            if (!isEnvelope(rec) || rec.seq !== maxSeq + 1) {
              throw new Error('corrupt line at offset ' + absOffset + ': expected seq ' + (maxSeq + 1));
            }
            maxSeq = rec.seq;
            this.#insert.run(rec.seq, rec.id, rec.subject, rec.name, Date.parse(rec.ts), absOffset, (nl - i) + 1);
          }
          i = nl + 1;
          nl = data.indexOf(0x0a, i);
        }
        carry = Buffer.from(data.subarray(i));
        base = start + i;
      }
    } finally {
      closeSync(fd);
    }
    return maxSeq + 1;
  }

  /**
   * Append one event. Assigns seq, writes the JSONL line now, queues the
   * index row for the next batch commit.
   * @param {object} event shared envelope from @asynx6/shared
   * @returns {object} stored event with assigned seq
   */
  append(event) {
    if (!isEnvelope(event)) throw new TypeError('event must be a shared envelope { id, ts, name, subject, data }');
    const seq = this.#seq++;
    const rec = { seq, ...event };
    const line = JSON.stringify(rec) + '\n';
    const byteLength = Buffer.byteLength(line);
    const offset = this.#offset;
    writeSync(this.#fd, line);
    this.#offset = offset + byteLength;
    this.#wbumps.push({ rec, offset, length: byteLength });
    if (this.#wbumps.length >= INDEX_BATCH) {
      this.#indexBatch(this.#wbumps.splice(0, this.#wbumps.length));
    }
    return rec;
  }

  /**
   * Replay iterator over stored events in seq order (append order).
   * @param {{ subject?: string, name?: string, since?: number, limit?: number }} [filter]
   * @returns {Generator<object>}
   */
  *replay(filter = {}) {
    this.#flushForRead();
    const conds = [];
    const args = [];
    if (filter.subject !== undefined) { conds.push('subject IS ?'); args.push(filter.subject); }
    if (filter.name !== undefined) { conds.push('name = ?'); args.push(filter.name); }
    if (filter.since !== undefined) { conds.push('seq >= ?'); args.push(filter.since); }
    let sql = 'SELECT seq FROM events ';
    if (conds.length > 0) sql += 'WHERE ' + conds.join(' AND ') + ' ';
    sql += 'ORDER BY seq';
    if (filter.limit !== undefined) sql += ' LIMIT ' + Number(filter.limit);
    const rows = this.#db.prepare(sql).all(...args);
    const fd = openSync(this.#jsonlPath, 'r');
    try {
      for (const row of rows) {
        const meta = this.#metaStmt.get(row.seq);
        const buf = Buffer.allocUnsafe(Number(meta.byte_length));
        readSync(fd, buf, 0, buf.length, Number(meta.byte_offset));
        yield JSON.parse(buf.toString('utf8').trim());
      }
    } finally {
      closeSync(fd);
    }
  }

  /** @returns {number} number of stored events (flushes pending index rows first) */
  count() {
    this.#flushForRead();
    return Number(this.#db.prepare('SELECT COUNT(*) AS c FROM events').get().c);
  }

  /** @returns {string} absolute path to the JSONL data file */
  get jsonlPath() {
    return this.#jsonlPath;
  }

  /** Drop the SQLite index and rebuild it by scanning the JSONL file. */
  rebuildIndex() {
    this.#wbumps = [];
    this.#db.exec('DELETE FROM events');
    this.#seq = this.#syncIndex();
  }

  close() {
    this.#flushForRead();
    closeSync(this.#fd);
    this.#db.close();
  }
}
