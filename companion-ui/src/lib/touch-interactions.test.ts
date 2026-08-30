import { describe, expect, it, vi } from 'vitest';
import {
  HeadpatCoalescer,
  TouchInteractionCoalescer,
} from './touch-interactions.js';

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

  it('coalesces repeated avatar gestures into one typed upstream interaction', () => {
    let now = 5_000;
    let callback: (() => void) | undefined;
    const emit = vi.fn();
    const coalescer = new TouchInteractionCoalescer({
      emit,
      now: () => now,
      schedule: (scheduled) => {
        callback = scheduled;
        return 1;
      },
      cancel: () => {
        callback = undefined;
      },
    });

    coalescer.record({ kind: 'petting', region: 'head', durationMs: 180 });
    now += 220;
    coalescer.record({ kind: 'petting', region: 'head', durationMs: 260 });
    callback?.();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: 'petting',
      region: 'head',
      count: 2,
      durationMs: 260,
    });
  });

  it('does not merge different affection kinds into one ambiguous event', () => {
    const emit = vi.fn();
    const coalescer = new TouchInteractionCoalescer({
      emit,
      schedule: () => 1,
      cancel: () => undefined,
    });

    coalescer.record({ kind: 'hug', region: 'body', durationMs: 600 });
    coalescer.record({ kind: 'kiss', region: 'cheek', durationMs: 120 });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: 'hug',
      region: 'body',
      count: 1,
      durationMs: 600,
    });
  });
});
