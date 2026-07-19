import { describe, expect, it } from 'vitest';
import { deriveCacheHitRateTrend } from './cache-hit-rate';

describe('deriveCacheHitRateTrend', () => {
  it('derives bucket and aggregate rates from cache reads over eligible prompt tokens', () => {
    const trend = deriveCacheHitRateTrend([
      { startMs: 1_000, inputTokens: 80, cacheReadTokens: 20 },
      { startMs: 2_000, inputTokens: 50, cacheReadTokens: 50 },
    ], {
      inputTokens: 150,
      cacheReadTokens: 50,
    });

    expect(trend.points).toEqual([
      { startMs: 1_000, ratePercent: 20 },
      { startMs: 2_000, ratePercent: 50 },
    ]);
    expect(trend.values).toEqual([20, 50]);
    expect(trend.aggregateRatePercent).toBe(25);
  });

  it('returns zero instead of NaN when a bucket or range has no eligible tokens', () => {
    const trend = deriveCacheHitRateTrend([
      { startMs: 1_000, inputTokens: 0, cacheReadTokens: 0 },
    ], {
      inputTokens: 0,
      cacheReadTokens: 0,
    });

    expect(trend.values).toEqual([0]);
    expect(trend.aggregateRatePercent).toBe(0);
  });
});
