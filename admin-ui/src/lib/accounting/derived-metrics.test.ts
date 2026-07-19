import { describe, expect, it } from 'vitest';
import {
  blendedCostPerMillionTokens,
  cacheHitRatePercent,
} from './derived-metrics';

describe('accounting derived metrics', () => {
  it('computes cache hit rate from input and cache-read tokens', () => {
    expect(cacheHitRatePercent({ inputTokens: 300, cacheReadTokens: 100 })).toBe(25);
  });

  it('returns null for cache hit rate when no eligible tokens exist', () => {
    expect(cacheHitRatePercent({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull();
  });

  it('computes effective cost per million total tokens', () => {
    expect(blendedCostPerMillionTokens({
      totalTokens: 500_000,
      effectiveCost: { totalUsd: 1.25 },
    })).toBe(2.5);
  });

  it('returns null for blended cost when no tokens exist', () => {
    expect(blendedCostPerMillionTokens({
      totalTokens: 0,
      effectiveCost: { totalUsd: 10 },
    })).toBeNull();
  });
});
