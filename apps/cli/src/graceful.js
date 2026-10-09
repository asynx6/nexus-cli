// @asynx6/cli graceful shutdown — wraps long-running subcommands (replay server,
// task run) so SIGTERM/SIGINT close cleanly instead of leaving ports bound.
//
// Usage:
//   const handle = installGracefulShutdown({ onClose: async () => {...} });
//   try { await longRunningWork(); } finally { await handle.close(); }
//
// The handler is re-entrant: a second signal forces exit(1) immediately.
// `uninstall()` removes the listeners (useful in tests).
import { makeLogger as defaultLogger } from '@asynx6/nexus-shared';

export function installGracefulShutdown({ onClose, logger = defaultLogger, exit = process.exit, signals = ['SIGTERM', 'SIGINT'], isActive = () => true } = {}) {
  if (typeof onClose !== 'function') throw new Error('installGracefulShutdown: onClose required');
  let triggered = false;
  let escalated = false;
  const close = async () => {
    if (!isActive()) return;
    if (triggered) {
      if (!escalated) {
        escalated = true;
        logger.warn('cli: escalation signal received, forcing exit');
        exit(1);
      }
      return;
    }
    triggered = true;
    try {
      await onClose();
    } catch (e) {
      logger.error('cli: onClose threw', { err: String(e?.message ?? e) });
      exit(1);
      return;
    }
    exit(0);
  };
  const handlers = signals.map((s) => {
    const h = () => { close().catch((e) => { logger.error('cli: shutdown error', { err: String(e?.message ?? e) }); exit(1); }); };
    process.on(s, h);
    return { signal: s, handler: h };
  });
  return {
    close,
    uninstall() {
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
    },
  };
}
