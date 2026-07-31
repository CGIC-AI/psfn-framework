import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import {
  MODEL_USAGE_GROUP_DIMENSIONS,
  type ModelUsageAggregateCost,
  type ModelUsageData,
  type ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import { FleetGardenTargetRegistry } from '../fleet-garden-target-registry.js';
import type {
  FleetGardenModelUsageAuthority,
  FleetGardenModelUsageTransportPort,
} from '../fleet-transport-client.js';
import {
  FleetModelUsageService,
  SingleCompanionFleetModelUsageService,
} from './fleet-model-usage-service.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');

function aggregateCost(totalUsd: number, knownCalls: number): ModelUsageAggregateCost {
  return {
    inputUsd: totalUsd,
    inputKnownCalls: knownCalls,
    outputUsd: 0,
    outputKnownCalls: knownCalls,
    cacheReadUsd: 0,
    cacheReadKnownCalls: knownCalls,
    cacheWriteUsd: 0,
    cacheWriteKnownCalls: knownCalls,
    totalUsd,
    totalKnownCalls: knownCalls,
  };
}

function totals(input: {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  totalDurationMs: number;
  durationSamples: number;
  totalTtftMs: number;
  ttftSamples: number;
}): ModelUsageTotals {
  const totalTokens = input.inputTokens + input.outputTokens;
  return {
    calls: input.calls,
    successfulCalls: input.calls,
    failedCalls: 0,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    providerCostUsd: input.costUsd,
    estimatedCostUsd: 0,
    totalCostUsd: input.costUsd,
    providerCost: aggregateCost(input.costUsd, input.calls),
    estimatedCost: aggregateCost(0, 0),
    effectiveCost: aggregateCost(input.costUsd, input.calls),
    totalDurationMs: input.totalDurationMs,
    durationSamples: input.durationSamples,
    totalTtftMs: input.totalTtftMs,
    ttftSamples: input.ttftSamples,
    averageDurationMs: input.durationSamples === 0
      ? null
      : input.totalDurationMs / input.durationSamples,
    averageTtftMs: input.ttftSamples === 0 ? null : input.totalTtftMs / input.ttftSamples,
  };
}

function usageResponse(companionTotals: ModelUsageTotals, modelKey: string): ModelUsageData {
  return {
    query: {
      range: 'custom', timezone: 'UTC', sinceMs: 0, untilMs: 3_600_000,
      bucket: 'hour', groupBy: ['model'], topN: 100, limit: 1,
    },
    resolvedRange: {
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
      boundary: '[sinceMs, untilMs)',
      calendarWeekStartsOn: 'monday',
    },
    totals: companionTotals,
    timeSeries: [{ startMs: 0, endMs: 3_600_000, ...companionTotals }],
    groups: [{ dimensions: { model: modelKey }, isOther: false, metrics: companionTotals }],
    eventPage: { order: 'recent', items: [], nextCursor: null, hasMore: false },
    byModel: [{ key: modelKey, ...companionTotals }],
    byPurpose: [],
    byTool: [],
    byCallKind: [],
    groupedBy: { model: [{ key: modelKey, ...companionTotals }] },
    attributionCoverage: {
      totalCalls: companionTotals.calls,
      byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map(dimension => [
        dimension,
        { knownCalls: 0, unknownCalls: companionTotals.calls, coveragePercent: 0 },
      ])) as ModelUsageData['attributionCoverage']['byDimension'],
    },
    attributionAnomalies: {
      unknownChargeLaneCalls: companionTotals.calls,
      unknownChargeLaneRatePercent: companionTotals.calls > 0 ? 100 : 0,
      unknownSessionCalls: companionTotals.calls,
      unknownSessionRatePercent: companionTotals.calls > 0 ? 100 : 0,
    },
    recentEvents: [],
    expensiveEvents: [],
  };
}

function registry(): FleetGardenTargetRegistry {
  return new FleetGardenTargetRegistry([
    {
      companionId: COMPANION_A,
      endpoint: { mode: 'socket', socketPath: '/run/admin-a.sock', timeoutMs: 1_000 },
    },
    {
      companionId: COMPANION_B,
      endpoint: { mode: 'socket', socketPath: '/run/admin-b.sock', timeoutMs: 1_000 },
    },
  ]);
}

function authority(
  authorizedCompanionIds: readonly (typeof COMPANION_A)[] = [COMPANION_A, COMPANION_B],
): FleetGardenModelUsageAuthority {
  return {
    authorizedCompanionIds,
    modelUsageRequestTarget:
      '/api/admin/model-usage?range=custom&timezone=UTC&sinceMs=0&untilMs=3600000&bucket=hour&limit=1&topN=100&groupBy=model',
    token: 'signed-fleet-authority',
    context: {
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      versions: {
        authorityGeneration: 1,
        globalAuthEpoch: 1,
        sessionAuthnVersion: 1,
        sessionAuthzVersion: 1,
        bindingVersion: 1,
        grantVersion: 1,
        policyVersion: 1,
      },
    },
    parentCompanionId: COMPANION_A,
    parentRequestTarget: '/api/admin/fleet-model-usage?range=custom',
  };
}

describe('FleetModelUsageService', () => {
  it('sums two companion responses and recomputes weighted duration averages', async () => {
    const a = totals({
      calls: 2,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.25,
      totalDurationMs: 200,
      durationSamples: 2,
      totalTtftMs: 40,
      ttftSamples: 2,
    });
    const b = totals({
      calls: 3,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.75,
      totalDurationMs: 900,
      durationSamples: 3,
      totalTtftMs: 180,
      ttftSamples: 3,
    });
    const transport: FleetGardenModelUsageTransportPort = {
      requestModelUsage: vi.fn(async target => (
        target.companionId === COMPANION_A
          ? usageResponse(a, 'provider-a:model-a')
          : usageResponse(b, 'provider-b:model-b')
      )),
    };
    const service = new FleetModelUsageService({ registry: registry(), transport });

    const result = await service.getFleetModelUsage({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
    }, authority());

    expect(result.coverage).toEqual({ available: 2, unavailable: 0, complete: true });
    expect(result.deployment).toBe('fleet');
    expect(result.totals).toMatchObject({
      calls: 5,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      totalDurationMs: 1_100,
      durationSamples: 5,
      averageDurationMs: 220,
      totalTtftMs: 220,
      ttftSamples: 5,
      averageTtftMs: 44,
      effectiveCost: { totalUsd: 1 },
    });
    expect(result.timeSeries).toHaveLength(1);
    expect(result.timeSeries[0]).toMatchObject({ calls: 5, averageDurationMs: 220 });
    expect(result.perCompanion).toEqual([
      expect.objectContaining({
        companionId: COMPANION_A,
        status: 'available',
        topModel: expect.objectContaining({ key: 'provider-a:model-a' }),
      }),
      expect.objectContaining({
        companionId: COMPANION_B,
        status: 'available',
        topModel: expect.objectContaining({ key: 'provider-b:model-b' }),
      }),
    ]);
    expect(transport.requestModelUsage).toHaveBeenCalledTimes(2);
    expect(transport.requestModelUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/admin/model-usage?'),
      expect.objectContaining({ authorizedCompanionIds: [COMPANION_A, COMPANION_B] }),
    );
  });

  it('never calls or identifies a registry target outside the signed roster', async () => {
    const companionTotals = totals({
      calls: 1,
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.1,
      totalDurationMs: 80,
      durationSamples: 1,
      totalTtftMs: 10,
      ttftSamples: 1,
    });
    const transport: FleetGardenModelUsageTransportPort = {
      requestModelUsage: vi.fn(async () => usageResponse(
        companionTotals,
        'provider-a:model-a',
      )),
    };
    const service = new FleetModelUsageService({ registry: registry(), transport });

    const result = await service.getFleetModelUsage({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
    }, authority([COMPANION_A]));

    expect(transport.requestModelUsage).toHaveBeenCalledTimes(1);
    expect(transport.requestModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({ companionId: COMPANION_A }),
      expect.any(String),
      expect.objectContaining({ authorizedCompanionIds: [COMPANION_A] }),
    );
    expect(result.perCompanion).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(COMPANION_B);
  });

  it('keeps private spend only in fleet totals and marks failed targets unavailable', async () => {
    const visible = totals({
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.25,
      totalDurationMs: 100,
      durationSamples: 1,
      totalTtftMs: 20,
      ttftSamples: 1,
    });
    const aggregate = totals({
      calls: 2,
      inputTokens: 500,
      outputTokens: 250,
      costUsd: 1.25,
      totalDurationMs: 300,
      durationSamples: 2,
      totalTtftMs: 60,
      ttftSamples: 2,
    });
    const response = usageResponse(aggregate, 'provider-a:visible-model');
    response.groups = [{
      dimensions: { model: 'provider-a:visible-model' },
      isOther: false,
      metrics: visible,
    }];
    const responseWithPrivateSourceDetail = {
      ...response,
      recentEvents: [{
        telemetryVisibility: 'companion_private',
        model: 'private-model-must-not-escape',
      }],
      byPurpose: [{ key: 'companion_private.background' }],
    };
    const transport: FleetGardenModelUsageTransportPort = {
      requestModelUsage: vi.fn(async target => {
        if (target.companionId === COMPANION_B) throw new Error('socket unavailable');
        return responseWithPrivateSourceDetail;
      }),
    };
    const service = new FleetModelUsageService({ registry: registry(), transport });

    const result = await service.getFleetModelUsage({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
    }, authority());

    expect(result.totals?.calls).toBe(2);
    expect(result.perCompanion).toEqual([
      expect.objectContaining({
        companionId: COMPANION_A,
        status: 'available',
        totals: expect.objectContaining({ calls: 1, totalCostUsd: 0.25 }),
      }),
      { companionId: COMPANION_B, status: 'unavailable' },
    ]);
    expect(result.coverage).toEqual({ available: 1, unavailable: 1, complete: false });
    expect(JSON.stringify(result)).not.toContain('companion_private');
    expect(JSON.stringify(result)).not.toContain('private-model-must-not-escape');
  });

  it.each([
    {
      name: 'non-canonical time buckets',
      mutate(response: ModelUsageData): void {
        response.timeSeries = [
          ...response.timeSeries,
          { ...response.timeSeries[0]!, startMs: 1, endMs: 3_600_000 },
        ];
      },
    },
    {
      name: 'inconsistent aggregate totals',
      mutate(response: ModelUsageData): void {
        response.totals = { ...response.totals, successfulCalls: 0 };
      },
    },
  ])('marks a child unavailable for $name', async ({ mutate }) => {
    const companionTotals = totals({
      calls: 1,
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.1,
      totalDurationMs: 80,
      durationSamples: 1,
      totalTtftMs: 10,
      ttftSamples: 1,
    });
    const transport: FleetGardenModelUsageTransportPort = {
      requestModelUsage: vi.fn(async target => {
        const response = usageResponse(companionTotals, 'provider:model');
        if (target.companionId === COMPANION_A) mutate(response);
        return response;
      }),
    };
    const service = new FleetModelUsageService({ registry: registry(), transport });

    const result = await service.getFleetModelUsage({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
    }, authority());

    expect(result.perCompanion).toEqual([
      { companionId: COMPANION_A, status: 'unavailable' },
      expect.objectContaining({ companionId: COMPANION_B, status: 'available' }),
    ]);
    expect(result.coverage).toEqual({ available: 1, unavailable: 1, complete: false });
  });

  it('projects one canonical Garden service as a one-row fleet', async () => {
    const companionTotals = totals({
      calls: 1,
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.1,
      totalDurationMs: 80,
      durationSamples: 1,
      totalTtftMs: 10,
      ttftSamples: 1,
    });
    const getModelUsageData = vi.fn(async () => (
      usageResponse(companionTotals, 'provider-a:model-a')
    ));
    const service = new SingleCompanionFleetModelUsageService({
      companionId: COMPANION_A,
      modelUsage: { getModelUsageData },
    });

    const result = await service.getFleetModelUsage({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
    });

    expect(result.coverage).toEqual({ available: 1, unavailable: 0, complete: true });
    expect(result.deployment).toBe('single');
    expect(result.perCompanion).toEqual([
      expect.objectContaining({ companionId: COMPANION_A, status: 'available' }),
    ]);
    expect(getModelUsageData).toHaveBeenCalledWith(expect.objectContaining({
      range: 'custom',
      groupBy: ['model'],
      topN: 100,
      limit: 1,
    }));
  });

  it('rejects all-time single-companion fleet projections', async () => {
    const service = new SingleCompanionFleetModelUsageService({
      companionId: COMPANION_A,
      modelUsage: { getModelUsageData: vi.fn() },
    });

    await expect(service.getFleetModelUsage({ range: 'all' }))
      .rejects.toThrow('does not support all-time');
  });
});
