import { describe, expect, it } from 'vitest';
import { WorldAutonomyLimiter } from './world-autonomy-limiter.js';

describe('WorldAutonomyLimiter', () => {
  it('enforces a per-target cooldown', () => {
    const limiter = new WorldAutonomyLimiter();
    limiter.authorize('place:light', 1_000);
    expect(() => limiter.authorize('place:light', 5_000)).toThrow(/cooldown/);
    expect(() => limiter.authorize('place:light', 11_000)).not.toThrow();
  });

  it('caps autonomous actions per target per rolling hour', () => {
    const limiter = new WorldAutonomyLimiter();
    for (let index = 0; index < 20; index += 1) {
      limiter.authorize('place:light', index * 10_001);
    }
    expect(() => limiter.authorize('place:light', 20 * 10_001)).toThrow(/hourly limit/);
    expect(() => limiter.authorize('other:light', 20 * 10_001)).not.toThrow();
  });
});
