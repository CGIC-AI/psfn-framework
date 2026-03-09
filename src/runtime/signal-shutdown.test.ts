import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSignalShutdownHandler } from './signal-shutdown.js';
import type { ShutdownLogger } from './shutdown-helpers.js';

function createLogger(): ShutdownLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('createSignalShutdownHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs graceful shutdown and exits with code 0', async () => {
    const logger = createLogger();
    const runGracefulShutdown = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createSignalShutdownHandler({
      logger,
      runGracefulShutdown,
      exit,
      forceExitTimeoutMs: 1_000,
    });

    await shutdown('SIGTERM');

    expect(runGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Received SIGTERM, shutting down...');
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces exit with code 1 when graceful shutdown throws', async () => {
    const logger = createLogger();
    const runGracefulShutdown = vi.fn(async () => {
      throw new Error('boom');
    });
    const exit = vi.fn();
    const shutdown = createSignalShutdownHandler({
      logger,
      runGracefulShutdown,
      exit,
      forceExitTimeoutMs: 1_000,
    });

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Graceful shutdown failed; forcing exit',
      expect.objectContaining({
        signal: 'SIGTERM',
        error: 'Error: boom',
      }),
    );
  });

  it('forces exit immediately on additional signal while shutdown is in progress', async () => {
    const logger = createLogger();
    let resolveShutdown: (() => void) | null = null;
    const runGracefulShutdown = vi.fn(() => new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    }));
    const exit = vi.fn();
    const shutdown = createSignalShutdownHandler({
      logger,
      runGracefulShutdown,
      exit,
      forceExitTimeoutMs: 10_000,
    });

    const first = shutdown('SIGTERM');
    await Promise.resolve();

    await shutdown('SIGTERM');

    expect(logger.warn).toHaveBeenCalledWith(
      'Shutdown already in progress; forcing exit on additional signal',
      { signal: 'SIGTERM' },
    );
    expect(exit).toHaveBeenCalledWith(1);

    resolveShutdown?.();
    await first;
  });

  it('forces exit when graceful shutdown exceeds timeout', async () => {
    vi.useFakeTimers();

    const logger = createLogger();
    const runGracefulShutdown = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const shutdown = createSignalShutdownHandler({
      logger,
      runGracefulShutdown,
      exit,
      forceExitTimeoutMs: 250,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(251);

    expect(logger.error).toHaveBeenCalledWith(
      'Graceful shutdown timed out; forcing exit',
      { signal: 'SIGTERM', timeoutMs: 250 },
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('rejects non-positive force-exit timeout values', () => {
    const logger = createLogger();
    expect(() => createSignalShutdownHandler({
      logger,
      runGracefulShutdown: async () => undefined,
      exit: () => undefined,
      forceExitTimeoutMs: 0,
    })).toThrow('forceExitTimeoutMs must be a positive integer');
  });
});
