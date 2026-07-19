import {
  MODEL_USAGE_UNKNOWN_DIMENSION,
  type ModelUsageBreakdown,
  type ModelUsageGroupDimension,
  type ModelUsageSortDirection,
} from '../../../../src/shared/telemetry/model-usage.js';

export type UsageBreakdownDimension = Extract<
  ModelUsageGroupDimension,
  'model' | 'purpose' | 'toolName' | 'channelId'
>;

export interface UsageBreakdownTotals {
  totalTokens: number;
  effectiveCostUsd: number;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  drillValue: string | null;
  totalTokens: number;
  effectiveCostUsd: number;
}

interface BuildUsageBreakdownRowsOptions {
  dimension: UsageBreakdownDimension;
  sortDirection?: ModelUsageSortDirection;
  detailTotals?: UsageBreakdownTotals;
}

function modelDrillValue(key: string): string {
  const separator = key.indexOf(':');
  return separator === -1 ? key : key.slice(separator + 1);
}

function toRow(
  item: ModelUsageBreakdown,
  dimension: UsageBreakdownDimension,
): UsageBreakdownRow {
  const unknownTool = dimension === 'toolName' && item.key === MODEL_USAGE_UNKNOWN_DIMENSION;
  return {
    key: item.key,
    label: unknownTool ? 'No tool' : item.key,
    drillValue: unknownTool ? null : dimension === 'model' ? modelDrillValue(item.key) : item.key,
    totalTokens: item.totalTokens,
    effectiveCostUsd: item.totalCostUsd,
  };
}

export function sumUsageBreakdownMetrics(
  items: readonly ModelUsageBreakdown[],
): UsageBreakdownTotals {
  return items.reduce<UsageBreakdownTotals>((total, item) => ({
    totalTokens: total.totalTokens + item.totalTokens,
    effectiveCostUsd: total.effectiveCostUsd + item.totalCostUsd,
  }), { totalTokens: 0, effectiveCostUsd: 0 });
}

export function buildUsageBreakdownRows(
  items: readonly ModelUsageBreakdown[],
  options: BuildUsageBreakdownRowsOptions,
): UsageBreakdownRow[] {
  const direction = options.sortDirection ?? 'desc';
  const compareMetric = (left: UsageBreakdownRow, right: UsageBreakdownRow): number => (
    left.effectiveCostUsd - right.effectiveCostUsd
  );
  const ranked = items
    .map(item => toRow(item, options.dimension))
    .sort((left, right) => -compareMetric(left, right) || left.key.localeCompare(right.key));
  const visible = ranked.slice(0, 8);
  const remainder = ranked.slice(8);
  visible.sort((left, right) => (
    (direction === 'asc' ? compareMetric(left, right) : -compareMetric(left, right))
    || left.key.localeCompare(right.key)
  ));
  const visibleTotals = visible.reduce<UsageBreakdownTotals>((total, row) => ({
    totalTokens: total.totalTokens + row.totalTokens,
    effectiveCostUsd: total.effectiveCostUsd + row.effectiveCostUsd,
  }), { totalTokens: 0, effectiveCostUsd: 0 });
  const servedTotals = options.detailTotals ?? sumUsageBreakdownMetrics(items);
  const other: UsageBreakdownRow = {
    key: 'Other',
    label: 'Other',
    drillValue: null,
    totalTokens: Math.max(0, servedTotals.totalTokens - visibleTotals.totalTokens),
    effectiveCostUsd: Math.max(0, servedTotals.effectiveCostUsd - visibleTotals.effectiveCostUsd),
  };
  const hasOther = remainder.length > 0
    || other.totalTokens > 0
    || other.effectiveCostUsd > 0;
  return hasOther ? [...visible, other] : visible;
}
