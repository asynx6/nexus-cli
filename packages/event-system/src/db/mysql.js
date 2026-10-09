// @asynx6/event-system — MySQL adapter (optional driver: `mysql2`).
// Throws a helpful message when `mysql2` is not installed.
const SCHEME = 'mysql';

export function parseDbUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'mysql:') {
    throw new Error(`mysql parser: expected mysql: scheme, got ${u.protocol}`);
  }
  return {
    scheme: SCHEME,
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    database: u.pathname.replace(/^\//, '') || undefined,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

export async function factory(parsed) {
  let m2;
  try {
    m2 = await import('mysql2/promise');
  } catch {
    throw new Error(
      "mysql driver not installed. Run `npm install mysql2` to enable mysql:// URLs."
    );
  }
  const conn = await m2.createConnection({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
  });
  return {
    driver: SCHEME,
    async query(sql, params = []) {
      const [rows] = await conn.execute(sql, params);
      return Array.isArray(rows) ? rows : [];
    },
    async exec(sql) {
      await conn.query(sql);
    },
    async close() {
      await conn.end();
    },
  };
}

export default factory;
