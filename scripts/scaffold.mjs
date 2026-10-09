// generate workspace skeletons (P00). Run once; idempotent-ish (skips existing).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pkgs = {
  'packages/shared': 'schemas, ids, env loader, logger, constants — single source for all cross-package contracts',
  'packages/event-system': 'EventBus + append-only EventStore (JSONL + SQLite index), replay iterator',
  'packages/sandbox-runtime': 'SandboxRuntime interface + DockerRuntime (Engine API over unix socket), limits, network policy',
  'packages/tool-system': 'ToolRegistry + filesystem/terminal tools wired through permissions + events',
  'packages/model-providers': 'ModelProvider interface + openai-compatible & anthropic-compatible adapters',
  'packages/agent-runtime': 'agent loop: observe → plan → tool → execute → memory-update → continue',
  'packages/security': 'PermissionManager (deny-by-default) + audit events + secret isolation',
  'packages/memory': 'short/long/project memory abstraction, pluggable storage (v0.3)',
  'apps/api': 'REST control plane (agents/sandboxes/tasks/events/logs/models) + bootstrap wiring',
  'apps/cli': 'nexus command: agent/sandbox/task/logs/events',
};

for (const [dir, desc] of Object.entries(pkgs)) {
  const name = dir.split('/').pop();
  const pkgJson = join(dir, 'package.json');
  if (!existsSync(pkgJson)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pkgJson,
      JSON.stringify(
        {
          name: '@asynx6/' + name,
          version: '0.0.1',
          private: true,
          type: 'module',
          main: 'index.js',
          exports: { '.': './index.js' },
          description: desc,
          scripts: { test: `node --test ${dir === 'apps/cli' ? '' : ''}test/` },
        },
        null,
        2,
      ) + '\n',
    );
  }
  const idx = join(dir, 'index.js');
  if (!existsSync(idx)) {
    writeFileSync(idx, `// @asynx6/${name} — ${desc}\n// public facade: export ONLY contracts here (see docs/ARCHITECTURE.md rule 4)\nexport const NAME = '@asynx6/${name}';\n`);
  }
  mkdirSync(join(dir, 'test'), { recursive: true });
  const t = join(dir, 'test', 'smoke.test.js');
  if (!existsSync(t)) {
    writeFileSync(t, `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { NAME } from '../index.js';\n\ntest('${name} skeleton loads', () => {\n  assert.strictEqual(NAME, '@asynx6/${name}');\n});\n`);
  }
  console.log('ok', dir);
}
