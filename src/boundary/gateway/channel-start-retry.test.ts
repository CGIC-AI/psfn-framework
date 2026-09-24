import { describe, expect, it } from 'vitest';
import {
  isRetryableChannelSurfaceStartError,
  resolveChannelSurfaceStartRetry,
} from './channel-start-retry.js';

describe('isRetryableChannelSurfaceStartError', () => {
  it('marks transient undici/connectivity failures as retryable', () => {
    const timeoutError = Object.assign(
      new Error('Connect Timeout Error (attempted address: discord.com:443, timeout: 10000ms)'),
      { code: 'UND_ERR_CONNECT_TIMEOUT' },
    );

    expect(isRetryableChannelSurfaceStartError(timeoutError)).toBe(true);
    expect(isRetryableChannelSurfaceStartError(new Error('network error while connecting'))).toBe(true);
  });

  it('marks 4xx auth failures as non-retryable', () => {
    const unauthorized = Object.assign(new Error('401 Unauthorized'), { status: 401 });
    expect(isRetryableChannelSurfaceStartError(unauthorized)).toBe(false);
  });
});

describe('resolveChannelSurfaceStartRetry (psfn-framework-hvyrl)', () => {
  it('reads the channel-surface variables with the unchanged defaults', () => {
    expect(resolveChannelSurfaceStartRetry({})).toEqual({ baseDelayMs: 2_000, maxDelayMs: 30_000, maxAttempts: 0 });
    expect(resolveChannelSurfaceStartRetry({
      CHANNEL_SURFACE_START_RETRY_BASE_DELAY_MS: '5',
      CHANNEL_SURFACE_START_RETRY_MAX_DELAY_MS: '50',
      CHANNEL_SURFACE_START_RETRY_MAX_ATTEMPTS: '4',
    })).toEqual({ baseDelayMs: 5, maxDelayMs: 50, maxAttempts: 4 });
  });

  it.each([
    'DISCORD_START_RETRY_BASE_DELAY_MS',
    'DISCORD_START_RETRY_MAX_DELAY_MS',
    'DISCORD_START_RETRY_MAX_ATTEMPTS',
  ])('refuses the retired %s instead of silently ignoring it', (name) => {
    expect(() => resolveChannelSurfaceStartRetry({ [name]: '3' }))
      .toThrow(new RegExp(`${name} was renamed to CHANNEL_SURFACE_START_RETRY_`));
  });
});
