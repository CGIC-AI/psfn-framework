import { describe, expect, it, vi } from 'vitest';
import {
  runShutdownSequence,
  type ShutdownLogger,
} from './shutdown-helpers.js';

function createLogger(): ShutdownLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('runShutdownSequence', () => {
  it('runs shutdown steps in order', async () => {
    const logger = createLogger();
    const calls: string[] = [];

    await runShutdownSequence([
      {
        step: 'first',
        action: () => {
          calls.push('first');
        },
      },
      {
        step: 'second',
        action: async () => {
          calls.push('second');
        },
      },
    ], logger);

    expect(calls).toEqual(['first', 'second']);
  });

  it('continues to later steps after a failed shutdown step', async () => {
    const logger = createLogger();
    const calls: string[] = [];

    await runShutdownSequence([
      {
        step: 'fails',
        action: () => {
          calls.push('fails');
          throw new Error('boom');
        },
        maxAttempts: 1,
      },
      {
        step: 'after-failure',
        action: () => {
          calls.push('after-failure');
        },
      },
    ], logger);

    expect(calls).toEqual(['fails', 'after-failure']);
    expect(logger.error).toHaveBeenCalledWith(
      'Shutdown step failed; continuing shutdown',
      expect.objectContaining({
        step: 'fails',
        attempt: 1,
        maxAttempts: 1,
        error: 'Error: boom',
      }),
    );
  });

  it('honors per-step retry counts', async () => {
    const logger = createLogger();
    const flakyAction = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce();

    await runShutdownSequence([
      {
        step: 'flaky',
        action: flakyAction,
        maxAttempts: 2,
      },
    ], logger);

    expect(flakyAction).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Shutdown step failed; retrying',
      expect.objectContaining({
        step: 'flaky',
        attempt: 1,
        maxAttempts: 2,
        error: 'Error: first failure',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Shutdown step recovered after retry',
      expect.objectContaining({
        step: 'flaky',
        attempt: 2,
        maxAttempts: 2,
      }),
    );
  });
});
