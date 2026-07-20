import { describe, expect, it } from 'vitest';
import type { FleetModelUsageCompanion } from '../../../../src/operator/garden/services/fleet-model-usage-service.js';
import {
  buildFleetCompanionCostPath,
  fleetCostNavigationPath,
  fleetSpendShare,
  FLEET_COST_RANGE_OPTIONS,
  normalizeFleetCostRange,
  selectFleetCostGardenPath,
  sortFleetCompanions,
} from './fleet-costs.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';

function row(
  companionId: string,
  calls: number,
  inputTokens: number,
  effectiveCostUsd: number,
): FleetModelUsageCompanion {
  const cost = {
    inputUsd: effectiveCostUsd,
    inputKnownCalls: calls,
    outputUsd: 0,
    outputKnownCalls: calls,
    cacheReadUsd: 0,
    cacheReadKnownCalls: calls,
    cacheWriteUsd: 0,
    cacheWriteKnownCalls: calls,
    totalUsd: effectiveCostUsd,
    totalKnownCalls: calls,
  };
  return {
    companionId: companionId as FleetModelUsageCompanion['companionId'],
    status: 'available',
    topModel: null,
    totals: {
      calls,
      successfulCalls: calls,
      failedCalls: 0,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens,
      providerCostUsd: effectiveCostUsd,
      estimatedCostUsd: 0,
      totalCostUsd: effectiveCostUsd,
      providerCost: cost,
      estimatedCost: { ...cost, inputUsd: 0, totalUsd: 0, totalKnownCalls: 0 },
      effectiveCost: cost,
      totalDurationMs: 0,
      durationSamples: 0,
      totalTtftMs: 0,
      ttftSamples: 0,
      averageDurationMs: null,
      averageTtftMs: null,
    },
  };
}

describe('fleet costs helpers', () => {
  it('sorts every numeric leaderboard field and keeps unavailable rows last', () => {
    const rows: FleetModelUsageCompanion[] = [
      row(COMPANION_A, 2, 100, 0.2),
      { companionId: COMPANION_C as FleetModelUsageCompanion['companionId'], status: 'unavailable' },
      row(COMPANION_B, 3, 50, 0.5),
    ];

    expect(sortFleetCompanions(rows, 'calls', 'desc').map(item => item.companionId))
      .toEqual([COMPANION_B, COMPANION_A, COMPANION_C]);
    expect(sortFleetCompanions(rows, 'inputTokens', 'asc').map(item => item.companionId))
      .toEqual([COMPANION_B, COMPANION_A, COMPANION_C]);
    expect(sortFleetCompanions(rows, 'effectiveCostUsd', 'asc').map(item => item.companionId))
      .toEqual([COMPANION_A, COMPANION_B, COMPANION_C]);
  });

  it('builds a direct companion Garden accounting link with the selected range', () => {
    expect(buildFleetCompanionCostPath(COMPANION_A, {
      range: 'custom',
      timezone: 'America/New_York',
      bucket: 'day',
      customSinceDate: '2026-07-01',
      customUntilDate: '2026-07-18',
    }, 'fleet')).toBe(
      `/companions/${COMPANION_A}/garden/charge-budget?tab=token-usage&range=custom&timezone=America/New_York&bucket=day&since=2026-07-01&until=2026-07-18`,
    );
  });

  it('uses the privacy-preserving headline as the spend-share denominator', () => {
    const visibleRow = row(COMPANION_A, 1, 100, 0.25);
    expect(fleetSpendShare(
      visibleRow as Extract<FleetModelUsageCompanion, { status: 'available' }>,
      1.25,
    )).toBe(20);
    expect(fleetSpendShare(
      visibleRow as Extract<FleetModelUsageCompanion, { status: 'available' }>,
      null,
    )).toBeNull();
  });

  it('uses an available authorized Garden as the signed fleet-cost parent', () => {
    expect(selectFleetCostGardenPath([
      {
        companionId: COMPANION_A,
        displayName: 'Offline',
        availability: 'offline',
        posture: { status: 'unavailable' },
        gardenPath: `/companions/${COMPANION_A}/garden`,
      },
      {
        companionId: COMPANION_B,
        displayName: 'Online',
        availability: 'online',
        posture: { status: 'unavailable' },
        gardenPath: `/companions/${COMPANION_B}/garden`,
      },
    ])).toBe(`/companions/${COMPANION_B}/garden`);
  });

  it('links fleet companions up while retaining the single-Garden cost route', () => {
    expect(fleetCostNavigationPath(
      `/companions/${COMPANION_A}/garden/charge-budget`,
    )).toBe('/fleet#fleet-costs');
    expect(fleetCostNavigationPath('/charge-budget')).toBe('/fleet-costs');
  });

  it.each(['test-companion', COMPANION_A])(
    'builds an unscoped accounting link for single-companion identifier %s',
    (companionId) => {
      expect(buildFleetCompanionCostPath(companionId, {
        range: 'month',
        timezone: 'UTC',
        bucket: 'auto',
        customSinceDate: '',
        customUntilDate: '',
      }, 'single')).toBe(
        '/charge-budget?tab=token-usage&range=month&timezone=UTC&bucket=auto',
      );
    },
  );

  it('keeps the unsupported all-time range out of fleet controls and URL state', () => {
    expect(FLEET_COST_RANGE_OPTIONS.map(option => option.value)).not.toContain('all');
    expect(normalizeFleetCostRange('all')).toBe('year');
    expect(normalizeFleetCostRange('month')).toBe('month');
  });
});
