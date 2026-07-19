import type { ModelUsageTotals } from '../../../../src/shared/telemetry/model-usage.js';

type CacheHitRateTotals = Pick<ModelUsageTotals, 'inputTokens' | 'cacheReadTokens'>;

type BlendedCostTotals = Pick<ModelUsageTotals, 'totalTokens'> & {
  effectiveCost: Pick<ModelUsageTotals['effectiveCost'], 'totalUsd'>;
};

export function cacheHitRatePercent(totals: CacheHitRateTotals): number | null {
  const eligibleTokens = totals.inputTokens + totals.cacheReadTokens;
  if (!Number.isFinite(eligibleTokens) || eligibleTokens <= 0) return null;
  return (totals.cacheReadTokens / eligibleTokens) * 100;
}

export function blendedCostPerMillionTokens(totals: BlendedCostTotals): number | null {
  if (!Number.isFinite(totals.totalTokens) || totals.totalTokens <= 0) return null;
  if (!Number.isFinite(totals.effectiveCost.totalUsd)) return null;
  return (totals.effectiveCost.totalUsd / totals.totalTokens) * 1_000_000;
}
