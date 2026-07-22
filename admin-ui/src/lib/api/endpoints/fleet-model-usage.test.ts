import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFleetModelUsagePath,
  getAuthorizedFleetModelUsage,
} from './fleet-model-usage.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';

function zeroCost() {
  return {
    inputUsd: 0,
    inputKnownCalls: 0,
    outputUsd: 0,
    outputKnownCalls: 0,
    cacheReadUsd: 0,
    cacheReadKnownCalls: 0,
    cacheWriteUsd: 0,
    cacheWriteKnownCalls: 0,
    totalUsd: 0,
    totalKnownCalls: 0,
  };
}

function zeroTotals() {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerCostUsd: 0,
    estimatedCostUsd: 0,
    totalCostUsd: 0,
    providerCost: zeroCost(),
    estimatedCost: zeroCost(),
    effectiveCost: zeroCost(),
    totalDurationMs: 0,
    durationSamples: 0,
    totalTtftMs: 0,
    ttftSamples: 0,
    averageDurationMs: null,
    averageTtftMs: null,
  };
}

function paidTotals(calls: number, totalUsd: number) {
  const cost = {
    ...zeroCost(),
    inputUsd: totalUsd,
    inputKnownCalls: calls,
    outputKnownCalls: calls,
    cacheReadKnownCalls: calls,
    cacheWriteKnownCalls: calls,
    totalUsd,
    totalKnownCalls: calls,
  };
  return {
    ...zeroTotals(),
    calls,
    successfulCalls: calls,
    providerCostUsd: totalUsd,
    totalCostUsd: totalUsd,
    providerCost: cost,
    effectiveCost: cost,
  };
}

function fleetResponse() {
  return {
    deployment: 'fleet',
    resolvedRange: {
      range: 'week',
      timezone: 'UTC',
      sinceMs: 0,
      untilMs: 3_600_000,
      bucket: 'hour',
      boundary: '[sinceMs, untilMs)',
      calendarWeekStartsOn: 'monday',
    },
    totals: zeroTotals(),
    perCompanion: [{
      companionId: COMPANION_A,
      status: 'available',
      totals: zeroTotals(),
      topModel: null,
    }],
    timeSeries: [{
      startMs: 0,
      endMs: 3_600_000,
      ...zeroTotals(),
    }],
    coverage: { available: 1, unavailable: 0, complete: true },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fleet model-usage endpoint', () => {
  it('serializes only the fleet aggregate range fields', () => {
    expect(buildFleetModelUsagePath({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 10,
      untilMs: 20,
      bucket: 'hour',
    })).toBe(
      '/api/admin/fleet-model-usage?range=custom&timezone=UTC&sinceMs=10&untilMs=20&bucket=hour',
    );
  });

  it('preserves valid IANA timezone slashes for the strict scoped-path guard', () => {
    expect(buildFleetModelUsagePath({
      range: 'month',
      timezone: 'America/New_York',
      bucket: 'day',
    })).toBe(
      '/api/admin/fleet-model-usage?range=month&timezone=America/New_York&bucket=day',
    );
  });

  it('fetches fleet costs only through a canonical authorized Garden path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      fleetResponse(),
    ), { status: 200 })));
    const signal = new AbortController().signal;

    await expect(getAuthorizedFleetModelUsage(
      `/companions/${COMPANION_A}/garden`,
      { range: 'week', timezone: 'UTC', bucket: 'day' },
      signal,
    )).resolves.toMatchObject({ deployment: 'fleet' });
    expect(fetch).toHaveBeenCalledWith(
      `/companions/${COMPANION_A}/garden/api/admin/fleet-model-usage?range=week&timezone=UTC&bucket=day`,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        signal,
      }),
    );
    await expect(getAuthorizedFleetModelUsage('/api/admin', {}))
      .rejects.toThrow(/server-authorized companion Garden path/u);
  });

  it('fails closed when the authorized cost response is widened or incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      deployment: 'fleet',
    }), { status: 200 })));
    await expect(getAuthorizedFleetModelUsage(
      `/companions/${COMPANION_A}/garden`,
    )).rejects.toThrow(/invalid projection/u);
  });

  it('rejects a valid single-companion projection on the fleet-authorized route', async () => {
    const response = fleetResponse();
    response.deployment = 'single';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(response),
      { status: 200 },
    )));

    await expect(getAuthorizedFleetModelUsage(
      `/companions/${COMPANION_A}/garden`,
    )).rejects.toThrow(/non-cluster projection/u);
  });

  it('preserves private spend in fleet headlines without adding it to companion rows', async () => {
    const response = fleetResponse();
    response.totals = paidTotals(2, 1.25);
    response.perCompanion[0]!.totals = paidTotals(1, 0.25);
    response.timeSeries[0] = {
      startMs: 0,
      endMs: 3_600_000,
      ...paidTotals(2, 1.25),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(response),
      { status: 200 },
    )));

    const result = await getAuthorizedFleetModelUsage(
      `/companions/${COMPANION_A}/garden`,
    );
    expect(result.totals?.effectiveCost.totalUsd).toBe(1.25);
    expect(result.perCompanion[0]).toMatchObject({
      status: 'available',
      totals: { effectiveCost: { totalUsd: 0.25 } },
    });
    expect(JSON.stringify(result)).not.toContain('companion_private');
  });
});
