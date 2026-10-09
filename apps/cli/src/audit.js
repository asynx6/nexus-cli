// @asynx6/cli audit subcommand — verify the hash chain of an audit log.
// Usage: nexus audit verify [--file=PATH]
import { verify } from '@asynx6/nexus-audit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_FILE = './audit.jsonl';

export async function runAudit(argv, env = process.env, stdout = console.log, stderr = console.error) {
  if (argv.length === 0 || argv[0] !== 'verify') {
    stderr('audit: only `audit verify` is supported; got: ' + (argv[0] ?? ''));
    return 2;
  }
  // parse --file= or --file PATH
  let file = DEFAULT_FILE;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--file=')) file = a.slice('--file='.length);
    else if (a === '--file' && i + 1 < argv.length) file = argv[++i];
  }
  file = resolve(process.cwd(), file);
  if (!existsSync(file)) {
    stderr(`audit: file not found: ${file}`);
    return 2;
  }
  let result;
  try { result = await verify(file); }
  catch (e) { stderr('audit: ' + e.message); return 1; }
  if (result.ok) {
    stdout(`audit verify ok: count=${result.count} head=${result.head}`);
    return 0;
  }
  stderr(`audit verify FAILED at index ${result.index}: ${result.reason}`);
  if (result.expected !== undefined && result.got !== undefined) {
    stderr(`  expected: ${result.expected}`);
    stderr(`  got:      ${result.got}`);
  }
  return 1;
}
