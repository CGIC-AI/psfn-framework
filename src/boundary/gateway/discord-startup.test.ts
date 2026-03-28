import { describe, expect, it, vi } from 'vitest';
import {
  isRetryableDiscordStartError,
  startDiscordWithRetry,
} from './discord-startup.js';

describe('isRetryableDiscordStartError', () => {
  it('marks transient undici/connectivity failures as retryable', () => {
    const timeoutError = Object.assign(
      new Error('Connect Timeout Error (attempted address: discord.com:443, timeout: 10000ms)'),
      { code: 'UND_ERR_CONNECT_TIMEOUT' },
    );

    expect(isRetryableDiscordStartError(timeoutError)).toBe(true);
    expect(isRetryableDiscordStartError(new Error('network error while connecting'))).toBe(true);
  });

  it('marks 4xx auth failures as non-retryable', () => {
    const unauthorized = Object.assign(new Error('401 Unauthorized'), { status: 401 });
    expect(isRetryableDiscordStartError(unauthorized)).toBe(false);
  });
});

describe('startDiscordWithRetry', () => {
  it('retries transient startup failures and eventually succeeds', async () => {
    const start = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async (_delayMs: number) => {});
    const onRetry = vi.fn(async (_info: { attempt: number; delayMs: number; maxAttempts: number }) => {});

    await startDiscordWithRetry(start, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      sleep,
      onRetry,
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      delayMs: 10,
      maxAttempts: 3,
    }));
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('caps exponential backoff at maxDelayMs', async () => {
    const start = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async (_delayMs: number) => {});

    await startDiscordWithRetry(start, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 15,
      sleep,
    });

    expect(start).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([10, 15, 15]);
  });

  it('fails fast for non-retryable errors', async () => {
    const start = vi.fn<() => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    const sleep = vi.fn(async (_delayMs: number) => {});

    await expect(
      startDiscordWithRetry(start, { sleep }),
    ).rejects.toThrow('401 Unauthorized');

    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops retrying when maxAttempts is reached', async () => {
    const start = vi.fn<() => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }));
    const sleep = vi.fn(async (_delayMs: number) => {});

    await expect(
      startDiscordWithRetry(start, {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
        sleep,
      }),
    ).rejects.toThrow('connect timeout');

    expect(start).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
  });
});
