import {
  MODEL_USAGE_UNKNOWN_DIMENSION,
  type ModelUsageBreakdown,
  type ModelUsageGroupDimension,
} from '../../../../src/shared/telemetry/model-usage.js';

export type UsageBreakdownDimension = Extract<
  ModelUsageGroupDimension,
  'model' | 'purpose' | 'toolName' | 'channelId'
>;
export type UsageBreakdownSort = 'effectiveCostUsd' | 'totalTokens' | 'calls';
export type UsageBreakdownSortDirection = 'asc' | 'desc';

export interface UsageBreakdownRow {
  key: string;
  label: string;
  drillValue: string | null;
  calls: number;
  totalTokens: number;
  effectiveCostUsd: number;
  isOther: boolean;
}

interface BuildUsageBreakdownRowsOptions {
  dimension: UsageBreakdownDimension;
  sortBy?: UsageBreakdownSort;
  sortDirection?: UsageBreakdownSortDirection;
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
    calls: item.calls,
    totalTokens: item.totalTokens,
    effectiveCostUsd: item.totalCostUsd,
    isOther: false,
  };
}

export function buildUsageBreakdownRows(
  items: readonly ModelUsageBreakdown[],
  options: BuildUsageBreakdownRowsOptions,
): UsageBreakdownRow[] {
  const sortBy = options.sortBy ?? 'effectiveCostUsd';
  const direction = options.sortDirection ?? 'desc';
  const compareMetric = (left: UsageBreakdownRow, right: UsageBreakdownRow): number => (
    left[sortBy] - right[sortBy]
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
  if (remainder.length === 0) return visible;

  return [...visible, remainder.reduce<UsageBreakdownRow>((other, row) => ({
    ...other,
    calls: other.calls + row.calls,
    totalTokens: other.totalTokens + row.totalTokens,
    effectiveCostUsd: other.effectiveCostUsd + row.effectiveCostUsd,
  }), {
    key: 'Other',
    label: 'Other',
    drillValue: null,
    calls: 0,
    totalTokens: 0,
    effectiveCostUsd: 0,
    isOther: true,
  })];
}
