import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type { ModelUsageData, ModelUsageQuery, ModelUsageTotals } from '../../../shared/telemetry/model-usage.js';
import { MODEL_USAGE_GROUP_DIMENSIONS } from '../../../shared/telemetry/model-usage-attribution.js';
import { AdminDashboardDataService } from './dashboard-service.js';
import type { AdminAdaptiveToolsService, AdminModelUsageService } from './types.js';
import { startOfDashboardUtcWeek } from './dashboard-cost-windows.js';
import type { DashboardCostWindow } from '../types.js';

const EMPTY_TOTALS: ModelUsageTotals = {
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
  averageDurationMs: null,
  averageTtftMs: null,
};

function makeUsageData(
  query: ModelUsageQuery,
  overrides: Partial<ModelUsageTotals> = {},
): ModelUsageData {
  const totals = { ...EMPTY_TOTALS, ...overrides };
  return {
    query,
    totals,
    timeSeries: [],
    byModel: [],
    byPurpose: [],
    byTool: [],
    byCallKind: [],
    groupedBy: {},
    attributionCoverage: {
      totalCalls: totals.calls,
      byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map(dimension => [dimension, {
        knownCalls: 0,
        unknownCalls: totals.calls,
        coveragePercent: 0,
      }])) as ModelUsageData['attributionCoverage']['byDimension'],
    },
    recentEvents: [],
    expensiveEvents: [],
  };
}

function makeBaseDeps(eventBus = new EventBus()): {
  eventBus: EventBus;
  memoryStore: MemoryStorePort;
  sessionStore: SessionStore;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
} {
  return {
    eventBus,
    memoryStore: {
      getStats: () => ({ total: 0, avgSalience: 0, byType: {} }),
    } as MemoryStorePort,
    sessionStore: {
      listChannels: () => [],
      getLatestSessionByTimestamp: () => null,
    } as SessionStore,
    scheduler: { taskCount: 0 } as Scheduler,
    shardManager: {
      getActiveCount: vi.fn(() => 0),
      getActiveShards: vi.fn(() => []),
    } as unknown as ShardExecutionPort,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AdminDashboardDataService', () => {
  it('reads shard status through the shard execution port', async () => {
    const deps = makeBaseDeps();
    const shardManager = {
      ...deps.shardManager,
      getActiveCount: vi.fn(() => 2),
    } as ShardExecutionPort;
    const service = new AdminDashboardDataService({ ...deps, shardManager });

    const dashboard = await service.getDashboardData();

    expect(dashboard.stats.activeShards).toBe(2);
    expect(shardManager.getActiveCount).toHaveBeenCalledTimes(1);
    expect(dashboard.stats.modelUsage.freshness.state).toBe('unavailable');
    expect(dashboard.stats.modelUsage.usage).toBeNull();
  });

  it('surfaces tool health and keeps first-token/context telemetry explicitly transient', async () => {
    const eventBus = new EventBus();
    const deps = makeBaseDeps(eventBus);
    const adaptiveToolsService = {
      getAdaptiveToolsData: vi.fn(async () => ({
        state: null,
        catalog: null,
        serviceHealth: [],
        toolHealth: [
          {
            name: 'memory',
            description: 'memory tool',
            scope: 'extended',
            health: { status: 'healthy', detail: 'ready' },
            contexts: {
              chat: { status: 'active', detail: 'active' },
              internalHeartbeat: { status: 'active', detail: 'active' },
            },
          },
          {
            name: 'orient',
            description: 'orient tool',
            scope: 'core',
            health: { status: 'degraded', detail: 'last call timed out' },
            contexts: {
              chat: { status: 'active', detail: 'core' },
              internalHeartbeat: { status: 'active', detail: 'core' },
            },
          },
        ],
        inventory: [],
        recentInvocations: [],
        recentFailures: [],
        recentTelemetry: [],
      })),
    } satisfies AdminAdaptiveToolsService;
    const service = new AdminDashboardDataService({ ...deps, adaptiveToolsService });

    await eventBus.emit('agent.turn.stage', {
      turnId: 'turn-1', channelId: 'chat', stage: 'first-token', elapsedMs: 1_200, ttftMs: 1_200,
    });
    await eventBus.emit('agent.turn.stage', {
      turnId: 'turn-2', channelId: 'chat', stage: 'first-token', elapsedMs: 800, ttftMs: 800,
    });
    await eventBus.emit('agent.turn.performance', {
      schemaVersion: 1,
      traceId: 'trace-1',
      stage: 'provider_request',
      monotonicAtMs: 1_000,
      timestampMs: 1_000,
      provider: 'test',
    });
    await eventBus.emit('agent.turn.performance', {
      schemaVersion: 1,
      traceId: 'trace-1',
      stage: 'provider_first_token',
      monotonicAtMs: 1_900,
      timestampMs: 1_900,
      provider: 'test',
    });

    const dashboard = await service.getDashboardData();

    expect(dashboard.stats.transientSessionTelemetry).toMatchObject({
      source: 'live_event_bus',
      lastTtftMs: 800,
      averageTtftMs: 1_000,
    });
    expect(dashboard.stats.transientSessionTelemetry.latencyPercentiles.series).toContainEqual({
      metric: 'llm_ttft',
      dimensions: {},
      percentiles: { samples: 1, p50Ms: 900, p95Ms: 900, p99Ms: 900 },
    });
    expect(dashboard.stats.toolStatus).toEqual([
      { name: 'orient', status: 'degraded', detail: 'last call timed out' },
      { name: 'memory', status: 'healthy', detail: 'ready' },
    ]);
  });

  it('uses the canonical selected-range model-usage query and ignores live event costs', async () => {
    const nowMs = Date.UTC(2026, 6, 14, 5, 0, 0, 0);
    const weekStartMs = startOfDashboardUtcWeek(nowMs);
    const eventBus = new EventBus();
    const deps = makeBaseDeps(eventBus);
    const modelUsageService: AdminModelUsageService = {
      getModelUsageData: vi.fn(async query => {
        const usage = makeUsageData(query ?? {}, {
          calls: 4,
          successfulCalls: 3,
          failedCalls: 1,
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 600,
          cacheWriteTokens: 50,
          totalTokens: 1_850,
          providerCostUsd: 0.08,
          estimatedCostUsd: 0.1,
          totalCostUsd: 0.09,
        });
        usage.timeSeries = [
          { ...usage.totals, startMs: weekStartMs, endMs: weekStartMs + 86_400_000 },
          {
            ...usage.totals,
            startMs: weekStartMs + 86_400_000,
            endMs: weekStartMs + (2 * 86_400_000),
            totalTokens: 350,
            totalCostUsd: 0.04,
          },
        ];
        return usage;
      }),
    };
    const service = new AdminDashboardDataService({
      ...deps,
      modelUsageService,
      now: () => nowMs,
    });
    await eventBus.emit('agent.turn.usage', {
      message: {
        id: 'live-only', channelId: 'api:operator', channelType: 'api', authorId: 'operator',
        authorName: 'Operator', content: 'not accounting truth', timestamp: new Date(nowMs),
      },
      usage: {
        inputTokens: 999_999,
        outputTokens: 999_999,
        cacheReadTokens: 999_999,
        llmCalls: 99,
        toolCalls: 99,
        contextUtilization: 61.7,
        estimatedCostUsd: 999,
      },
    });

    const dashboard = await service.getDashboardData({ costWindow: 'week' });

    expect(modelUsageService.getModelUsageData).toHaveBeenCalledWith({
      sinceMs: startOfDashboardUtcWeek(nowMs),
      untilMs: nowMs + 1,
      bucket: 'day',
      limit: 1,
    });
    expect(dashboard.stats.modelUsage).toMatchObject({
      selected: 'week',
      freshness: {
        state: 'fresh',
        source: 'postgres_model_usage',
        refreshedAtMs: nowMs,
        dataThroughMs: nowMs,
        refreshIntervalMs: 15_000,
      },
      usage: {
        calls: 4,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 600,
        cacheWriteTokens: 50,
        providerCostUsd: 0.08,
        estimatedCostUsd: 0.1,
        effectiveCostUsd: 0.09,
      },
      sparkline: [
        { startMs: weekStartMs, totalTokens: 1_850, effectiveCostUsd: 0.09 },
        {
          startMs: weekStartMs + 86_400_000,
          totalTokens: 350,
          effectiveCostUsd: 0.04,
        },
      ],
    });
    expect(dashboard.stats.transientSessionTelemetry.turnsSinceOperatorStart).toBe(1);
  });

  it('loads the same durable totals after an operator restart without receiving usage events', async () => {
    const nowMs = Date.UTC(2026, 6, 14, 6, 0, 0, 0);
    const modelUsageService: AdminModelUsageService = {
      getModelUsageData: vi.fn(async query => makeUsageData(query ?? {}, {
        calls: 2,
        totalTokens: 300,
        totalCostUsd: 0.04,
      })),
    };

    const first = new AdminDashboardDataService({
      ...makeBaseDeps(), modelUsageService, now: () => nowMs,
    });
    const restarted = new AdminDashboardDataService({
      ...makeBaseDeps(), modelUsageService, now: () => nowMs,
    });

    const beforeRestart = await first.getDashboardData({ costWindow: 'today' });
    const afterRestart = await restarted.getDashboardData({ costWindow: 'today' });

    expect(afterRestart.stats.modelUsage.usage).toEqual(beforeRestart.stats.modelUsage.usage);
    expect(afterRestart.stats.transientSessionTelemetry.turnsSinceOperatorStart).toBe(0);
  });

  it('distinguishes unavailable from matching-range stale data after storage failures', async () => {
    const nowMs = Date.UTC(2026, 6, 14, 7, 0, 0, 0);
    const cachedUsage = makeUsageData({}, { calls: 3, totalTokens: 700, totalCostUsd: 0.07 });
    cachedUsage.timeSeries = [{
      ...cachedUsage.totals,
      startMs: startOfDashboardUtcWeek(nowMs),
      endMs: nowMs + 1,
    }];
    const getModelUsageData = vi.fn<AdminModelUsageService['getModelUsageData']>();
    getModelUsageData.mockRejectedValueOnce(new Error('postgres offline'));
    getModelUsageData.mockResolvedValueOnce(cachedUsage);
    getModelUsageData.mockRejectedValue(new Error('postgres offline again'));
    const service = new AdminDashboardDataService({
      ...makeBaseDeps(), modelUsageService: { getModelUsageData }, now: () => nowMs,
    });

    const unavailable = await service.getDashboardData({ costWindow: 'today' });
    const fresh = await service.getDashboardData({ costWindow: 'today' });
    const stale = await service.getDashboardData({ costWindow: 'today' });
    const differentRange = await service.getDashboardData({ costWindow: 'month' });

    expect(unavailable.stats.modelUsage).toMatchObject({
      selected: 'today', usage: null, sparkline: [], freshness: { state: 'unavailable', refreshedAtMs: null },
    });
    expect(fresh.stats.modelUsage.freshness.state).toBe('fresh');
    expect(stale.stats.modelUsage).toMatchObject({
      selected: 'today',
      usage: { calls: 3, effectiveCostUsd: 0.07 },
      sparkline: [{ totalTokens: 700, effectiveCostUsd: 0.07 }],
      freshness: { state: 'stale' },
    });
    expect(differentRange.stats.modelUsage).toMatchObject({
      selected: 'month', usage: null, sparkline: [], freshness: { state: 'unavailable' },
    });
  });

  it.each<{
    costWindow: DashboardCostWindow;
    beforeBoundaryMs: number;
    afterBoundaryMs: number;
  }>([
    {
      costWindow: 'today',
      beforeBoundaryMs: Date.UTC(2026, 6, 14, 23, 59, 59, 999),
      afterBoundaryMs: Date.UTC(2026, 6, 15, 0, 0, 0, 0),
    },
    {
      costWindow: 'week',
      beforeBoundaryMs: Date.UTC(2026, 6, 19, 23, 59, 59, 999),
      afterBoundaryMs: Date.UTC(2026, 6, 20, 0, 0, 0, 0),
    },
    {
      costWindow: 'month',
      beforeBoundaryMs: Date.UTC(2026, 6, 31, 23, 59, 59, 999),
      afterBoundaryMs: Date.UTC(2026, 7, 1, 0, 0, 0, 0),
    },
    {
      costWindow: 'quarter',
      beforeBoundaryMs: Date.UTC(2026, 8, 30, 23, 59, 59, 999),
      afterBoundaryMs: Date.UTC(2026, 9, 1, 0, 0, 0, 0),
    },
  ])('does not reuse a stale $costWindow snapshot after its UTC boundary rolls over', async ({
    costWindow,
    beforeBoundaryMs,
    afterBoundaryMs,
  }) => {
    let nowMs = beforeBoundaryMs;
    const getModelUsageData = vi.fn<AdminModelUsageService['getModelUsageData']>()
      .mockResolvedValueOnce(makeUsageData({}, { calls: 8, totalCostUsd: 0.08 }))
      .mockRejectedValueOnce(new Error('postgres offline after rollover'));
    const service = new AdminDashboardDataService({
      ...makeBaseDeps(),
      modelUsageService: { getModelUsageData },
      now: () => nowMs,
    });

    const beforeBoundary = await service.getDashboardData({ costWindow });
    nowMs = afterBoundaryMs;
    const afterBoundary = await service.getDashboardData({ costWindow });

    expect(beforeBoundary.stats.modelUsage).toMatchObject({
      selected: costWindow,
      usage: { calls: 8 },
      freshness: { state: 'fresh' },
    });
    expect(getModelUsageData.mock.calls[0]?.[0]?.sinceMs)
      .not.toBe(getModelUsageData.mock.calls[1]?.[0]?.sinceMs);
    expect(afterBoundary.stats.modelUsage).toMatchObject({
      selected: costWindow,
      usage: null,
      freshness: { state: 'unavailable' },
    });
  });

  it('does not let an older same-range response replace the newer cached snapshot', async () => {
    const first = deferred<ModelUsageData>();
    const second = deferred<ModelUsageData>();
    const getModelUsageData = vi.fn<AdminModelUsageService['getModelUsageData']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const service = new AdminDashboardDataService({
      ...makeBaseDeps(),
      modelUsageService: { getModelUsageData },
      now: () => Date.UTC(2026, 6, 14, 8, 0, 0, 0),
    });

    const olderRequest = service.getDashboardData({ costWindow: 'week' });
    const newerRequest = service.getDashboardData({ costWindow: 'week' });
    second.resolve(makeUsageData({}, { calls: 2, totalCostUsd: 0.02 }));
    await newerRequest;
    first.resolve(makeUsageData({}, { calls: 1, totalCostUsd: 0.01 }));
    await olderRequest;
    getModelUsageData.mockRejectedValueOnce(new Error('refresh failed'));

    const stale = await service.getDashboardData({ costWindow: 'week' });

    expect(stale.stats.modelUsage).toMatchObject({
      usage: { calls: 2, effectiveCostUsd: 0.02 },
      freshness: { state: 'stale' },
    });
  });

  it('keeps out-of-order concurrent range responses attached to their requested range', async () => {
    const today = deferred<ModelUsageData>();
    const month = deferred<ModelUsageData>();
    const getModelUsageData = vi.fn<AdminModelUsageService['getModelUsageData']>()
      .mockReturnValueOnce(today.promise)
      .mockReturnValueOnce(month.promise);
    const service = new AdminDashboardDataService({
      ...makeBaseDeps(),
      modelUsageService: { getModelUsageData },
      now: () => Date.UTC(2026, 6, 14, 9, 0, 0, 0),
    });

    const todayRequest = service.getDashboardData({ costWindow: 'today' });
    const monthRequest = service.getDashboardData({ costWindow: 'month' });
    month.resolve(makeUsageData({}, { calls: 30, totalCostUsd: 0.3 }));
    const monthResponse = await monthRequest;
    today.resolve(makeUsageData({}, { calls: 1, totalCostUsd: 0.01 }));
    const todayResponse = await todayRequest;

    expect(monthResponse.stats.modelUsage).toMatchObject({
      selected: 'month', usage: { calls: 30, effectiveCostUsd: 0.3 },
    });
    expect(todayResponse.stats.modelUsage).toMatchObject({
      selected: 'today', usage: { calls: 1, effectiveCostUsd: 0.01 },
    });
  });
});
