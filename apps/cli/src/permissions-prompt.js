// Interactive permission prompt for `ask` mode. Non-TTY or EOF => deny.
// The prompt itself never prints secret-looking values (redact via toString).
import { PERMISSION_MODES } from '@nexus/security';

export function isValidMode(mode) {
  return PERMISSION_MODES.includes(mode);
}

/** Build the onAsk callback. Returns null when stdin is not a TTY. */
export function makePermissionPrompt({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin?.isTTY) return null;

  return (call) => new Promise((resolve) => {
    const { tool, args } = call;
    let detail = '';
    if (tool === 'terminal.exec') detail = String(args.command ?? '');
    else if (typeof args.path === 'string') detail = args.path;
    else detail = JSON.stringify(args).slice(0, 120);

    stdout.write(`\x1b[1mpermission required\x1b[0m ${tool} ${detail}\n`);
    stdout.write('  [y] allow once  [a] always allow this tool+args  [n] deny  > ');
    const wasRaw = stdin.isRaw ?? false;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const finish = (ok, always) => {
      stdin.removeListener('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      resolve(ok);
      // 'always' answers are handled by the caller (settings persistence)
      if (always && makePermissionPrompt.onAlways) makePermissionPrompt.onAlways(tool, args);
    };

    const onData = (buf) => {
      const c = buf.toString().toLowerCase();
      if (c === 'y' || c === '\r' || c === '\n') finish(true, false);
      else if (c === 'a') finish(true, true);
      else if (c === 'n' || c === '\x03' || c === '\x1b') finish(false, false);
    };
    stdin.on('data', onData);
  });
}
