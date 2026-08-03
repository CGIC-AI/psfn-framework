import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type { ModelUsageData, ModelUsageQuery, ModelUsageTotals } from '../../../shared/telemetry/model-usage.js';
import { MODEL_USAGE_GROUP_DIMENSIONS } from '../../../shared/telemetry/model-usage-attribution.js';
import { AdminDashboardDataService } from './dashboard-service.js';
import type { AdminAdaptiveToolsService, AdminModelUsageService } from './types.js';
import { startOfDashboardUtcWeek } from './dashboard-cost-windows.js';
import type { AnalysisWorkbenchTraceView, DashboardCostWindow } from '../types.js';
import type { AnalysisWorkbenchTraceStorePort } from '../../../persistence/postgres/analysis-workbench-trace-store.js';
import type { GardenRequestContext } from '../garden-request-context.js';

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
    attributionAnomalies: {
      unknownChargeLaneCalls: totals.calls,
      unknownChargeLaneRatePercent: totals.calls > 0 ? 100 : 0,
      unknownSessionCalls: totals.calls,
      unknownSessionRatePercent: totals.calls > 0 ? 100 : 0,
    },
    recentEvents: [],
    expensiveEvents: [],
  };
}

function makeBaseDeps(eventBus = new EventBus()): {
  eventBus: EventBus;
  getMemoryStatsForRequest: () => Promise<{ total: number; avgSalience: number; byType: Record<string, number> }>;
  sessionStore: SessionStore;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
} {
  return {
    eventBus,
    getMemoryStatsForRequest: async () => ({ total: 0, avgSalience: 0, byType: {} }),
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
  it('reads memory stats through the exact admitted request context', async () => {
    const deps = makeBaseDeps();
    const context = { kind: 'fleet_principal' } as GardenRequestContext;
    const getStatsForRequest = vi.fn(async () => ({
      total: 2,
      byType: { semantic: 1, procedural: 1 },
      avgSalience: 0.5,
    }));
    const service = new AdminDashboardDataService({
      ...deps,
      getMemoryStatsForRequest: getStatsForRequest,
    });

    const dashboard = await service.getDashboardData({}, context);

    expect(getStatsForRequest).toHaveBeenCalledWith(context);
    expect(dashboard.stats).toMatchObject({
      memoryTotal: 2,
      memoryByType: { semantic: 1, procedural: 1 },
      avgSalience: 0.5,
    });
  });

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

class FakeAnalysisWorkbenchTraceStore implements AnalysisWorkbenchTraceStorePort {
  readonly rows: AnalysisWorkbenchTraceView[] = [];
  constructor(private readonly cap: number, seed: AnalysisWorkbenchTraceView[] = []) {
    this.rows.push(...seed);
  }

  record(trace: AnalysisWorkbenchTraceView): Promise<void> {
    this.rows.unshift(trace);
    this.rows.sort((a, b) => b.timestamp - a.timestamp);
    if (this.rows.length > this.cap) this.rows.length = this.cap;
    return Promise.resolve();
  }

  listRecent(limit: number): Promise<AnalysisWorkbenchTraceView[]> {
    return Promise.resolve(this.rows.slice(0, limit));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function emitTrace(eventBus: EventBus, timestamp: number, task: string): Promise<void> {
  await eventBus.emit('agent.analysis_workbench.trace', {
    timestamp,
    task,
    result: {
      iterations: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      durationMs: 42,
      truncated: false,
      budgetStop: null,
      subQueries: 0,
      toolCalls: 0,
      sessionCostUsd: 0,
      warnings: [],
      nestedAnalysis: {
        nestedAnalysisCallCount: 0,
        nestedAnalysisSuccessCount: 0,
        nestedAnalysisFailureCount: 0,
        maxNestedAnalysisDepthReached: 0,
      },
      steps: [{
        iteration: 1,
        timestamp,
        code: 'print(1)',
        output: '1',
        error: null,
        inputTokens: 10,
        outputTokens: 5,
        cumulativeTokens: 15,
        durationMs: 42,
        variablesChanged: [],
      }],
    },
  });
}

describe('AdminDashboardDataService analysis-workbench trace persistence (vb11)', () => {
  it('write-through persists each recorded trace to the durable store', async () => {
    const eventBus = new EventBus();
    const deps = makeBaseDeps(eventBus);
    const store = new FakeAnalysisWorkbenchTraceStore(50);
    const service = new AdminDashboardDataService({ ...deps, analysisWorkbenchTraceStore: store });
    await Promise.resolve();

    await emitTrace(eventBus, 1000, 'first');
    await emitTrace(eventBus, 2000, 'second');

    expect(store.rows.map((row) => row.task)).toEqual(['second', 'first']);
    expect(service.listAnalysisWorkbenchTraces().map((row) => row.task)).toEqual(['second', 'first']);
  });

  it('rehydrates the ring from the durable store after a restart', async () => {
    const persisted: AnalysisWorkbenchTraceView = {
      timestamp: 5000,
      task: 'survivor',
      iterations: 1,
      totalTokens: 15,
      durationMs: 42,
      truncated: false,
      budgetStop: null,
      steps: [],
    };
    // A fresh service instance (simulating a Garden restart) with a store that
    // already holds a trace recorded before the restart.
    const store = new FakeAnalysisWorkbenchTraceStore(50, [persisted]);
    const eventBus = new EventBus();
    const service = new AdminDashboardDataService({
      ...makeBaseDeps(eventBus),
      analysisWorkbenchTraceStore: store,
    });
    // Allow the async hydrate kicked off in the constructor to settle.
    await vi.waitFor(() => {
      expect(service.listAnalysisWorkbenchTraces()).toHaveLength(1);
    });

    expect(service.listAnalysisWorkbenchTraces()[0]).toMatchObject({ task: 'survivor' });
  });

  it('keeps the durable ring bounded to the 50-entry window', async () => {
    const eventBus = new EventBus();
    const store = new FakeAnalysisWorkbenchTraceStore(50);
    const service = new AdminDashboardDataService({
      ...makeBaseDeps(eventBus),
      analysisWorkbenchTraceStore: store,
    });
    await Promise.resolve();

    for (let i = 1; i <= 60; i += 1) {
      await emitTrace(eventBus, i * 1000, `task-${i}`);
    }

    expect(store.rows).toHaveLength(50);
    expect(service.listAnalysisWorkbenchTraces()).toHaveLength(50);
    expect(store.rows[0].task).toBe('task-60');
    expect(store.rows[49].task).toBe('task-11');
  });
});
