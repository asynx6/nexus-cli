// @asynx6/tool-system auto-discovery — register tools without a manual list.
//
// Three sources, in priority order (first registration wins, later duplicates
// are skipped so an explicit project tool always beats a package one):
//   1. explicit tools passed by the caller (already registered by ctx)
//   2. *.tools.js files under .nexus/tools/ in the project
//   3. @asynx6/tool-* dependencies listed in package.json, exporting { tools }
//
// (2) and (3) are the auto part: drop a file or install a package and the
// tool is available on the next run. Discovery errors never abort the run.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOLS_DIR = '.nexus/tools';
const TOOL_PKG_PREFIX = '@asynx6/tool-';

/** Read package.json deps that look like tool packages. */
export function discoverToolPackages(pkgPath = 'package.json') {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.keys(deps).filter((d) => d.startsWith(TOOL_PKG_PREFIX));
  } catch { return []; }
}

/** Collect *.tools.js paths under <dir>/.nexus/tools (shallow). */
export function discoverToolFiles(cwd = process.cwd()) {
  const dir = join(cwd, TOOLS_DIR);
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  return ents
    .filter((e) => e.isFile() && (e.name.endsWith('.tools.js') || e.name.endsWith('.tools.mjs')))
    .map((e) => join(dir, e.name));
}

/**
 * Load tool definitions from files + packages and register the new ones.
 * @param {object} registry a ToolRegistry (uses .has/.register)
 * @param {{ cwd?: string, pkgPath?: string }} [opts]
 * @returns {Promise<{ registered: string[], skipped: { source: string, reason: string }[], errors: { source: string, error: string }[] }>}
 */
export async function autoDiscoverTools(registry, opts = {}) {
  const { cwd = process.cwd(), pkgPath } = opts;
  const registered = [];
  const skipped = [];
  const errors = [];

  const sources = discoverToolFiles(cwd).map((p) => ({ source: p, load: () => import(pathToFileURL(p).href) }));
  for (const name of discoverToolPackages(pkgPath ?? join(cwd, 'package.json'))) {
    sources.push({ source: name, load: () => import(name) });
  }

  for (const { source, load } of sources) {
    let mod;
    try { mod = await load(); }
    catch (e) { errors.push({ source, error: String(e.message || e) }); continue; }

    const tools = typeof mod.tools === 'function' ? mod.tools() : mod.tools;
    if (!Array.isArray(tools)) { errors.push({ source, error: 'module must export a tools array or tools() function' }); continue; }

    for (const t of tools) {
      if (!t || typeof t.name !== 'string') { skipped.push({ source, reason: 'tool without a name' }); continue; }
      if (registry.has(t.name)) { skipped.push({ source: t.name, reason: 'already registered' }); continue; }
      try { registry.register(t); registered.push(t.name); }
      catch (e) { errors.push({ source: t.name, error: String(e.message || e) }); }
    }
  }
  return { registered, skipped, errors };
}
