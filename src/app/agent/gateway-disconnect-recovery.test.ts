import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShutdownLogger } from '../startup/support/shutdown-helpers.js';
import { createGatewayDisconnectRecovery } from './gateway-disconnect-recovery.js';

function createLogger(): ShutdownLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('createGatewayDisconnectRecovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('withdraws readiness immediately, completes graceful shutdown, and exits for restart', async () => {
    const events: string[] = [];
    const exit = vi.fn();
    const recovery = createGatewayDisconnectRecovery({
      logger: createLogger(),
      withdrawReadiness: () => {
        events.push('not-ready');
      },
      runGracefulShutdown: async () => {
        events.push('shutdown');
      },
      exit,
      restartExitCode: 75,
      forceExitTimeoutMs: 1_000,
    });

    recovery({ source: 'close' });

    expect(events).toEqual(['not-ready', 'shutdown']);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(75);
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('accepts the full process exit-code range owned by the restart contract', async () => {
    for (const restartExitCode of [0, 255]) {
      const exit = vi.fn();
      const recovery = createGatewayDisconnectRecovery({
        logger: createLogger(),
        withdrawReadiness: vi.fn(),
        runGracefulShutdown: async () => undefined,
        exit,
        restartExitCode,
        forceExitTimeoutMs: 1_000,
      });

      recovery({ source: 'close' });
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(restartExitCode);
      });
    }
  });

  it('exits with the restart code when graceful shutdown rejects', async () => {
    const logger = createLogger();
    const exit = vi.fn();
    const recovery = createGatewayDisconnectRecovery({
      logger,
      withdrawReadiness: vi.fn(),
      runGracefulShutdown: async () => {
        throw new Error('release failed');
      },
      exit,
      restartExitCode: 75,
      forceExitTimeoutMs: 1_000,
    });

    recovery({ source: 'error', error: new Error('socket lost') });

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(75);
    });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Gateway disconnect graceful shutdown failed; forcing supervised restart',
      expect.objectContaining({
        error: 'Error: release failed',
        exitCode: 75,
      }),
    );
  });

  it('forces an exact-once restart when graceful shutdown never settles', async () => {
    vi.useFakeTimers();
    let resolveShutdown: (() => void) | undefined;
    const logger = createLogger();
    const withdrawReadiness = vi.fn();
    const runGracefulShutdown = vi.fn(() => new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    }));
    const exit = vi.fn();
    const recovery = createGatewayDisconnectRecovery({
      logger,
      withdrawReadiness,
      runGracefulShutdown,
      exit,
      restartExitCode: 75,
      forceExitTimeoutMs: 250,
    });

    recovery({ source: 'close' });
    recovery({ source: 'error', error: new Error('late duplicate') });

    expect(withdrawReadiness).toHaveBeenCalledTimes(1);
    expect(runGracefulShutdown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(251);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
    expect(logger.error).toHaveBeenCalledWith(
      'Gateway disconnect graceful shutdown timed out; forcing supervised restart',
      {
        exitCode: 75,
        timeoutMs: 250,
      },
    );

    resolveShutdown?.();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('continues toward restart if readiness withdrawal itself fails', async () => {
    const logger = createLogger();
    const exit = vi.fn();
    const recovery = createGatewayDisconnectRecovery({
      logger,
      withdrawReadiness: () => {
        throw new Error('listener close failed');
      },
      runGracefulShutdown: async () => undefined,
      exit,
      restartExitCode: 75,
      forceExitTimeoutMs: 1_000,
    });

    recovery({ source: 'close' });

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(75);
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to withdraw agent readiness after gateway disconnect',
      { error: 'Error: listener close failed' },
    );
  });
});

describe('agent gateway-disconnect wiring', () => {
  it('registers recovery before the identity handshake can observe a one-shot close', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const registrationIndex = mainSource.indexOf(
      'gateway.onDisconnect(gatewayDisconnectRecovery)',
    );
    const identifyIndex = mainSource.indexOf('await gateway.identifyAsAgent()');

    expect(registrationIndex).toBeGreaterThanOrEqual(0);
    expect(identifyIndex).toBeGreaterThanOrEqual(0);
    expect(registrationIndex).toBeLessThan(identifyIndex);
  });
});
