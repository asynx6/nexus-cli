// @asynx6/event-system — DB adapter factory.
// Routes a NEXUS_DB_URL to the matching driver (sqlite/postgres/mysql/mongo).
// Driver modules are dynamically imported so missing optional deps only
// surface when the user actually asks for that backend.

import { parseDbUrl as parseSqliteUrl, factory as sqliteFactory } from './sqlite.js';
import { parseDbUrl as parsePostgresUrl, factory as postgresFactory } from './postgres.js';
import { parseDbUrl as parseMysqlUrl, factory as mysqlFactory } from './mysql.js';
import { parseDbUrl as parseMongoUrl, factory as mongoFactory } from './mongo.js';

export const _drivers = {
  sqlite: { factory: sqliteFactory, parseUrl: parseSqliteUrl },
  postgres: { factory: postgresFactory, parseUrl: parsePostgresUrl },
  mysql: { factory: mysqlFactory, parseUrl: parseMysqlUrl },
  mongo: { factory: mongoFactory, parseUrl: parseMongoUrl },
};

export function _registerDriver(scheme, factory, parser) {
  _drivers[scheme] = { factory, parseUrl: parser };
}

const SCHEMES = ['sqlite', 'postgres', 'mysql', 'mongo'];

export function listSupportedSchemes() {
  return [...SCHEMES];
}

export function parseDbUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('parseDbUrl: url must be a non-empty string');
  }
  const colon = url.indexOf(':');
  if (colon === -1) throw new Error(`unsupported scheme: ${url}`);
  const scheme = url.slice(0, colon).toLowerCase();
  if (scheme === 'postgresql') {
    const d = _drivers.postgres;
    if (!d) throw new Error('unsupported scheme: postgresql');
    return d.parseUrl(url);
  }
  if (scheme === 'mongodb' || scheme === 'mongodb+srv') {
    const d = _drivers.mongo;
    if (!d) throw new Error('unsupported scheme: ' + scheme);
    return d.parseUrl(url);
  }
  const driver = _drivers[scheme];
  if (!driver) throw new Error(`unsupported scheme: ${scheme}`);
  if (typeof driver.parseUrl !== 'function') throw new Error(`unsupported scheme: ${scheme}`);
  return driver.parseUrl(url);
}

export async function createDbAdapter(url) {
  const effective = url ?? process.env.NEXUS_DB_URL ?? 'sqlite:./data/events.db';
  const parsed = parseDbUrl(effective);
  const driver = _drivers[parsed.scheme];
  if (!driver) throw new Error(`unsupported scheme: ${parsed.scheme}`);
  return await driver.factory(parsed);
}
