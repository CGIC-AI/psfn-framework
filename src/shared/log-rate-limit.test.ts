import { describe, expect, it, vi } from 'vitest';
import { createRateLimitedLogEmitter } from './log-rate-limit.js';

describe('createRateLimitedLogEmitter', () => {
  it('suppresses repeated emits per key within the configured window', () => {
    let now = 1_000;
    const emit = vi.fn();
    const rateLimitedLog = createRateLimitedLogEmitter({
      windowMs: 100,
      now: () => now,
    });

    expect(rateLimitedLog('discord.typing:missing-access', emit)).toBe(true);
    expect(rateLimitedLog('discord.typing:missing-access', emit)).toBe(false);
    expect(rateLimitedLog('discord.typing:rate-limit', emit)).toBe(true);

    now = 1_099;
    expect(rateLimitedLog('discord.typing:missing-access', emit)).toBe(false);

    now = 1_100;
    expect(rateLimitedLog('discord.typing:missing-access', emit)).toBe(true);

    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('evicts old keys so a bounded key map does not suppress fresh failures forever', () => {
    let now = 5_000;
    const emit = vi.fn();
    const rateLimitedLog = createRateLimitedLogEmitter({
      windowMs: 1_000,
      maxKeys: 1,
      now: () => now,
    });

    expect(rateLimitedLog('first', emit)).toBe(true);
    expect(rateLimitedLog('second', emit)).toBe(true);

    now = 5_500;
    expect(rateLimitedLog('first', emit)).toBe(true);

    expect(emit).toHaveBeenCalledTimes(3);
  });
});
