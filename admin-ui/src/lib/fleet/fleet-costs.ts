import type {
  FleetModelUsageCompanion,
} from '../../../../src/operator/garden/services/fleet-model-usage-service.js';
import type {
  ModelUsageBucket,
  ModelUsageRange,
} from '../../../../src/shared/telemetry/model-usage.js';
import { companionGardenRoot } from './companion-scope.js';

export type FleetCostSortKey =
  | 'calls'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'effectiveCostUsd'
  | 'spendShare';

export type FleetCostSortDirection = 'asc' | 'desc';

function numericValue(
  row: Extract<FleetModelUsageCompanion, { status: 'available' }>,
  key: FleetCostSortKey,
): number {
  switch (key) {
    case 'calls': return row.totals.calls;
    case 'inputTokens': return row.totals.inputTokens;
    case 'outputTokens': return row.totals.outputTokens;
    case 'cacheReadTokens': return row.totals.cacheReadTokens;
    case 'effectiveCostUsd':
    case 'spendShare':
      return row.totals.effectiveCost.totalUsd;
  }
}

export function sortFleetCompanions(
  rows: readonly FleetModelUsageCompanion[],
  key: FleetCostSortKey,
  direction: FleetCostSortDirection,
): FleetModelUsageCompanion[] {
  return [...rows].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'unavailable' ? 1 : -1;
    if (left.status === 'unavailable' || right.status === 'unavailable') {
      return left.companionId.localeCompare(right.companionId);
    }
    const comparison = numericValue(left, key) - numericValue(right, key);
    if (comparison === 0) return left.companionId.localeCompare(right.companionId);
    return direction === 'asc' ? comparison : -comparison;
  });
}

export interface FleetCompanionCostPathState {
  readonly range: ModelUsageRange;
  readonly timezone: string;
  readonly bucket: ModelUsageBucket;
  readonly customSinceDate: string;
  readonly customUntilDate: string;
}

export function buildFleetCompanionCostPath(
  companionId: string,
  state: FleetCompanionCostPathState,
): string {
  const params = new URLSearchParams({
    tab: 'token-usage',
    range: state.range,
    timezone: state.timezone,
    bucket: state.bucket,
  });
  if (state.range === 'custom') {
    params.set('since', state.customSinceDate);
    params.set('until', state.customUntilDate);
  }
  return `${companionGardenRoot(companionId)}/charge-budget?${params.toString()}`;
}
