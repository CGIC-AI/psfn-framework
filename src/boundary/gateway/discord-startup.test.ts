import { describe, expect, it } from 'vitest';
import { isRetryableDiscordStartError } from './discord-startup.js';

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
