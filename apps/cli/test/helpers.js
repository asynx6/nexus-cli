import { FakeProvider } from '@asynx6/nexus-model-providers';
import * as cli from '../src/cli.js';

/**
 * Jalankan nexus CLI dengan FakeProvider & working dir temp.
 * @param {string|string[]} argv command line (termasuk 'nexus ...') atau argumen run
 * @param {object} options cwd, provider (array of turns), root
 * @returns {Promise<{exitCode:number, cwd:string, store?:object, provider:import('@asynx6/nexus-model-providers').FakeProvider}>}
 */
export async function runNexusCli(argvOrTask, options = {}) {
  const { cwd, storePath, ...rest } = options;
  const task = Array.isArray(argvOrTask) ? argvOrTask.join(' ') : argvOrTask;
  const fakeProvider = options.provider ?? new FakeProvider([]);
  const args = argvOrTask instanceof Array ? argvOrTask.slice(1) : task.split(' ');
  const workingCwd = cwd ?? process.cwd();
  const provider = Array.isArray(fakeProvider)
    ? new FakeProvider(fakeProvider)
    : fakeProvider;

  const ctx = {
    args,
    cwd: workingCwd,
    root: options.root ?? workingCwd,
    storePath: options.storePath ?? 'nexus-store.sqlite',
    bus: options.bus,
    store: options.store,
    provider,
    env: options.env ?? process.env,
    onEvent: options.onEvent,
  };
  const exitCode = await cli.runNexusCli(ctx);
  return { exitCode, cwd: workingCwd, provider };
}

/**
 * Jalankan di cwd temp, buat file fixture dulu, lalu hapus cwd setelahnya.
 * @param {function} fn
 */
export async function withTempCwd(fn, opts = {}) {
  const { tmpdir } = await import('node:os');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const tmpRoot = await mkdtemp(`${tmpdir}/nexus-fake-`);
  try {
    const cwd = opts.baseCwd ? `${tmpRoot}/${opts.baseCwd}` : tmpRoot;
    if (opts.baseCwd) await mkdir(cwd, { recursive: true });
    if (opts.files) {
      for (const [k, v] of Object.entries(opts.files)) {
        await writeFile(`${cwd}/${k}`, v);
      }
    }
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      return await fn({ cwd, tmpRoot, ...opts });
    } finally {
      process.chdir(orig);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
