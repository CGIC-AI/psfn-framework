import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFleetModelUsageSummaryPath,
  fetchFleetModelUsageProjection,
  parseFleetModelUsageProjection,
  resolveFleetUsageViewState,
} from './model-usage-summary';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function usage(inputTokens: number, outputTokens: number) {
  return {
    calls: 1,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function projection() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-20T12:00:00.000Z',
    resolvedRange: {
      range: 'week',
      timezone: 'America/New_York',
      sinceMs: 10,
      untilMs: 20,
      bucket: 'day',
      boundary: '[sinceMs, untilMs)',
      calendarWeekStartsOn: 'monday',
    },
    combined: {
      calls: 2,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 330,
    },
    companions: [
      { companionId: COMPANION_A, usage: usage(100, 10) },
      { companionId: COMPANION_B, usage: usage(200, 20) },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fleet model-usage summary client', () => {
  it('accepts only a bounded, conserved per-companion token projection', () => {
    expect(parseFleetModelUsageProjection(projection()).companions).toHaveLength(2);
    expect(() => parseFleetModelUsageProjection({
      ...projection(),
      combined: { ...projection().combined, totalTokens: 329 },
    })).toThrow(/inconsistent token totals/u);
    expect(() => parseFleetModelUsageProjection({
      ...projection(),
      companions: [
        ...projection().companions,
        { companionId: COMPANION_A, usage: usage(1, 1) },
      ],
    })).toThrow(/invalid companion projection/u);
    expect(() => parseFleetModelUsageProjection({
      ...projection(),
      privateBreakdown: [],
    })).toThrow(/invalid bounded projection/u);
  });

  it('preserves IANA timezone separators in the fleet-principal query path', () => {
    expect(buildFleetModelUsageSummaryPath({
      range: 'custom',
      timezone: 'America/New_York',
      sinceMs: 10,
      untilMs: 20,
    })).toBe(
      '/v1/fleet/model-usage?range=custom&timezone=America/New_York&sinceMs=10&untilMs=20',
    );
  });

  it('fetches the existing cookie-authorized, no-store fleet projection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(projection()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(fetchFleetModelUsageProjection({
      range: 'week',
      timezone: 'America/New_York',
    })).resolves.toMatchObject({ combined: { totalTokens: 330 } });
    expect(fetch).toHaveBeenCalledWith(
      '/v1/fleet/model-usage?range=week&timezone=America/New_York',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
      }),
    );
  });

  it('renders unavailable rather than manufacturing zeroes on transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(fetchFleetModelUsageProjection()).rejects.toThrow(
      'Fleet usage is temporarily unavailable',
    );
  });

  it('selects explicit loading, ready, and unavailable rendering states', () => {
    expect(resolveFleetUsageViewState({
      loading: true,
      errorMessage: '',
      projection: null,
    })).toBe('loading');
    expect(resolveFleetUsageViewState({
      loading: false,
      errorMessage: '',
      projection: parseFleetModelUsageProjection(projection()),
    })).toBe('ready');
    expect(resolveFleetUsageViewState({
      loading: false,
      errorMessage: 'backend unavailable',
      projection: null,
    })).toBe('unavailable');
    expect(resolveFleetUsageViewState({
      loading: false,
      errorMessage: '',
      projection: null,
    })).toBe('unavailable');
  });
});
