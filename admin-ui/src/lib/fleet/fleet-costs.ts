import type {
  FleetModelUsageCompanion,
} from '../../../../src/operator/garden/services/fleet-model-usage-service.js';
import type {
  ModelUsageBucket,
  ModelUsageRange,
} from '../../../../src/shared/telemetry/model-usage.js';
import { ACCOUNTING_RANGE_OPTIONS } from '../accounting/query-state.js';
import { serializeModelUsageQuery } from '../api/endpoints/model-usage-query.js';
import {
  companionGardenRoot,
  parseCompanionGardenScope,
} from './companion-scope.js';
import type { FleetPortalCompanion } from './portal.js';

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

export function fleetSpendShare(
  row: Extract<FleetModelUsageCompanion, { status: 'available' }>,
  fleetHeadlineUsd: number | null,
): number | null {
  if (fleetHeadlineUsd === null || fleetHeadlineUsd <= 0) return null;
  return (row.totals.effectiveCost.totalUsd / fleetHeadlineUsd) * 100;
}

export function selectFleetCostGardenPath(
  companions: readonly FleetPortalCompanion[],
): string | null {
  const reachable = companions.find(companion => (
    companion.gardenPath
    && (companion.availability === 'online' || companion.availability === 'degraded')
  ));
  return reachable?.gardenPath
    ?? companions.find(companion => companion.gardenPath)?.gardenPath
    ?? null;
}

export function fleetCostNavigationPath(pathname: string): string {
  return parseCompanionGardenScope(pathname)
    ? '/fleet#fleet-costs'
    : '/fleet-costs';
}

export interface FleetCompanionCostPathState {
  readonly range: ModelUsageRange;
  readonly timezone: string;
  readonly bucket: ModelUsageBucket;
  readonly customSinceDate: string;
  readonly customUntilDate: string;
}

export const FLEET_COST_RANGE_OPTIONS = ACCOUNTING_RANGE_OPTIONS.filter(
  (option): option is typeof option & { value: Exclude<ModelUsageRange, 'all'> } => (
    option.value !== 'all'
  ),
);

export function normalizeFleetCostRange(
  range: ModelUsageRange,
): Exclude<ModelUsageRange, 'all'> {
  return range === 'all' ? 'year' : range;
}

export function buildFleetCompanionCostPath(
  companionId: string,
  state: FleetCompanionCostPathState,
  deployment: 'single' | 'fleet',
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
  const gardenRoot = deployment === 'fleet' ? companionGardenRoot(companionId) : '';
  return `${gardenRoot}/charge-budget?${serializeModelUsageQuery(params)}`;
}
