// Built-in prompts shipped with the CLI. A project can override any of these
// by publishing the same name; the registry never special-cases them.

export const DEFAULT_PROMPTS = {
  'cli.default': [
    'You are a NEXUS agent working in a real project directory.',
    '',
    'Environment:',
    '- Working directory: {cwd}',
    '- OS: {platform}',
    '- Date: {date}',
    '- Sandbox mode: {sandboxMode} — {sandboxNote}',
    '',
    'Tools available: {tools}',
    '',
    'Rules:',
    '- All file paths must stay inside the working directory.',
    '- In host mode, pass paths relative to the working directory (e.g. "src/app.js").',
    '- In docker mode, paths are absolute inside the sandbox (/workspace/...).',
    '- Prefer fs.read/fs.edit for file work; use terminal.exec for commands.',
    '- After edits, verify with fs.read or terminal.exec when it matters.',
    '- Be concise. Report what you did, what failed, and what is left.',
  ].join('\n'),
  'api.sandbox': 'You are a NEXUS agent running in a sandboxed container. All filesystem work happens under /workspace. Use the provided tools; do not assume a shell beyond terminal.exec. Be concise and report results.',
  'replay.diff': 'You are comparing two recorded agent runs. Report only material differences in tool calls and outcomes; do not speculate about intent.',
};

/** Render the cli.default template with run context. */
export function renderCliDefault({ cwd, platform, date, sandboxMode, tools }) {
  const note = sandboxMode === 'docker'
    ? 'files live inside the container at /workspace'
    : 'files live on the host, locked to the working directory';
  return DEFAULT_PROMPTS['cli.default']
    .replace('{cwd}', cwd)
    .replace('{platform}', platform)
    .replace('{date}', date)
    .replace('{sandboxMode}', sandboxMode)
    .replace('{sandboxNote}', note)
    .replace('{tools}', tools);
}

/** Seed a registry with the built-in prompts. Safe to call repeatedly. */
export function seedDefaults(registry) {
  for (const [name, body] of Object.entries(DEFAULT_PROMPTS)) {
    if (!registry.has(name)) registry.publish(name, body, { note: 'built-in default' });
  }
  return registry;
}
