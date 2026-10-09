// @asynx6/event-system — MongoDB adapter (optional driver: `mongodb`).
// Throws a helpful message when `mongodb` is not installed.
const SCHEME = 'mongo';

export function parseDbUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'mongodb:' && u.protocol !== 'mongodb+srv:') {
    throw new Error(`mongo parser: expected mongodb: scheme, got ${u.protocol}`);
  }
  return {
    scheme: SCHEME,
    host: u.hostname,
    port: u.port ? Number(u.port) : 27017,
    database: u.pathname.replace(/^\//, '') || undefined,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    srv: u.protocol === 'mongodb+srv:',
  };
}

export async function factory(parsed) {
  let m;
  try {
    m = await import('mongodb');
  } catch {
    throw new Error(
      "mongodb driver not installed. Run `npm install mongodb` to enable mongodb:// URLs."
    );
  }
  const connStr = parsed.srv
    ? `mongodb+srv://${parsed.user}:${parsed.password}@${parsed.host}`
    : `mongodb://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}`;
  const client = new m.MongoClient(connStr);
  await client.connect();
  const db = client.db(parsed.database);
  return {
    driver: SCHEME,
    async query(sql, params = []) {
      // Mongo has no SQL; callers use `db.collection(name).find(...)` for reads.
      throw new Error("mongo adapter: use raw handle via .raw, not .query(sql)");
    },
    async exec(sql) {
      throw new Error("mongo adapter: use raw handle via .raw, not .exec(sql)");
    },
    raw: db,
    async close() {
      await client.close();
    },
  };
}

export default factory;
