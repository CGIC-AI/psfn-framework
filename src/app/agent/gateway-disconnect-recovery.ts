import type { GatewayConnectionCloseEvent } from '../../boundary/gateway/client.js';
import type { ShutdownLogger } from '../startup/support/shutdown-helpers.js';

export interface GatewayDisconnectRecoveryOptions {
  logger: ShutdownLogger;
  withdrawReadiness: () => void;
  runGracefulShutdown: () => Promise<void>;
  exit: (code: number) => void;
  restartExitCode: number;
  forceExitTimeoutMs: number;
}

export type GatewayDisconnectRecovery = (event: GatewayConnectionCloseEvent) => void;

/**
 * Fail closed after an authenticated gateway connection is lost.
 *
 * GatewayClient intentionally has no in-process reconnect: the supervisor must
 * start a fresh agent so gateway.client.identify runs again. Readiness is
 * withdrawn synchronously, while the remaining cleanup receives one bounded
 * opportunity to finish before the restart-contract exit is forced.
 */
export function createGatewayDisconnectRecovery(
  options: GatewayDisconnectRecoveryOptions,
): GatewayDisconnectRecovery {
  if (!Number.isInteger(options.restartExitCode)
    || options.restartExitCode < 0
    || options.restartExitCode > 255) {
    throw new Error(
      `restartExitCode must be an integer from 0 to 255, got ${options.restartExitCode}`,
    );
  }
  if (!Number.isInteger(options.forceExitTimeoutMs) || options.forceExitTimeoutMs <= 0) {
    throw new Error(
      `forceExitTimeoutMs must be a positive integer, got ${options.forceExitTimeoutMs}`,
    );
  }

  let recoveryStarted = false;
  let exitRequested = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const requestExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    options.exit(options.restartExitCode);
  };

  return (event): void => {
    if (recoveryStarted) {
      options.logger.warn('Gateway disconnect recovery already in progress; ignoring duplicate', {
        source: event.source,
        error: event.error?.message,
      });
      return;
    }
    recoveryStarted = true;

    options.logger.error(
      'Gateway connection lost; withdrawing readiness and restarting agent process',
      {
        source: event.source,
        error: event.error?.message,
        exitCode: options.restartExitCode,
        timeoutMs: options.forceExitTimeoutMs,
      },
    );
    try {
      options.withdrawReadiness();
    } catch (error) {
      options.logger.error('Failed to withdraw agent readiness after gateway disconnect', {
        error: String(error),
      });
    }

    forceExitTimer = setTimeout(() => {
      options.logger.error(
        'Gateway disconnect graceful shutdown timed out; forcing supervised restart',
        {
          exitCode: options.restartExitCode,
          timeoutMs: options.forceExitTimeoutMs,
        },
      );
      requestExit();
    }, options.forceExitTimeoutMs);
    // Keep this timer referenced: once readiness and the gateway listener are
    // gone, a never-settling Promise may be the only remaining shutdown work.
    // The process must still reach the supervised-restart exit code.

    void (async () => {
      try {
        await options.runGracefulShutdown();
        options.logger.info(
          'Gateway disconnect graceful shutdown completed; exiting for supervised restart',
          { exitCode: options.restartExitCode },
        );
      } catch (error) {
        options.logger.error(
          'Gateway disconnect graceful shutdown failed; forcing supervised restart',
          {
            error: String(error),
            exitCode: options.restartExitCode,
          },
        );
      }
      requestExit();
    })();
  };
}
