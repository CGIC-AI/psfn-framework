import { describe, expect, it, vi } from 'vitest';
import { reconcileConcernResolutionArcsAtStartup } from './concern-resolution-arc-startup.js';

describe('concern resolution arc startup reconciliation', () => {
  it('completes successful reconciliation without logging an error', async () => {
    const logger = { error: vi.fn() };
    const concernStore = {
      getById: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    };

    await expect(reconcileConcernResolutionArcsAtStartup({
      concernStore,
      recorder: vi.fn(async () => undefined),
      logger,
    })).resolves.toBeUndefined();

    expect(concernStore.list).toHaveBeenCalledWith({
      includeResolved: true,
      includeExpired: true,
      limit: 200,
      offset: 0,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a reconciliation failure and allows startup to continue', async () => {
    const failure = new Error('transient concern-store failure');
    const logger = { error: vi.fn() };
    const concernStore = {
      getById: vi.fn(async () => undefined),
      list: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(reconcileConcernResolutionArcsAtStartup({
      concernStore,
      recorder: vi.fn(async () => undefined),
      logger,
    })).resolves.toBeUndefined();

    expect(concernStore.list).toHaveBeenCalledWith({
      includeResolved: true,
      includeExpired: true,
      limit: 200,
      offset: 0,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Concern resolution arc startup reconciliation failed; continuing startup',
      { error: failure.message, stack: failure.stack },
    );
  });
});
