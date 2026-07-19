interface CacheTokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
}

interface CacheRateBucket extends CacheTokenCounts {
  startMs: number;
}

export interface CacheHitRatePoint {
  startMs: number;
  ratePercent: number;
}

export interface CacheHitRateTrend {
  points: CacheHitRatePoint[];
  values: number[];
  aggregateRatePercent: number;
}

function cacheHitRatePercent(tokens: CacheTokenCounts): number {
  const denominator = tokens.inputTokens + tokens.cacheReadTokens;
  return denominator === 0 ? 0 : tokens.cacheReadTokens / denominator * 100;
}

export function deriveCacheHitRateTrend(
  buckets: readonly CacheRateBucket[],
  totals: CacheTokenCounts,
): CacheHitRateTrend {
  const points = buckets.map(bucket => ({
    startMs: bucket.startMs,
    ratePercent: cacheHitRatePercent(bucket),
  }));
  return {
    points,
    values: points.map(point => point.ratePercent),
    aggregateRatePercent: cacheHitRatePercent(totals),
  };
}
