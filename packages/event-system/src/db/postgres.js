// @asynx6/event-system — PostgreSQL adapter (optional driver: `pg`).
// Throws a helpful message when `pg` is not installed; users opt in via
// `npm install pg` then set NEXUS_DB_URL=postgres://...
const SCHEME = 'postgres';

export function parseDbUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`postgres parser: expected postgres: scheme, got ${u.protocol}`);
  }
  return {
    scheme: 'postgres',
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.replace(/^\//, '') || undefined,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

export async function factory(parsed) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error(
      "postgres driver not installed. Run `npm install pg` to enable postgres:// URLs."
    );
  }
  const client = new pg.Client({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
  });
  await client.connect();
  return {
    driver: SCHEME,
    async query(sql, params = []) {
      const r = await client.query(sql, params);
      return r.rows;
    },
    async exec(sql) {
      await client.query(sql);
    },
    async close() {
      await client.end();
    },
  };
}

export default factory;
