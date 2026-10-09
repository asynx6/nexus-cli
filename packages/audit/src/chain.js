// @asynx6/audit — append-only audit log with SHA-256 hash chain.
// Each entry's prev_hash points to the previous entry's hash, forming a
// tamper-evident chain. verify() walks the file and checks every link;
// a single byte change anywhere invalidates everything after it.
//
// Storage: newline-delimited JSON, same shape as EventStore JSONL so the
// audit log can be appended from existing event pipelines without an
// adapter. Chain head is tracked in <file>.head for fast resume.
import { createHash } from 'node:crypto';
import { openSync, readSync, writeSync, closeSync, fsyncSync, existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const HEAD_SUFFIX = '.head';

/** Canonical JSON: sorted keys, no whitespace. Deterministic hash. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hash a record: sha256(prev_hash || canonical(record)). */
export function hashEntry(prevHash, record) {
  return sha256Hex(prevHash + canonical(record));
}

export class AuditChain {
  #fd;
  #headPath;
  #head;

  constructor(path) {
    this.path = path;
    this.#headPath = path + HEAD_SUFFIX;
    if (!existsSync(path)) appendFileSync(path, '');
    this.#fd = openSync(path, 'a');
    this.#head = existsSync(this.#headPath)
      ? readFileSync(this.#headPath, 'utf8').slice(0, 64)
      : '0'.repeat(64);
  }

  get head() { return this.#head; }

  append(record) {
    const prev = this.#head;
    const hash = hashEntry(prev, record);
    const line = JSON.stringify({ ...record, prev_hash: prev, hash }) + '\n';
    writeSync(this.#fd, line);
    fsyncSync(this.#fd);
    this.#head = hash;
    writeSync(openSync(this.#headPath, 'w'), hash);
    return hash;
  }

  async *iterate() {
    const fd = openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      let pending = '';
      let pos = 0;
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        pending += buf.toString('utf8', 0, n);
        let nl;
        while ((nl = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (!line) continue;
          yield JSON.parse(line);
        }
      }
      if (pending) yield JSON.parse(pending);
    } finally {
      closeSync(fd);
    }
  }

  close() {
    closeSync(this.#fd);
  }
}

/** Walk the file and verify each link; returns the index of the first break or -1. */
export async function verify(path) {
  const chain = new AuditChain(path);
  let prev = '0'.repeat(64);
  let i = 0;
  try {
    for await (const entry of chain.iterate()) {
      const { prev_hash, hash, ...rest } = entry;
      if (prev_hash !== prev) return { ok: false, index: i, reason: 'prev_hash mismatch', expected: prev, got: prev_hash };
      const recomputed = hashEntry(prev, rest);
      if (recomputed !== hash) return { ok: false, index: i, reason: 'hash mismatch', expected: hash, got: recomputed };
      prev = hash;
      i++;
    }
    return { ok: true, count: i, head: prev };
  } finally {
    chain.close();
  }
}
