import { createHash } from 'node:crypto';
import type { ShutdownLogger } from './shutdown-helpers.js';
import { recordLifecycleDiagnosticEvent } from '../../../shared/diagnostics/runtime-diagnostics.js';

export interface SignalShutdownHandlerOptions {
  logger: ShutdownLogger;
  runGracefulShutdown: () => Promise<void>;
  exit: (code: number) => void;
  forceExitTimeoutMs: number;
}

export type SignalShutdownHandler = (signal: string) => Promise<void>;
export type SignalExit = (code: number) => void;

export interface ProcessErrorHandlerOptions {
  logger: ShutdownLogger;
  /** Best-effort graceful shutdown trigger for uncaught exceptions. */
  requestShutdown?: () => void;
  /**
   * Consecutive rejections from one content-free origin fingerprint before a
   * bounded Garden runtime-diagnostics escalation is recorded. Must be greater
   * than one so an isolated rejection remains log-only.
   */
  backgroundFailureEscalationThreshold: number | undefined;
}

function fingerprintUnhandledRejectionOrigin(reason: unknown): string {
  let identity: string;
  if (reason instanceof Error) {
    const firstFrame = reason.stack
      ?.split('\n')
      .map(line => line.trim())
      .find(line => line.startsWith('at '));
    identity = `${reason.name}:${firstFrame ?? reason.message}`;
  } else {
    identity = `${typeof reason}:${String(reason)}`;
  }
  return createHash('sha256').update(identity).digest('hex');
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
  const failureThreshold = options.backgroundFailureEscalationThreshold;
  if (
    typeof failureThreshold !== 'number'
    || !Number.isInteger(failureThreshold)
    || failureThreshold <= 1
  ) {
    throw new Error(
      'backgroundFailureEscalationThreshold must be an integer greater than one, '
      + `got ${String(failureThreshold)}`,
    );
  }

  let activeOriginFingerprint: string | null = null;
  let consecutiveFailures = 0;
  let escalationRecorded = false;

  process.on('unhandledRejection', (reason) => {
    options.logger.error('Unhandled promise rejection', { reason: String(reason) });

    const originFingerprint = fingerprintUnhandledRejectionOrigin(reason);
    if (originFingerprint === activeOriginFingerprint) {
      consecutiveFailures += 1;
    } else {
      activeOriginFingerprint = originFingerprint;
      consecutiveFailures = 1;
      escalationRecorded = false;
    }

    if (consecutiveFailures < failureThreshold || escalationRecorded) return;

    escalationRecorded = true;
    recordLifecycleDiagnosticEvent({
      event: 'process.unhandled_rejection.escalated',
      component: 'process',
      message: 'Repeated unhandled promise rejections crossed the escalation threshold',
      details: {
        consecutiveFailures,
        failureThreshold,
        originFingerprint,
      },
    });
    options.logger.error('Persistent background failure escalated to runtime diagnostics', {
      consecutiveFailures,
      failureThreshold,
      originFingerprint,
    });
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
      options.logger.warn('Shutdown already in progress; waiting for its durable release', { signal });
      return;
    }

    armForceExitTimer(signal);

    const attempt = (async () => {
      options.logger.info(`Received ${signal}, shutting down...`);
      await options.runGracefulShutdown();
      clearForceExitTimer();
      options.exit(0);
    })();
    shutdownPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      clearForceExitTimer();
      options.logger.error('Graceful shutdown failed; leaving process running for retry', {
        signal,
        error: String(error),
      });
      if (shutdownPromise === attempt) shutdownPromise = null;
    }
  };
}

export function installSignalHandlers(
  shutdown: SignalShutdownHandler,
  logger: ShutdownLogger,
  exit: SignalExit = code => process.exit(code),
): void {
  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      logger.error('Unhandled SIGINT shutdown error', { error: String(error) });
      exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      logger.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      exit(1);
    });
  });
}
