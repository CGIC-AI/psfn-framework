import type { ShutdownLogger } from './shutdown-helpers.js';

export interface SignalShutdownHandlerOptions {
  logger: ShutdownLogger;
  runGracefulShutdown: () => Promise<void>;
  exit: (code: number) => void;
  forceExitTimeoutMs: number;
}

export type SignalShutdownHandler = (signal: string) => Promise<void>;

export interface ProcessErrorHandlerOptions {
  logger: ShutdownLogger;
  /** Best-effort graceful shutdown trigger for uncaught exceptions. */
  requestShutdown?: () => void;
}

/**
 * Register top-level process error handlers exactly once per entrypoint.
 *
 * - unhandledRejection: log and continue. Fire-and-forget background paths
 *   (extraction, compaction, post-turn actions) must not crash the companion.
 * - uncaughtException: log and attempt graceful shutdown. After an uncaught
 *   exception the process state is undefined; the signal handler's force-exit
 *   timer guarantees termination even if graceful shutdown hangs.
 */
export function registerProcessErrorHandlers(options: ProcessErrorHandlerOptions): void {
  process.on('unhandledRejection', (reason) => {
    options.logger.error('Unhandled promise rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    options.logger.error('Uncaught exception', {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (options.requestShutdown) {
      options.requestShutdown();
    } else {
      process.exit(1);
    }
  });
}

export function createSignalShutdownHandler(
  options: SignalShutdownHandlerOptions,
): SignalShutdownHandler {
  const forceExitTimeoutMs = options.forceExitTimeoutMs;
  if (!Number.isInteger(forceExitTimeoutMs) || forceExitTimeoutMs <= 0) {
    throw new Error(`forceExitTimeoutMs must be a positive integer, got ${forceExitTimeoutMs}`);
  }

  let shutdownPromise: Promise<void> | null = null;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearForceExitTimer = (): void => {
    if (!forceExitTimer) return;
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  };

  const armForceExitTimer = (signal: string): void => {
    if (forceExitTimer) return;
    forceExitTimer = setTimeout(() => {
      options.logger.error('Graceful shutdown timed out; forcing exit', {
        signal,
        timeoutMs: forceExitTimeoutMs,
      });
      options.exit(1);
    }, forceExitTimeoutMs);
    forceExitTimer.unref();
  };

  return async (signal: string): Promise<void> => {
    if (shutdownPromise) {
      options.logger.warn('Shutdown already in progress; forcing exit on additional signal', { signal });
      options.exit(1);
      return;
    }

    armForceExitTimer(signal);

    shutdownPromise = (async () => {
      options.logger.info(`Received ${signal}, shutting down...`);
      await options.runGracefulShutdown();
      clearForceExitTimer();
      options.exit(0);
    })().catch((error) => {
      clearForceExitTimer();
      options.logger.error('Graceful shutdown failed; forcing exit', {
        signal,
        error: String(error),
      });
      options.exit(1);
    });

    await shutdownPromise;
  };
}
