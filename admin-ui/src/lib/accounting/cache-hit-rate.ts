interface CacheTokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
}

interface CacheRateBucket extends CacheTokenCounts {
  startMs: number;
}

export interface CacheHitRateTrend {
  ratePercents: number[];
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
  return {
    ratePercents: buckets.map(cacheHitRatePercent),
    aggregateRatePercent: cacheHitRatePercent(totals),
  };
}
