import { describe, expect, it, vi } from 'vitest';
import { HeadpatCoalescer } from './touch-interactions.js';

describe('headpat coalescing', () => {
  it('turns 12 rapid taps into one bounded interaction after the quiet window', () => {
    let now = 1_000;
    let nextHandle = 0;
    const callbacks = new Map<number, () => void>();
    const emit = vi.fn();
    const coalescer = new HeadpatCoalescer({
      emit,
      now: () => now,
      schedule: (callback) => {
        const handle = ++nextHandle;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel: (handle) => callbacks.delete(handle as number),
    });

    for (let index = 0; index < 12; index += 1) {
      coalescer.tap();
      now += 100;
    }

    expect(emit).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: 'headpat',
      region: 'head',
      count: 12,
      durationMs: 1_100,
    });
  });
});
