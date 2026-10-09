// ToolRegistry — name/description/schema/permission/timeout/handler per tool
// (plan P05). Registration is strict so bad definitions fail fast at boot,
// never mid-run.
import { validateArgs } from './schema.js';

export class ToolRegistry {
  #tools = new Map();

  /**
   * @param {{ name: string, description: string, schema: object,
   *   permission?: string, timeoutMs?: number,
   *   handler: (args: object, ctx: object) => Promise<object> }} def
   */
  register(def) {
    // 2..4 segments: fs.read, mcp.<server>.<tool> (3), future nesting (4)
    if (!def || typeof def.name !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/.test(def.name)) {
      throw new TypeError('tool name must be dot.separated_kind (e.g. fs.read)');
    }
    if (typeof def.description !== 'string' || !def.description) throw new TypeError(`tool ${def.name}: description required`);
    if (!def.schema || def.schema.type !== 'object') throw new TypeError(`tool ${def.name}: schema must be an object schema`);
    if (typeof def.handler !== 'function') throw new TypeError(`tool ${def.name}: handler must be a function`);
    if (this.#tools.has(def.name)) throw new Error(`tool already registered: ${def.name}`);
    this.#tools.set(def.name, Object.freeze({
      name: def.name,
      description: def.description,
      schema: def.schema,
      permission: def.permission ?? def.name,
      timeoutMs: def.timeoutMs ?? 30_000,
      handler: def.handler,
    }));
    return this;
  }

  get(name) { return this.#tools.get(name); }
  has(name) { return this.#tools.has(name); }
  list() { return [...this.#tools.values()]; }

  /** OpenAI-style tool specs for P06/P07 (provider-agnostic shape). */
  specs() {
    return this.list().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  }

  /** Run schema validation only (no permission logic) — used by the executor. */
  validate(name, args) {
    const tool = this.#tools.get(name);
    if (!tool) return [`unknown tool: ${name}`];
    return validateArgs(args ?? {}, tool.schema);
  }
}
