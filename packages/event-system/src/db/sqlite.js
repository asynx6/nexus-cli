// @asynx6/event-system — SQLite adapter (default, zero-dep via node:sqlite).
// Schema lives on the adapter; EventStore keeps its own JSONL index when used
// as a primary store. The adapter here is the minimum contract other features
// can build on (audit log, multi-agent store, replay filter).
import { DatabaseSync } from 'node:sqlite';

const SCHEME = 'sqlite';

/** @param {string} url e.g. "sqlite:./data/events.db" or "sqlite://:memory:" */
export function parseDbUrl(url) {
  const rest = url.slice(SCHEME.length + 1);
  if (rest === '//:memory:') return { scheme: SCHEME, target: ':memory:' };
  if (rest.startsWith('//')) return { scheme: SCHEME, target: rest.slice(2) || ':memory:' };
  return { scheme: SCHEME, target: rest || ':memory:' };
}

/** @param {{target:string}} parsed */
export async function factory(parsed) {
  const target = parsed.target === ':memory:' ? ':memory:' : parsed.target;
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return {
    driver: SCHEME,
    raw: db,
    async query(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        if (/^\s*select/i.test(sql)) return stmt.all(...params);
        stmt.run(...params);
        return [];
      } finally {
        stmt.finalize?.();
      }
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}

export default factory;
