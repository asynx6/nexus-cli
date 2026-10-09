// @asynx6/api graceful shutdown — SIGTERM/SIGINT triggers orderly close:
//   1. Stop accepting new connections (server.close)
//   2. Drain in-flight task runs (taskStore.drain)
//   3. Close the EventStore (flush + release fd)
//   4. exit(0)
//
// Re-entrancy: a second signal escalates to immediate exit(1). Users get
// one chance for a clean shutdown; a stuck task won't trap the process
// forever.
import { makeLogger as defaultLogger } from '@asynx6/nexus-shared';

export function installGracefulShutdown({ app, http, logger = defaultLogger, exit = process.exit, signals = ['SIGTERM', 'SIGINT'] } = {}) {
  if (!app) throw new Error('installGracefulShutdown: app required');
  let shuttingDown = false;
  let escalated = false;
  const close = async () => {
    if (shuttingDown) {
      if (!escalated) {
        escalated = true;
        logger.warn('shutdown: escalation signal received, forcing exit');
        exit(1);
      }
      return;
    }
    shuttingDown = true;
    logger.info('shutdown: starting');
    try {
      if (http?.server) {
        await new Promise((r) => http.server.close(() => r()));
        logger.info('shutdown: http closed');
      }
    } catch (e) {
      logger.warn('shutdown: http close error', { err: String(e?.message ?? e) });
    }
    try {
      await app.taskStore.drain();
      logger.info('shutdown: tasks drained');
    } catch (e) {
      logger.warn('shutdown: drain error', { err: String(e?.message ?? e) });
    }
    try {
      app.eventStore.close();
      logger.info('shutdown: store closed');
    } catch (e) {
      logger.warn('shutdown: store close error', { err: String(e?.message ?? e) });
    }
    logger.info('shutdown: complete');
    exit(0);
  };
  const handlers = signals.map((s) => {
    const h = () => { close().catch((e) => { logger.error('shutdown: unexpected', { err: String(e?.message ?? e) }); exit(1); }); };
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
