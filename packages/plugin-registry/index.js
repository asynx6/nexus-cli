// @asynx6/plugin-registry — discover and load third-party tool plugins.
// A plugin is any module exporting { name, tools?(), hooks? }.
//
// Discovery order per directory: <dir>/*.js, then <dir>/<name>/index.js.
// Plugins are loaded with a dynamic import of the resolved path, so a broken
// plugin never takes down the host — it is reported in the result instead.
//
// Zero deps. Node >= 22 ESM.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Find candidate plugin entry paths in a directory. */
export function discoverPlugins(dir) {
  const out = [];
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch { return out; } // missing/unreadable dir is not fatal
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.name.endsWith('.js') && ent.isFile()) out.push(p);
    else if (ent.isDirectory()) {
      const idx = join(p, 'index.js');
      if (existsSync(idx)) out.push(idx);
    }
  }
  return out;
}

/**
 * Load plugins from one or more directories and collect their tool definitions.
 * @param {string[]} dirs
 * @returns {Promise<{ plugins: Array<{ name: string, path: string, tools: any[] }>, errors: Array<{ path: string, error: string }> }>}
 */
export async function loadPlugins(dirs) {
  const plugins = [];
  const errors = [];
  const seen = new Set();
  for (const d of dirs) {
    for (const path of discoverPlugins(d)) {
      const abs = resolve(path);
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        const mod = await import(pathToFileURL(abs).href);
        const name = mod.name ?? abs.split(/[\\/]/).slice(-1)[0].replace(/\.js$/, '');
        if (typeof mod.name !== 'string' || !mod.name) {
          throw new Error('plugin must export a non-empty "name" string');
        }
        const tools = typeof mod.tools === 'function' ? await mod.tools() : [];
        if (!Array.isArray(tools)) throw new Error('plugin.tools() must return an array');
        plugins.push({ name, path: abs, tools });
      } catch (e) {
        errors.push({ path: abs, error: String(e.message || e) });
      }
    }
  }
  return { plugins, errors };
}

/**
 * Register all tools from loaded plugins into a tool registry.
 * Skips (reports) any tool whose name collides with an existing one.
 * @returns {{ registered: number, skipped: Array<{ plugin: string, tool: string, reason: string }> }}
 */
export function registerPluginTools(plugins, registry) {
  const registered = [];
  const skipped = [];
  for (const pl of plugins) {
    for (const t of pl.tools) {
      if (!t || typeof t.name !== 'string') {
        skipped.push({ plugin: pl.name, tool: '(unnamed)', reason: 'tool missing a name' });
        continue;
      }
      if (registry.has(t.name)) {
        skipped.push({ plugin: pl.name, tool: t.name, reason: 'name already registered' });
        continue;
      }
      registry.register(t);
      registered.push(t.name);
    }
  }
  return { registered, skipped };
}
