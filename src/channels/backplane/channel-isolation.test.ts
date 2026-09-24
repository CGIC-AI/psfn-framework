import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelSurfaceSupervisor,
  type ChannelSurfaceFailure,
  type ChannelSurfaceRetryPolicy,
} from './channel-isolation.js';

function makeSupervisor(options: {
  retry?: Partial<ChannelSurfaceRetryPolicy>;
  isRetryable?: (error: Error) => boolean;
  report?: (failure: ChannelSurfaceFailure) => void | Promise<void>;
} = {}) {
  const failures: ChannelSurfaceFailure[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const supervisor = new ChannelSurfaceSupervisor({
    log,
    retry: { baseDelayMs: 100, maxDelayMs: 400, maxAttempts: 0, ...options.retry },
    isRetryable: options.isRetryable ?? (() => true),
    report: options.report ?? ((failure) => {
      failures.push(failure);
    }),
  });
  return { supervisor, failures, log };
}

describe('ChannelSurfaceSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a retryable start failure in the background with capped backoff', async () => {
    const { supervisor, failures, log } = makeSupervisor();
    const start = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(undefined);
    const cleanup = vi.fn(async () => undefined);
    const onStarted = vi.fn();

    // The first attempt is awaited; its failure does not reject the caller.
    await expect(supervisor.start({ surfaceId: 'discord', start, cleanup, onStarted }))
      .resolves.toBeUndefined();
    expect(supervisor.stateOf('discord')).toBe('degraded');
    expect(cleanup).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(399);
    expect(start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(4);

    expect(supervisor.stateOf('discord')).toBe('running');
    expect(onStarted).toHaveBeenCalledWith(4);
    expect(failures.map(failure => [failure.phase, failure.attempt, failure.terminal])).toEqual([
      ['start', 1, false],
      ['start', 2, false],
      ['start', 3, false],
    ]);
    expect(log.warn.mock.calls.map(call => (call[1] as { delayMs: number }).delayMs))
      .toEqual([100, 200, 400]);
  });

  it('disables a surface without retry when the error is not retryable', async () => {
    const { supervisor, failures } = makeSupervisor({ isRetryable: () => false });
    const start = vi.fn(async () => {
      throw new Error('401 Unauthorized');
    });
    await supervisor.start({ surfaceId: 'telegram', start });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(supervisor.stateOf('telegram')).toBe('disabled');
    expect(failures).toEqual([expect.objectContaining({ phase: 'start', terminal: true })]);
  });

  it('disables a surface once its owner-file retry budget is spent', async () => {
    const { supervisor, failures } = makeSupervisor({ retry: { maxAttempts: 2 } });
    const start = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await supervisor.start({ surfaceId: 'buzz', start });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledTimes(2);
    expect(supervisor.stateOf('buzz')).toBe('disabled');
    expect(failures.map(failure => failure.terminal)).toEqual([false, true]);
  });

  it('cancels a pending retry on stop and does not re-release a cleaned-up surface', async () => {
    const { supervisor } = makeSupervisor();
    const start = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const stop = vi.fn(async () => undefined);
    await supervisor.start({ surfaceId: 'multica', start, cleanup: stop });
    expect(stop).toHaveBeenCalledTimes(1);
    await supervisor.stop({ surfaceId: 'multica' }, stop);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(supervisor.stateOf('multica')).toBe('stopped');
  });

  it('reports a stop failure without rejecting', async () => {
    const { supervisor, failures } = makeSupervisor();
    await supervisor.start({ surfaceId: 'discord', start: async () => undefined });
    await expect(supervisor.stop({ surfaceId: 'discord' }, async () => {
      throw new Error('destroy failed');
    })).resolves.toBeUndefined();
    expect(failures).toEqual([expect.objectContaining({ phase: 'stop', terminal: false })]);
  });

  it('reports runtime failures without changing lifecycle state', async () => {
    const { supervisor, failures } = makeSupervisor();
    await supervisor.start({
      surfaceId: 'discord:alpha',
      companionId: '11111111-1111-4111-8111-111111111111' as never,
      start: async () => undefined,
    });
    supervisor.reportRuntimeFailure({ surfaceId: 'discord:alpha' }, new Error('gateway socket'));
    expect(supervisor.stateOf('discord:alpha')).toBe('running');
    expect(failures).toEqual([expect.objectContaining({
      surfaceId: 'discord:alpha',
      companionId: '11111111-1111-4111-8111-111111111111',
      phase: 'runtime',
      terminal: false,
    })]);
  });

  it('logs a failing reporter instead of letting it escape', async () => {
    const throwing = makeSupervisor({
      report: () => {
        throw new Error('health plane down');
      },
    });
    await expect(throwing.supervisor.init({ surfaceId: 'a' }, async () => {
      throw new Error('init failed');
    })).resolves.toBeUndefined();
    expect(throwing.log.error).toHaveBeenCalledWith(
      'Channel surface failure report failed',
      expect.objectContaining({ surfaceId: 'a', error: 'health plane down' }),
    );

    const rejecting = makeSupervisor({ report: async () => Promise.reject(new Error('bus closed')) });
    rejecting.supervisor.reportRuntimeFailure({ surfaceId: 'b' }, new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(rejecting.log.error).toHaveBeenCalledWith(
      'Channel surface failure report failed',
      expect.objectContaining({ surfaceId: 'b', error: 'bus closed' }),
    );
  });
});
