import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSignalShutdownHandler,
  installSignalHandlers,
  registerProcessErrorHandlers,
} from './signal-shutdown.js';
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

  it('leaves the process running after failure and permits a later signal to retry', async () => {
    const logger = createLogger();
    let attempts = 0;
    const runGracefulShutdown = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
    });
    const exit = vi.fn();
    const shutdown = createSignalShutdownHandler({
      logger,
      runGracefulShutdown,
      exit,
      forceExitTimeoutMs: 1_000,
    });

    await shutdown('SIGTERM');

    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Graceful shutdown failed; leaving process running for retry',
      expect.objectContaining({
        signal: 'SIGTERM',
        error: 'Error: boom',
      }),
    );

    await shutdown('SIGTERM');
    expect(runGracefulShutdown).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not bypass an in-progress durable release on an additional signal', async () => {
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
      'Shutdown already in progress; waiting for its durable release',
      { signal: 'SIGTERM' },
    );
    expect(exit).not.toHaveBeenCalled();

    resolveShutdown?.();
    await first;
    expect(exit).toHaveBeenCalledWith(0);
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

describe('registerProcessErrorHandlers', () => {
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  it('logs unhandled rejections and keeps the process alive', () => {
    const logger = createLogger();
    const requestShutdown = vi.fn();
    registerProcessErrorHandlers({ logger, requestShutdown });

    process.emit('unhandledRejection', new Error('async boom'), Promise.resolve());

    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled promise rejection',
      expect.objectContaining({ reason: expect.stringContaining('async boom') }),
    );
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('logs uncaught exceptions and requests graceful shutdown', () => {
    const logger = createLogger();
    const requestShutdown = vi.fn();
    registerProcessErrorHandlers({ logger, requestShutdown });

    process.emit('uncaughtException', new Error('sync boom'));

    expect(logger.error).toHaveBeenCalledWith(
      'Uncaught exception',
      expect.objectContaining({ error: expect.stringContaining('sync boom') }),
    );
    expect(requestShutdown).toHaveBeenCalledTimes(1);
  });
});

describe('installSignalHandlers', () => {
  it('registers byte-preserving signal failure handling', async () => {
    const logger = createLogger();
    const shutdown = vi.fn(async () => {
      throw new Error('shutdown rejected');
    });
    const exit = vi.fn();
    const existingListeners = new Set(process.listeners('SIGINT'));

    installSignalHandlers(shutdown, logger, exit);
    const listener = process.listeners('SIGINT').find(candidate => !existingListeners.has(candidate));
    expect(listener).toBeDefined();

    try {
      listener?.('SIGINT');
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(1);
      });
      expect(shutdown).toHaveBeenCalledWith('SIGINT');
      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled SIGINT shutdown error',
        { error: 'Error: shutdown rejected' },
      );
    } finally {
      if (listener) process.removeListener('SIGINT', listener);
      const termListeners = process.listeners('SIGTERM');
      const addedTermListener = termListeners.at(-1);
      if (addedTermListener) process.removeListener('SIGTERM', addedTermListener);
    }
  });
});
