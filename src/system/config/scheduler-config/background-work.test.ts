import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
  validateBackgroundWorkWelfareConfig,
} from './background-work.js';

const SOURCE = 'scheduler.json';

describe('backgroundWorkWelfare.maxDefers (22ovy)', () => {
  it('defaults the preemption bound for an owner file written before it existed', () => {
    expect(validateBackgroundWorkWelfareConfig(
      { deferThreshold: 8, ageThresholdMs: 300_000, reserveSlots: 1 },
      SOURCE,
    )).toEqual(DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG);
    expect(validateBackgroundWorkWelfareConfig({}, SOURCE)).toEqual(DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG);
  });

  it('keeps an operator bound above the welfare threshold', () => {
    expect(validateBackgroundWorkWelfareConfig({ deferThreshold: 4, maxDefers: 5 }, SOURCE))
      .toMatchObject({ deferThreshold: 4, maxDefers: 5 });
  });

  it('refuses a bound that would end the loop before welfare admission is tried', () => {
    for (const maxDefers of [8, 3]) {
      expect(() => validateBackgroundWorkWelfareConfig({ deferThreshold: 8, maxDefers }, SOURCE))
        .toThrow(/maxDefers must be greater than backgroundWorkWelfare\.deferThreshold/u);
    }
    // An existing threshold at or above the default bound needs an explicit bound.
    expect(() => validateBackgroundWorkWelfareConfig({ deferThreshold: 16 }, SOURCE))
      .toThrow(/maxDefers must be greater/u);
    expect(() => validateBackgroundWorkWelfareConfig({ maxDefers: 0 }, SOURCE)).toThrow(/maxDefers/u);
  });
});
