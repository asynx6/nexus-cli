// @asynx6/cli init — scaffold a new NEXUS project skeleton.
// Zero deps. Pure node:fs + node:path.
//
// Usage (called by cli.js dispatcher):
//   scaffoldProject({ target, answers, yes, stdout, stderr })
//
// answers shape: { name, scope, provider, sandbox }

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

// Cabinet name pattern: lowercase letters, digits, hyphen, underscore, dot.
// Rejects path traversal, shell metacharacters, whitespace.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SCOPE_RE = /^@[a-z0-9][a-z0-9._-]{0,38}$/;

export function parseInitArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  const name = positional[0];
  if (!name) throw new Error('project name required: nexus init <name> [--yes]');
  if (!NAME_RE.test(name)) throw new Error(`invalid project name: ${JSON.stringify(name)}`);
  return { name, yes: !!flags.yes };
}

function assertSafeName(name) {
  if (!NAME_RE.test(name)) throw new Error(`invalid project name: ${JSON.stringify(name)}`);
}

function assertSafeScope(scope) {
  if (!SCOPE_RE.test(scope)) throw new Error(`invalid npm scope: ${JSON.stringify(scope)}`);
}

function assertSafeProvider(p) {
  if (!NAME_RE.test(p)) throw new Error(`invalid provider: ${JSON.stringify(p)}`);
}

function assertSafeSandbox(s) {
  const allowed = new Set(['subprocess', 'docker', 'none']);
  if (!allowed.has(s)) throw new Error(`invalid sandbox mode: ${JSON.stringify(s)} (allowed: subprocess|docker|none)`);
}

function isDirEmpty(p) {
  if (!existsSync(p)) return true;
  const entries = readdirSync(p);
  return entries.length === 0;
}

const PKG_TEMPLATE = (name, scope, provider, sandbox) => `{
  "name": "${scope}/${name}",
  "version": "0.1.0",
  "private": true,
  "description": "NEXUS project: ${name}",
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "doctor": "nexus doctor",
    "init": "nexus init",
    "run": "nexus run"
  },
  "nexus": {
    "provider": "${provider}",
    "sandbox": "${sandbox}",
    "gateway": "https://api.asynx6.tech/v1"
  }
}
`;

const ENV_EXAMPLE = `# NEXUS gateway — copy to .env-gateway and fill values.
NEXUS_GATEWAY_BASE=https://api.asynx6.tech/v1
NEXUS_GATEWAY_KEY=sk-replace-me
NEXUS_GATEWAY_MODELS=hermes-agent
`;

const DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
CMD ["nexus", "run", "hello"]
`;

const README = (name) => `# ${name}

Scaffolded with \`nexus init\`.

## Quick start

\`\`\`bash
cp .env.example .env-gateway
# edit .env-gateway, set NEXUS_GATEWAY_KEY
npm install
npm run doctor
npm run -- run "your task here"
\`\`\`

## Layout

- \`apps/cli\` — agent CLI entry point
- \`packages/shared\` — shared ids + types

## Config

- Provider: hermes-agent (default)
- Sandbox: subprocess (default; switch to docker for isolation)
`;

const APPS_CLI_PKG = `{
  "name": "@asynx6/cli-app",
  "version": "0.1.0",
  "type": "module",
  "main": "src/cli.js",
  "private": true,
  "dependencies": {
    "@asynx6/cli": "*"
  }
}
`;

const SHARED_PKG = `{
  "name": "@asynx6/nexus-shared",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "private": true
}
`;

const SHARED_INDEX = `// @asynx6/shared — placeholder for shared ids + types.\nexport const NAME = '@asynx6/nexus-shared';\n`;

const GITIGNORE = `node_modules/
.env-gateway
*.log
dist/
`;

function writeFile(p, content) {
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

export async function scaffoldProject({ target, answers, yes, stdout = () => {}, stderr = () => {} }) {
  const name = answers.name;
  const scope = answers.scope;
  const provider = answers.provider;
  const sandbox = answers.sandbox;

  assertSafeName(name);
  assertSafeScope(scope);
  assertSafeProvider(provider);
  assertSafeSandbox(sandbox);

  const tgt = resolve(target);
  if (!isDirEmpty(tgt)) {
    throw new Error(`target ${tgt} already exists and is not empty`);
  }

  stdout(yes ? `[init] scaffolding ${name} (non-interactive)` : `[init] scaffolding ${name}`);
  mkdirSync(tgt, { recursive: true });

  writeFile(join(tgt, 'package.json'), PKG_TEMPLATE(name, scope, provider, sandbox));
  writeFile(join(tgt, '.env.example'), ENV_EXAMPLE);
  writeFile(join(tgt, 'Dockerfile'), DOCKERFILE);
  writeFile(join(tgt, 'README.md'), README(name));
  writeFile(join(tgt, '.gitignore'), GITIGNORE);

  writeFile(join(tgt, 'apps/cli/package.json'), APPS_CLI_PKG);
  writeFile(join(tgt, 'apps/cli/src/cli.js'), `// cli.js — extend or override here.\n`);
  writeFile(join(tgt, 'packages/shared/package.json'), SHARED_PKG);
  writeFile(join(tgt, 'packages/shared/index.js'), SHARED_INDEX);

  stdout(`[init] done. Next: cp .env.example .env-gateway && npm install`);
  return { target: tgt };
}

/** Interactive prompts for nexus init. Uses node:readline over stdin/stdout. */
export async function promptInitAnswers({ name, stdout = () => {}, stderr = () => {} }) {
  const rl = createInterface({ input, output, terminal: false });
  const ask = (q, def) => new Promise((resolvePrompt) => {
    stdout(`? ${q}${def !== undefined ? ` (${def})` : ''}: `);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        rl.off('line', onLine);
        rl.removeListener('line', onLine);
        const v = buf.trim() || (def !== undefined ? String(def) : '');
        resolvePrompt(v);
      }
    };
    const onLine = (line) => {
      const v = line.trim() || (def !== undefined ? String(def) : '');
      resolvePrompt(v);
    };
    rl.on('line', onLine);
  });

  try {
    const scope = await ask('npm scope (e.g. @my-org)', `@${name}`);
    const provider = await ask('LLM provider', 'hermes-agent');
    const sandbox = await ask('sandbox mode (subprocess|docker|none)', 'subprocess');
    return { name, scope, provider, sandbox };
  } finally {
    rl.close();
  }
}
