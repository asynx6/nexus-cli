// HTTP handlers for the MVP control plane (plan §15 subset + §11 events):
//   POST /tasks                 -> 202 + {id} (synchronous row insert; agent runs in background)
//   GET  /tasks                 -> 200 + list
//   GET  /tasks/:id             -> 200 + task record | 404
//   GET  /tasks/:id/events      -> SSE replay + live follow (event-system)
//   GET  /healthz               -> 200
//
// Concurrency contract (per Vinz 5e3bf2ad / 7:55): insert task row
// status=running + write task.started event SYNCHRONOUSLY before spawning
// AgentLoop.run(), so GET /tasks/:id never returns 404 between POST and
// spawn (no race). SecretStore handles the gateway key so the loop sees a
// working provider.

import { EVENTS, newAgentId, newTaskId } from '@asynx6/nexus-shared';
import { makeEvent } from '@asynx6/nexus-event-system';
import { sendJson } from './router.js';

const ALLOWED_TOOLS = new Set([
  'fs.read', 'fs.write', 'fs.edit', 'terminal.exec',
]);

/**
 * @param {{ store: import('./state.js').TaskStore, bus, eventStore,
 *   secrets, permissions, runtime, registry, executor, logger }} deps
 */
export function makeHandlers(deps) {
  const { store, bus, eventStore, secrets, permissions, runtime, registry, executor, logger } = deps;
  if (!store) throw new TypeError('store required');
  if (!bus) throw new TypeError('bus required');
  if (!eventStore) throw new TypeError('eventStore required');
  if (!secrets) throw new TypeError('secrets required');
  if (!permissions) throw new TypeError('permissions required');
  if (!runtime) throw new TypeError('runtime required');
  if (!registry) throw new TypeError('registry required');
  if (!executor) throw new TypeError('executor required');
  /** Build a ModelProvider pulling key from SecretStore (P04 isolation). */
  function providerFromEnv() {
    const mod = globalThis.__nexus_model_providers__;
    if (!mod) throw new Error("@asynx6/model-providers not loaded (server.js must run first)");
    const baseUrl = process.env.NEXUS_GATEWAY_BASE;
    if (!baseUrl) throw new Error("NEXUS_GATEWAY_BASE not set");
    const keyName = process.env.NEXUS_GATEWAY_KEY_NAME || "NEXUS_GATEWAY_KEY";
    if (!secrets.has(keyName)) throw new Error(`gateway key "${keyName}" not in SecretStore`);
    const apiKey = secrets.inject([keyName])[keyName];
    const models = (process.env.NEXUS_GATEWAY_MODELS || "hermes-agent").split(",").map((s) => s.trim()).filter(Boolean);
    return new mod.ModelProvider({ baseUrl, apiKey, models, timeoutMs: 90_000 });
  }

  return {
    healthz(ctx) {
      sendJson(ctx.res, 200, { ok: true, ts: new Date().toISOString() });
    },

    listTasks(ctx) {
      sendJson(ctx.res, 200, { tasks: store.list() });
    },

    async createTask(ctx) {
      const body = ctx.body ?? {};
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return sendJson(ctx.res, 400, { error: 'bad_request', message: 'prompt (non-empty string) required' });

      const requestedTools = Array.isArray(body.tools) ? body.tools : ['fs.read', 'fs.write', 'terminal.exec'];
      for (const t of requestedTools) {
        if (!ALLOWED_TOOLS.has(t)) return sendJson(ctx.res, 400, { error: 'bad_request', message: `unsupported tool: ${t}` });
      }
      const maxSteps = Number.isInteger(body.maxSteps) && body.maxSteps > 0 && body.maxSteps <= 64 ? body.maxSteps : 16;
      const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
      const system = typeof body.system === 'string' ? body.system : null;
      const requestedImage = typeof body.image === 'string' && body.image.length > 0 ? body.image : 'python:3.12-slim';

      const taskId = newTaskId();
      const agentId = newAgentId();

      // sandbox + tool setup (synchronous; we want the row visible before return)
      const sandboxId = await runtime.create({
        image: requestedImage,
        name: taskId,
        network: 'none',
        memoryMb: 256,
      });
      await runtime.start(sandboxId);

      // permission grants: sandbox filesystem under /workspace, terminal.exec unconstrained
      permissions.grant(agentId, 'fs.read', { paths: ['/workspace/**'] });
      permissions.grant(agentId, 'fs.write', { paths: ['/workspace/**'] });
      permissions.grant(agentId, 'fs.edit', { paths: ['/workspace/**'] });
      permissions.grant(agentId, 'terminal.exec', {});

      const record = store.create({
        taskId, agentId, sandboxId, prompt,
        model: model ?? (process.env.NEXUS_GATEWAY_MODELS || 'hermes-agent').split(',')[0].trim(),
        system, maxSteps, tools: requestedTools,
        permissions: permissions.listGrants(agentId),
      });

      // synchronous event writes (Vin z rule: row + task.started before spawn).
      // Task-level events use taskId as subject; sandbox events use sandboxId so
      // SSE filters by sandbox work and eventStore.replay({subject:sandboxId}) finds them.
      const taskRunId = taskId;
      bus.emit(makeEvent(EVENTS.TASK_CREATED, { prompt, agentId, model: record.model }, taskRunId));
      bus.emit(makeEvent(EVENTS.SANDBOX_CREATED, { image: requestedImage, sandboxId }, sandboxId));
      bus.emit(makeEvent(EVENTS.SANDBOX_STARTED, { sandboxId }, sandboxId));
      bus.emit(makeEvent(EVENTS.TASK_STARTED, { agentId, sandboxId }, taskRunId));

      // background loop spawn (fire-and-forget; tracked by store.holdRun for test shutdown)
      const { AgentLoop, loopTools } = globalThis.__nexus_agent_runtime__;
      const provider = providerFromEnv();
      const tools = loopTools({ registry, executor });
      const loop = new AgentLoop({
        provider, tools, permissions, audit: deps.audit, model: record.model,
      });

      const runPromise = (async () => {
        try {
          const result = await loop.run(prompt, {
            agentId, sandbox: sandboxId, maxSteps, system,
            runtime, sandboxId, bus, env: {}, permissions, audit: deps.audit,
          });
          store.finish(taskId, {
            status: result.done ? 'completed' : 'failed',
            answer: result.answer,
            steps: result.steps,
            error: result.done ? null : 'agent exhausted maxSteps without converging',
          });
          bus.emit(makeEvent(result.done ? EVENTS.TASK_COMPLETED : EVENTS.TASK_FAILED, {
            steps: result.steps, answerLength: (result.answer || '').length,
          }, taskRunId));
        } catch (e) {
          logger?.error?.('task crashed', { taskId, err: e?.message });
          store.finish(taskId, { status: 'failed', error: e?.message ?? String(e), steps: 0 });
          bus.emit(makeEvent(EVENTS.TASK_FAILED, { error: e?.message ?? 'unknown' }, taskRunId));
        } finally {
          // sandbox cleanup is server.js's job (lifecycle); we don't rm here
        }
      })();
      store.holdRun(runPromise);

      logger?.info?.('task accepted', { taskId, agentId, sandboxId });
      sendJson(ctx.res, 202, { id: taskId, agentId, sandboxId, status: 'running' });
    },

    getTask(ctx) {
      const rec = store.get(ctx.params.id);
      if (!rec) return sendJson(ctx.res, 404, { error: 'not_found' });
      sendJson(ctx.res, 200, rec);
    },

    /**
     * SSE stream of events for a task. Replay historical events (store) then
     * follow live events (bus). Filtered to subject == taskId or subject ==
     * agentId/sandboxId belonging to the task — keeps noise out and matches
     * the e2E test's expectations.
     */
    streamTaskEvents(ctx) {
      const rec = store.get(ctx.params.id);
      if (!rec) return sendJson(ctx.res, 404, { error: 'not_found' });

      const subjects = new Set([rec.id, rec.agentId, rec.sandboxId].filter(Boolean));
      const sinceSeq = Number(ctx.query.get('since')) || 0;
      const res = ctx.res;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': stream open\n\n');

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { res.end(); } catch { /* already */ }
      };

      // 1) replay historical events for the task
      try {
        for (const ev of eventStore.replay({ since: sinceSeq })) {
          if (!subjects.has(ev.subject)) continue;
          if (closed) return;
          res.write('data: ' + JSON.stringify(ev) + '\n\n');
        }
      } catch (e) {
        res.write('event: error\ndata: ' + JSON.stringify({ message: e.message }) + '\n\n');
        return close();
      }

      // 2) live follow via bus subscription; writes until client disconnects
      const off = bus.on('*', (ev) => {
        if (closed) return;
        if (!subjects.has(ev.subject)) return;
        try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); }
        catch { /* socket torn; off() runs from req 'close' */ }
      });

      // heartbeat keeps proxies from cutting the conn while the loop runs
      const beat = setInterval(() => {
        if (closed) return;
        try { res.write(': keep-alive\n\n'); } catch { clearInterval(beat); }
      }, 15_000);

      ctx.req.on('close', () => { off(); clearInterval(beat); close(); });
    },
  };
}
