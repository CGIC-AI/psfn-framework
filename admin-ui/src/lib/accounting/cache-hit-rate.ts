import { cacheHitRatePercent } from './derived-metrics.js';

interface CacheTokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
}

interface CacheRateBucket extends CacheTokenCounts {
  startMs: number;
}

export interface CacheHitRateTrend {
  ratePercents: Array<number | null>;
  aggregateRatePercent: number | null;
}

export function deriveCacheHitRateTrend(
  buckets: readonly CacheRateBucket[],
  totals: CacheTokenCounts,
): CacheHitRateTrend {
  return {
    ratePercents: buckets.map(cacheHitRatePercent),
    aggregateRatePercent: cacheHitRatePercent(totals),
  };
}
