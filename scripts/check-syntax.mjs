// lint — syntax-check every non-test module via node --check.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
const run = promisify(execFile);

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(`${e.parentPath ?? e.path}/${e.name}`);
  }
  return out;
}

let fail = 0;
const files = [
  'apps/cli/bin.mjs',
  ...(await jsFiles('packages')),
  ...(await jsFiles('scripts')),
  ...(await jsFiles('apps/cli/src')),
].filter((f) => !f.includes('node_modules') && !f.includes('/test/') && !f.includes('/vendor/'));
for (const f of files) {
  try { await run(process.execPath, ['--check', f]); }
  catch (e) { fail++; console.error(`${f}: ${e.message.split('\n')[0]}`); }
}
if (fail) process.exit(1);
console.log(`syntax OK (${files.length} files)`);
