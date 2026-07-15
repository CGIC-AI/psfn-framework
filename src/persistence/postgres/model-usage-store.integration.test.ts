import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPostgresPool } from '../postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresModelUsageStore } from './model-usage-store.js';
import type {
  ModelUsageEventInput,
  ModelUsageGroupDimension,
} from '../../shared/telemetry/model-usage.js';
import { EventBus } from '../../shared/event-bus.js';
import { SessionManager } from '../../core/session/manager.js';
import { SessionStore } from '../sessions/store.js';
import { TurnSupportRuntime } from '../../core/agent/substrate-agent/turn-support-runtime.js';
import { createTurnId } from '../../core/turns/id.js';
import { withEmbeddingUsageAccounting } from '../../faculties/memory/embedding-accounting.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { AdminModelUsageDataService } from '../../operator/garden/services/model-usage-service.js';
import { AdminChargeCostReconciliationDataService } from '../../operator/garden/services/charge-cost-reconciliation-service.js';
import { AdminDashboardDataService } from '../../operator/garden/services/dashboard-service.js';
import { startOfDashboardUtcDay } from '../../operator/garden/services/dashboard-cost-windows.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import { LLMClient } from '../../primitives/llm/client.js';
import { DefaultImageVisionReviewer } from '../../primitives/images/vision-reviewer.js';
import { createGenerateImageTool } from '../../primitives/images/tools.js';
import {
  getRunChargeSnapshot,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import type { ChargePolicyConfig } from '../../shared/contracts/charge-policy.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
import type { AdminModelUsageService } from '../../operator/garden/services/types.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';

const piMocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  completeSimple: piMocks.completeSimple,
}));

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withStore<T>(handler: (store: PostgresModelUsageStore, pool: Pool) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'model-usage-private-telemetry-test',
    allowExitOnIdle: true,
    max: 2,
  });
  try {
    return await handler(new PostgresModelUsageStore(pool), pool);
  } finally {
    await pool.end();
  }
}

describe('PostgresModelUsageStore private telemetry', () => {
  it('retains aggregate cost while filtering private details and source correlation', async () => {
    await withStore(async (store) => {
      await store.recordUsageEvent({
        logicalCallId: 'visible-call',
        status: 'success',
        callKind: 'completion',
        attribution: {
          companionId: 'companion-a',
          callType: 'background',
          purpose: 'background',
        },
        provider: 'litellm',
        model: 'visible-model',
        inputTokens: 10,
        outputTokens: 5,
        providerCostUsd: 0.1,
      });
      await store.recordUsageEvent({
        logicalCallId: 'private-call',
        status: 'success',
        callKind: 'completion',
        telemetryVisibility: 'companion_private',
        attribution: {
          companionId: 'companion-a',
          callType: 'background',
          purpose: 'background',
          turnId: 'source-turn',
          requestId: 'source-request',
          channelId: 'source-channel',
        },
        provider: 'litellm',
        model: 'private-model',
        inputTokens: 20,
        outputTokens: 10,
        providerCostUsd: 0.5,
      });

      const aggregate = await store.getUsageData({ limit: 10 });
      const operator = await store.getUsageData({ limit: 10, telemetryVisibility: 'operator_visible' });
      const privateEvent = aggregate.recentEvents.find(event => event.logicalCallId === 'private-call');

      expect(aggregate.totals).toMatchObject({ calls: 2, totalTokens: 45, totalCostUsd: 0.6 });
      expect(operator.totals).toMatchObject({ calls: 1, totalTokens: 15, totalCostUsd: 0.1 });
      expect(operator.recentEvents.map(event => event.logicalCallId)).toEqual(['visible-call']);
      expect(privateEvent).toMatchObject({ telemetryVisibility: 'companion_private' });
      // companion_private events never persist re-identifying source correlation.
      expect(privateEvent?.attribution.turnId).toBe('unknown');
      expect(privateEvent?.attribution.requestId).toBe('unknown');
      expect(privateEvent?.attribution.channelId).toBe('unknown');
    });
  }, INTEGRATION_TIMEOUT_MS);
});

function makeSessionConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16_384, contextWindow: 1_000 },
    },
  };
}

function makeVisionConfig(dataDir: string): SubstrateConfig {
  return {
    ...makeSessionConfig(dataDir),
    companionId: 'companion-a',
    primaryModel: 'vision-model',
    primaryProvider: 'openrouter',
    modelRegistry: {
      schemaVersion: 1,
      models: [{
        id: 'vision',
        rank: 10,
        identity: {
          provider: 'openrouter',
          model: 'vision-model',
          source: { type: 'openrouter' },
        },
        purposes: [{ purpose: 'vision', primary: true }],
        capabilities: {
          maxOutputTokens: 1024,
          contextWindow: 16_384,
          supportsVision: true,
        },
        tuning: { maxOutputTokens: 1024 },
      }],
    },
  };
}

function makeVisionChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 10,
      background: 10,
      maintenance: 10,
      subagent: 10,
      shard: 10,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 1,
      localImageGeneration: 0,
      paidImageGeneration: 1,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 1,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 1,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 1,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

describe('PostgresModelUsageStore reconciliation', () => {
  it('runs one tenant-scoped analytics grammar across DST buckets, groups, cursors, and export', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-analytics-contract',
      allowExitOnIdle: true,
      max: 2,
    });
    const store = new PostgresModelUsageStore(pool, { companionId: 'analytics-companion' });
    const sinceMs = Date.parse('2026-03-08T05:00:00.000Z');
    const untilMs = Date.parse('2026-03-09T04:00:00.000Z');
    const event = (
      id: string,
      recordedAtMs: number,
      provider: string,
      status: 'success' | 'failure',
      totalCost: number,
    ): ModelUsageEventInput => ({
      logicalCallId: id,
      recordedAtMs,
      startedAtMs: recordedAtMs - 250,
      completedAtMs: recordedAtMs,
      durationMs: 250,
      ttftMs: 50,
      status,
      settlement: status === 'success' ? 'complete' : 'partial',
      callKind: 'chat',
      attribution: {
        companionId: 'analytics-companion',
        channelId: `${provider}-channel`,
        channelType: 'api',
        callType: 'chat',
        purpose: 'analytics-contract',
      },
      provider,
      model: `${provider}-model`,
      inputTokens: 10,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      outputTokens: 5,
      totalTokens: 20,
      providerCost: {
        input: totalCost / 4,
        cacheRead: totalCost / 4,
        cacheWrite: totalCost / 4,
        output: totalCost / 4,
        total: totalCost,
      },
      effectiveCost: {
        input: totalCost / 4,
        cacheRead: totalCost / 4,
        cacheWrite: totalCost / 4,
        output: totalCost / 4,
        total: totalCost,
      },
      costSource: 'provider',
      currency: 'USD',
    });

    try {
      await store.recordUsageEvent(event('analytics-a', sinceMs + 30 * 60_000, 'provider-a', 'success', 0.03));
      await store.recordUsageEvent(event('analytics-b', sinceMs + 2.5 * 60 * 60_000, 'provider-b', 'failure', 0.02));
      await store.recordUsageEvent(event('analytics-c', sinceMs + 10 * 60 * 60_000, 'provider-c', 'success', 0.01));

      const query = {
        range: 'custom' as const,
        sinceMs,
        untilMs,
        timezone: 'America/New_York',
        bucket: 'hour' as const,
        groupBy: ['provider', 'status'] as ModelUsageGroupDimension[],
        topN: 1,
        limit: 2,
      };
      const first = await store.getUsageData(query);
      expect(first.resolvedRange).toMatchObject({
        sinceMs,
        untilMs,
        timezone: 'America/New_York',
        bucket: 'hour',
        boundary: '[sinceMs, untilMs)',
      });
      expect(first.totals).toMatchObject({
        calls: 3,
        successfulCalls: 2,
        failedCalls: 1,
        inputTokens: 30,
        cacheReadTokens: 9,
        cacheWriteTokens: 6,
        outputTokens: 15,
        totalTokens: 60,
        providerCostUsd: 0.06,
        totalCostUsd: 0.06,
        totalDurationMs: 750,
        averageTtftMs: 50,
      });
      expect(first.totals.providerCost).toMatchObject({
        inputUsd: 0.015,
        inputKnownCalls: 3,
        cacheReadUsd: 0.015,
        cacheWriteUsd: 0.015,
        outputUsd: 0.015,
        totalKnownCalls: 3,
      });
      expect(first.timeSeries).toHaveLength(23);
      expect(first.timeSeries.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(3);
      expect(first.timeSeries.filter(bucket => bucket.calls === 0)).toHaveLength(20);
      expect(first.groups).toHaveLength(2);
      expect(first.groups[0]).toMatchObject({
        dimensions: { provider: 'provider-a', status: 'success' },
        isOther: false,
        metrics: { calls: 1, totalCostUsd: 0.03 },
      });
      expect(first.groups[1]).toMatchObject({ isOther: true, metrics: { calls: 2, totalCostUsd: 0.03 } });
      expect(first.groups.reduce((sum, group) => sum + group.metrics.calls, 0)).toBe(first.totals.calls);

      const ascending = await store.getUsageData({
        ...query,
        sortBy: 'effectiveCostUsd',
        sortDirection: 'asc',
      });
      expect(ascending.groups[0]).toMatchObject({
        dimensions: { provider: 'provider-c', status: 'success' },
        metrics: { totalCostUsd: 0.01 },
      });

      expect(first.eventPage.items.map(item => item.id)).toEqual(['analytics-c:0', 'analytics-b:0']);
      expect(first.eventPage.hasMore).toBe(true);
      const second = await store.getUsageData({ ...query, cursor: first.eventPage.nextCursor ?? undefined });
      expect(second.eventPage.items.map(item => item.id)).toEqual(['analytics-a:0']);
      expect(second.eventPage.hasMore).toBe(false);
      await expect(store.getUsageData({ ...query, provider: 'different', cursor: first.eventPage.nextCursor ?? undefined }))
        .rejects.toThrow('cursor');

      const expensive = await store.getUsageData({ ...query, eventOrder: 'expensive' });
      expect(expensive.eventPage.items.map(item => item.id)).toEqual(['analytics-a:0', 'analytics-b:0']);

      const exported = await store.exportUsageEvents(query);
      expect(exported.rows.map(row => row.id)).toEqual(['analytics-a:0', 'analytics-b:0', 'analytics-c:0']);
      expect(exported.rows[0]).not.toHaveProperty('metadata');
      expect(exported.rows[0]).not.toHaveProperty('errorMessage');
      expect((await store.getUsageData({ ...query, provider: "provider-a' OR 1=1 --" })).totals.calls).toBe(0);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('reconciles canonical PostgreSQL attempts with the original charge ledger after restart', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'charge-cost-reconciliation-writer',
      allowExitOnIdle: true,
      max: 1,
    });
    const operatorPool = createPostgresPool(databaseUrl, {
      applicationName: 'charge-cost-reconciliation-operator',
      allowExitOnIdle: true,
      max: 1,
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'charge-cost-reconciliation-'));
    const ledgerPath = join(dataDir, 'charge-ledger.jsonl');
    const nowMs = Date.UTC(2026, 6, 14, 12, 0, 0);
    const writer = new PostgresModelUsageStore(writerPool, { companionId: 'companion-a' });
    const firstLedger = new RunChargeLedger(ledgerPath, null, { now: () => nowMs });
    try {
      firstLedger.recordChargeEvent({
        eventId: 'charge-exact',
        timestampMs: nowMs - 1_000,
        lane: 'interactive',
        surface: 'externalModelConsult',
        amount: 3,
        quota: 10,
        spentAfter: 3,
        remainingAfter: 7,
        lineage: { runId: 'run-exact', rootRunId: 'root-exact' },
        companionId: 'companion-a',
        channelId: 'channel-a',
      });
      firstLedger.recordChargeEvent({
        eventId: 'charge-non-model',
        timestampMs: nowMs - 900,
        lane: 'interactive',
        surface: 'memoryRead',
        amount: 2,
        quota: 10,
        spentAfter: 5,
        remainingAfter: 5,
        lineage: { runId: 'run-memory', rootRunId: 'root-memory' },
        companionId: 'companion-a',
        channelId: 'channel-a',
      });
      await writer.recordUsageEvent({
        logicalCallId: 'usage-exact',
        attempt: 1,
        recordedAtMs: nowMs - 800,
        status: 'success',
        settlement: 'complete',
        callKind: 'chat',
        attribution: {
          companionId: 'companion-a',
          channelId: 'channel-a',
          callType: 'chat',
          purpose: 'reconciliation-test',
          chargeEventId: 'charge-exact',
          chargeLane: 'interactive',
          chargeSurface: 'externalModelConsult',
          chargeRunId: 'run-exact',
          chargeRootRunId: 'root-exact',
        },
        provider: 'provider-a',
        model: 'model-a',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        providerCost: { total: 0.5 },
        effectiveCost: { total: 0.5 },
        costSource: 'provider',
        currency: 'USD',
      });
      await writer.recordUsageEvent({
        logicalCallId: 'usage-unmatched',
        attempt: 1,
        recordedAtMs: nowMs - 700,
        status: 'success',
        settlement: 'complete',
        callKind: 'completion',
        attribution: {
          companionId: 'companion-a',
          channelId: 'channel-a',
          callType: 'background',
          purpose: 'reconciliation-test',
          chargeEventId: 'missing-charge',
          chargeLane: 'background',
          chargeSurface: 'externalModelConsult',
          chargeRunId: 'run-missing',
          chargeRootRunId: 'root-missing',
        },
        provider: 'provider-b',
        model: 'model-b',
        inputTokens: 4,
        outputTokens: 1,
        totalTokens: 5,
        providerCost: { total: 0.3 },
        effectiveCost: { total: 0.3 },
        costSource: 'provider',
        currency: 'USD',
      });
      firstLedger.close();

      const restartedLedger = new RunChargeLedger(ledgerPath, null, { now: () => nowMs });
      const operatorStore = new PostgresModelUsageStore(operatorPool, { companionId: 'companion-a' });
      const service = new AdminChargeCostReconciliationDataService(
        restartedLedger,
        operatorStore,
        'companion-a',
      );
      const data = await service.getChargeCostReconciliation({
        sinceMs: nowMs - 2_000,
        untilMs: nowMs,
      });

      expect(data.sourceTotals).toMatchObject({
        chargeUnits: 5,
        chargeEvents: 2,
        calls: 2,
        providerCostUsd: 0.8,
        effectiveCostUsd: 0.8,
      });
      expect(data.buckets.attributable).toMatchObject({
        chargeUnits: 3,
        calls: 1,
        effectiveCostUsd: 0.5,
        dollarsPerChargeUnit: 0.166666666667,
      });
      expect(data.buckets.nonModelCharges).toMatchObject({ chargeUnits: 2, calls: 0 });
      expect(data.buckets.usageWithoutCharge).toMatchObject({
        chargeUnits: 0,
        calls: 1,
        effectiveCostUsd: 0.3,
      });
      expect(data.breakdowns.byModel).toEqual([
        expect.objectContaining({ key: 'provider-a:model-a', chargeUnits: 3, calls: 1 }),
      ]);
      restartedLedger.close();
    } finally {
      firstLedger.close();
      await writerPool.end();
      await operatorPool.end();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('reconciles the dashboard selected range with canonical usage across process and operator restarts', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-dashboard-writer',
      allowExitOnIdle: true,
      max: 1,
    });
    const operatorPool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-dashboard-operator',
      allowExitOnIdle: true,
      max: 1,
    });
    const nowMs = Date.UTC(2026, 6, 14, 12, 0, 0, 0);
    const writer = new PostgresModelUsageStore(writerPool, { companionId: 'dashboard-companion' });
    const operatorStore = new PostgresModelUsageStore(operatorPool, { companionId: 'dashboard-companion' });
    const modelUsage = new AdminModelUsageDataService(operatorStore);
    const makeDashboard = () => new AdminDashboardDataService({
      memoryStore: {
        getStats: () => ({ total: 0, avgSalience: 0, byType: {} }),
      } as MemoryStorePort,
      sessionStore: {
        listChannels: () => [],
      } as unknown as SessionStore,
      scheduler: { taskCount: 0 } as Scheduler,
      shardManager: {
        getActiveCount: () => 0,
        getActiveShards: () => [],
      } as unknown as ShardExecutionPort,
      eventBus: new EventBus(),
      modelUsageService: modelUsage,
      now: () => nowMs,
    });

    try {
      await writer.recordUsageEvent({
        logicalCallId: 'dashboard-provider-call',
        recordedAtMs: nowMs - 2_000,
        startedAtMs: nowMs - 2_100,
        status: 'success',
        settlement: 'complete',
        callKind: 'chat',
        attribution: {
          companionId: 'dashboard-companion',
          callType: 'chat',
          purpose: 'dashboard-reconciliation',
        },
        provider: 'provider-a',
        model: 'model-a',
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        totalTokens: 190,
        providerCost: { input: 0.006, output: 0.008, cacheRead: 0.002, cacheWrite: 0.004, total: 0.02 },
        estimatedCost: { total: 0.03 },
        effectiveCost: { input: 0.006, output: 0.008, cacheRead: 0.002, cacheWrite: 0.004, total: 0.02 },
        providerCostUsd: 0.02,
        estimatedCostUsd: 0.03,
        effectiveCostUsd: 0.02,
        costSource: 'provider',
        currency: 'USD',
      });
      await writer.recordUsageEvent({
        logicalCallId: 'dashboard-estimated-call',
        recordedAtMs: nowMs - 1_000,
        startedAtMs: nowMs - 1_100,
        status: 'failure',
        settlement: 'partial',
        callKind: 'completion',
        attribution: {
          companionId: 'dashboard-companion',
          callType: 'background',
          purpose: 'dashboard-reconciliation',
        },
        provider: 'provider-b',
        model: 'model-b',
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 67,
        estimatedCost: { total: 0.04 },
        effectiveCost: { total: 0.04 },
        estimatedCostUsd: 0.04,
        effectiveCostUsd: 0.04,
        costSource: 'estimate',
        currency: 'USD',
      });

      const query = { sinceMs: startOfDashboardUtcDay(nowMs), untilMs: nowMs, limit: 1 };
      const canonical = await modelUsage.getModelUsageData(query);
      const firstDashboard = await makeDashboard().getDashboardData({ costWindow: 'today' });

      expect(firstDashboard.stats.modelUsage.usage).toEqual({
        calls: canonical.totals.calls,
        successfulCalls: canonical.totals.successfulCalls,
        failedCalls: canonical.totals.failedCalls,
        inputTokens: canonical.totals.inputTokens,
        outputTokens: canonical.totals.outputTokens,
        cacheReadTokens: canonical.totals.cacheReadTokens,
        cacheWriteTokens: canonical.totals.cacheWriteTokens,
        totalTokens: canonical.totals.totalTokens,
        providerCostUsd: canonical.totals.providerCostUsd,
        estimatedCostUsd: canonical.totals.estimatedCostUsd,
        effectiveCostUsd: canonical.totals.totalCostUsd,
      });
      expect(firstDashboard.stats.modelUsage.usage).toMatchObject({
        calls: 2,
        successfulCalls: 1,
        failedCalls: 1,
        inputTokens: 150,
        outputTokens: 50,
        cacheReadTokens: 35,
        cacheWriteTokens: 22,
        totalTokens: 257,
        providerCostUsd: 0.02,
        estimatedCostUsd: 0.07,
        effectiveCostUsd: 0.06,
      });
      expect(firstDashboard.stats.modelUsage.freshness.latestEventAtMs).toBe(nowMs - 1_000);

      await writer.recordUsageEvent({
        logicalCallId: 'dashboard-cross-process-call',
        recordedAtMs: nowMs - 500,
        startedAtMs: nowMs - 600,
        status: 'success',
        settlement: 'complete',
        callKind: 'embedding',
        attribution: {
          companionId: 'dashboard-companion',
          callType: 'memory',
          purpose: 'dashboard-cross-process-refresh',
        },
        provider: 'provider-c',
        model: 'model-c',
        inputTokens: 25,
        totalTokens: 25,
        estimatedCost: { total: 0.01 },
        effectiveCost: { total: 0.01 },
        estimatedCostUsd: 0.01,
        effectiveCostUsd: 0.01,
        costSource: 'estimate',
        currency: 'USD',
      });

      const restartedOperator = await makeDashboard().getDashboardData({ costWindow: 'today' });
      expect(restartedOperator.stats.modelUsage).toMatchObject({
        selected: 'today',
        usage: { calls: 3, totalTokens: 282, effectiveCostUsd: 0.07 },
        freshness: {
          state: 'fresh',
          source: 'postgres_model_usage',
          dataThroughMs: nowMs,
          latestEventAtMs: nowMs - 500,
        },
      });
      expect(restartedOperator.stats.transientSessionTelemetry.turnsSinceOperatorStart).toBe(0);
    } finally {
      await Promise.all([writerPool.end(), operatorPool.end()]);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('moves the same dashboard from unavailable to fresh to stale across real PostgreSQL outages', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseName, databaseUrl } = await harness.createDatabase();
    if (!/^psfn_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error(`Unexpected Postgres test database name: ${databaseName}`);
    }
    const adminPool = createPostgresPool(harness.adminDatabaseUrl, {
      applicationName: 'model-usage-dashboard-outage-admin',
      allowExitOnIdle: true,
      max: 1,
    });
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-dashboard-outage-writer',
      allowExitOnIdle: true,
      max: 1,
    });
    const unavailablePool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-dashboard-outage-unavailable',
      allowExitOnIdle: true,
      max: 1,
    });
    const recoveryPool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-dashboard-outage-recovery',
      allowExitOnIdle: true,
      max: 1,
    });
    // Terminated idle clients emit pool-level errors outside the awaited query path.
    // Capture those expected outage signals so they cannot become unhandled events.
    const expectedPoolErrors: Error[] = [];
    for (const pool of [writerPool, unavailablePool, recoveryPool]) {
      pool.on('error', error => expectedPoolErrors.push(error));
    }
    const setDatabaseAvailability = async (available: boolean): Promise<void> => {
      await adminPool.query(
        `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS ${available ? 'true' : 'false'}`,
      );
      if (!available) {
        await adminPool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [databaseName],
        );
      }
    };
    const nowMs = Date.UTC(2026, 6, 14, 13, 0, 0, 0);
    const companionId = 'dashboard-outage-companion';
    const writer = new PostgresModelUsageStore(writerPool, { companionId });
    const unavailableStore = new PostgresModelUsageStore(unavailablePool, { companionId });
    const recoveryStore = new PostgresModelUsageStore(recoveryPool, { companionId });
    let activeModelUsageService = new AdminModelUsageDataService(unavailableStore);
    const switchableModelUsageService: AdminModelUsageService = {
      getModelUsageData: query => activeModelUsageService.getModelUsageData(query),
    };
    const dashboard = new AdminDashboardDataService({
      memoryStore: {
        getStats: () => ({ total: 0, avgSalience: 0, byType: {} }),
      } as MemoryStorePort,
      sessionStore: {
        listChannels: () => [],
      } as unknown as SessionStore,
      scheduler: { taskCount: 0 } as Scheduler,
      shardManager: {
        getActiveCount: () => 0,
        getActiveShards: () => [],
      } as unknown as ShardExecutionPort,
      eventBus: new EventBus(),
      modelUsageService: switchableModelUsageService,
      now: () => nowMs,
    });

    try {
      await writer.recordUsageEvent({
        logicalCallId: 'dashboard-outage-call',
        recordedAtMs: nowMs - 1_000,
        startedAtMs: nowMs - 1_100,
        status: 'success',
        settlement: 'complete',
        callKind: 'completion',
        attribution: {
          companionId,
          callType: 'background',
          purpose: 'dashboard-outage-recovery',
        },
        provider: 'provider-a',
        model: 'model-a',
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        providerCost: { total: 0.02 },
        effectiveCost: { total: 0.02 },
        providerCostUsd: 0.02,
        effectiveCostUsd: 0.02,
        costSource: 'provider',
        currency: 'USD',
      });
      await unavailableStore.getUsageData({ limit: 1 });
      await setDatabaseAvailability(false);

      const unavailable = await dashboard.getDashboardData({ costWindow: 'today' });
      expect(unavailable.stats.modelUsage).toMatchObject({
        usage: null,
        freshness: { state: 'unavailable', source: 'postgres_model_usage' },
      });

      await setDatabaseAvailability(true);
      activeModelUsageService = new AdminModelUsageDataService(recoveryStore);
      const fresh = await dashboard.getDashboardData({ costWindow: 'today' });
      expect(fresh.stats.modelUsage).toMatchObject({
        usage: { calls: 1, totalTokens: 15, effectiveCostUsd: 0.02 },
        freshness: {
          state: 'fresh',
          source: 'postgres_model_usage',
          latestEventAtMs: nowMs - 1_000,
        },
      });

      await setDatabaseAvailability(false);
      const stale = await dashboard.getDashboardData({ costWindow: 'today' });
      expect(stale.stats.modelUsage).toMatchObject({
        usage: { calls: 1, totalTokens: 15, effectiveCostUsd: 0.02 },
        freshness: { state: 'stale', source: 'postgres_model_usage' },
      });
      expect(expectedPoolErrors.every(error => (
        /terminating connection|connection terminated/i.test(error.message)
      ))).toBe(true);
    } finally {
      await setDatabaseAvailability(true);
      await Promise.all([writerPool.end(), unavailablePool.end(), recoveryPool.end()]);
      await adminPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('serializes eager migrations across independent stores on a pristine database', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pools = Array.from({ length: 12 }, (_, index) => createPostgresPool(databaseUrl, {
      applicationName: `model-usage-concurrent-${index}`,
      allowExitOnIdle: true,
      max: 1,
    }));
    const stores = pools.map(pool => new PostgresModelUsageStore(pool, {
      companionId: 'companion-concurrent',
    }));

    try {
      await Promise.all(stores.map(async (store, index) => {
        await store.recordUsageEvent({
          logicalCallId: `concurrent-call-${index}`,
          recordedAtMs: 1_752_300_000_000 + index,
          startedAtMs: 1_752_299_999_900 + index,
          status: 'success',
          callKind: 'completion',
          attribution: { callType: 'background', purpose: 'concurrent-startup' },
          provider: 'test-provider',
          model: 'test-model',
          inputTokens: 1,
          totalTokens: 1,
          costSource: 'none',
        });
      }));
      const results = await Promise.all(stores.map(store => store.getUsageData({ limit: 1 })));
      expect(results).toHaveLength(12);
      expect(results.every(result => result.totals.calls === 12)).toBe(true);
    } finally {
      await Promise.all(pools.map(pool => pool.end()));
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('persists production logical-conversation attribution through embedding accounting', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-conversation-attribution',
      allowExitOnIdle: true,
      max: 1,
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'model-usage-conversation-'));
    try {
      const sessionManager = new SessionManager(
        new SessionStore(dataDir),
        makeSessionConfig(dataDir),
      );
      const runtime = new TurnSupportRuntime({
        eventBus: new EventBus(),
        sessionManager,
        hashPromptText: text => `hash:${text.length}`,
        resolveContextWindow: () => 1_000,
      });
      const sourceChannelId = 'discord:guild:conversation-room';
      const reset = sessionManager.resetSourceChannelSession({
        sourceChannelId,
        actor: 'operator',
        reason: 'clean conversation boundary',
        mode: 'fresh_split',
      });
      const correlation = runtime.buildTurnCorrelation({
        id: 'root-initiation-1',
        channelId: sourceChannelId,
        channelType: 'discord',
        authorId: 'user-1',
        authorName: 'User',
        content: 'begin the new conversation',
        timestamp: new Date('2026-07-14T00:00:00.000Z'),
      }, 'chat', createTurnId(), 'root-initiation-1');
      const store = new PostgresModelUsageStore(pool, { companionId: 'companion-a' });
      const accountedEmbedding = withEmbeddingUsageAccounting({
        kind: 'api' as const,
        model: 'test-embedding-model',
        dims: 2,
        async embed() { return new Float32Array([1, 2]); },
        async embedBatch() { return [new Float32Array([1, 2])]; },
        async embedBatchWithUsage() {
          return {
            embeddings: [new Float32Array([1, 2])],
            usageDetails: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          };
        },
      }, store, { companionId: 'companion-a' });

      await runWithRequestContext(correlation, async () => {
        await accountedEmbedding.embedBatch(['hello']);
      });

      const usage = await store.getUsageData({
        conversationId: reset.newLogicalSessionId,
        rootInitiationId: 'root-initiation-1',
        groupBy: ['sessionId', 'channelId'],
      });
      expect(usage.totals.calls).toBe(1);
      expect(usage.recentEvents[0]?.attribution).toMatchObject({
        sessionId: reset.newLogicalSessionId,
        channelId: sourceChannelId,
        conversationId: reset.newLogicalSessionId,
        rootInitiationId: 'root-initiation-1',
        chargeSurface: 'externalEmbedding',
      });
      expect(usage.groupedBy.sessionId?.[0]?.key).toBe(reset.newLogicalSessionId);
      expect(usage.groupedBy.channelId?.[0]?.key).toBe(sourceChannelId);
    } finally {
      await pool.end();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('persists charged vision provider work with complete logical-conversation attribution', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-vision-attribution',
      allowExitOnIdle: true,
      max: 1,
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'model-usage-vision-'));
    try {
      const config = makeVisionConfig(dataDir);
      const sessionManager = new SessionManager(new SessionStore(dataDir), config);
      const runtime = new TurnSupportRuntime({
        eventBus: new EventBus(),
        sessionManager,
        hashPromptText: text => `hash:${text.length}`,
        resolveContextWindow: () => 16_384,
      });
      const sourceChannelId = 'discord:guild:vision-room';
      const reset = sessionManager.resetSourceChannelSession({
        sourceChannelId,
        actor: 'operator',
        reason: 'fresh vision conversation',
        mode: 'fresh_split',
      });
      const correlation = runtime.buildTurnCorrelation({
        id: 'vision-root-initiation',
        channelId: sourceChannelId,
        channelType: 'discord',
        authorId: 'user-vision',
        authorName: 'Vision User',
        content: 'review these images',
        timestamp: new Date('2026-07-14T00:00:00.000Z'),
      }, 'chat', createTurnId(), 'vision-root-initiation');
      const store = new PostgresModelUsageStore(pool, { companionId: 'companion-a' });
      const providerSurfaces: Array<string | undefined> = [];
      const providerChargeEventIds: Array<string | undefined> = [];
      piMocks.completeSimple.mockImplementation(async () => {
        providerSurfaces.push(getRunChargeSnapshot()?.surface);
        providerChargeEventIds.push(getRunChargeSnapshot()?.chargeEventId);
        return {
          content: [{ type: 'text', text: 'The image is clear and consistent.' }],
          model: 'vision-model',
          usage: { input: 10, output: 5, totalTokens: 15 },
          stopReason: 'stop',
        };
      });
      const llmClient = new LLMClient(config, {
        litellmBaseUrl: 'http://litellm.test/v1',
        usageRecorder: store,
      });
      const reviewer = new DefaultImageVisionReviewer(config, {
        llmProvider: llmClient,
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
      });
      const tool = createGenerateImageTool({
        create: vi.fn(async () => ({
          provider: 'comfyui' as const,
          mode: 'create' as const,
          model: 'local-vision-image',
          fallbackUsed: false,
          images: [{ url: 'https://images.example.test/generated.png' }],
        })),
        edit: vi.fn(),
      }, reviewer);
      const executeInTurn = async (
        runId: string,
        params: Record<string, unknown>,
      ) => await runWithChargeContext({
        chargePolicy: makeVisionChargePolicy(),
        lane: 'interactive',
        runId,
      }, async () => await runWithRequestContext(correlation, async () => {
          await tool.execute(runId, params, undefined as never);
        }));

      await executeInTurn('vision-generated-review', {
        action: 'generate',
        provider: 'comfyui',
        prompt: 'a quiet reading room',
      });
      await executeInTurn('vision-direct-analyze', {
        action: 'analyze',
        input_urls: ['https://images.example.test/direct.png'],
        question: 'What is visible?',
      });

      expect(providerSurfaces).toEqual([
        'externalModelConsult',
        'externalModelConsult',
      ]);
      expect(providerChargeEventIds).toEqual([
        expect.any(String),
        expect.any(String),
      ]);
      expect(new Set(providerChargeEventIds).size).toBe(2);
      const usage = await store.getUsageData({ limit: 10 });
      expect(usage.totals.calls).toBe(2);
      expect(usage.recentEvents).toHaveLength(2);
      expect(usage.recentEvents.every(event => (
        event.attribution.sessionId === reset.newLogicalSessionId
        && event.attribution.channelId === sourceChannelId
        && event.attribution.channelType === 'discord'
        && event.attribution.conversationId === reset.newLogicalSessionId
        && event.attribution.rootInitiationId === 'vision-root-initiation'
        && event.attribution.chargeSurface === 'externalModelConsult'
        && providerChargeEventIds.includes(event.attribution.chargeEventId)
      ))).toBe(true);
      const exactChargeUsage = await store.getUsageEventsForReconciliation({
        chargeEventId: providerChargeEventIds[0],
      });
      expect(exactChargeUsage).toHaveLength(1);
    } finally {
      await pool.end();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps unknown historical prices explicit and independent of the event display window', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-garden-cost-hydration',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const store = new PostgresModelUsageStore(pool, { companionId: 'companion-a' });
      for (const index of [1, 2]) {
        await store.recordUsageEvent({
          logicalCallId: `garden-unpriced-${index}`,
          recordedAtMs: 1_752_600_000_000 + index,
          startedAtMs: 1_752_599_999_900 + index,
          status: 'success',
          settlement: 'complete',
          callKind: 'completion',
          attribution: {
            companionId: 'companion-a',
            sessionId: 'garden-session',
            channelId: 'channel-1',
            channelType: 'api',
            callType: 'background',
            purpose: 'garden-hydration',
          },
          provider: 'litellm',
          model: 'deepseek/deepseek-v4-pro',
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          costSource: 'none',
        });
      }
      const service = new AdminModelUsageDataService(store);
      const groupBy: ModelUsageGroupDimension[] = ['channelId', 'costSource'];

      const atLimitOne = await service.getModelUsageData({ groupBy, limit: 1 });
      const atLimitTwo = await service.getModelUsageData({ groupBy, limit: 2 });

      expect(atLimitOne.recentEvents).toHaveLength(1);
      expect(atLimitTwo.recentEvents).toHaveLength(2);
      expect(atLimitOne.totals.totalCostUsd).toBe(0);
      expect(atLimitTwo.totals.totalCostUsd).toBe(0);
      expect(atLimitOne.groupedBy).toEqual(atLimitTwo.groupedBy);
      expect(atLimitOne.groupedBy.channelId).toEqual([
        expect.objectContaining({ key: 'channel-1', calls: 2, totalCostUsd: 0 }),
      ]);
      expect(atLimitOne.groupedBy.costSource).toEqual([
        expect.objectContaining({ key: 'none', calls: 2, totalCostUsd: 0 }),
      ]);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('returns stable top-N plus Other independently of the event display window', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-garden-full-group-ranking',
      allowExitOnIdle: true,
      max: 2,
    });
    try {
      const store = new PostgresModelUsageStore(pool, { companionId: 'companion-a' });
      await Promise.all(Array.from({ length: 21 }, async (_, offset) => {
        const index = offset + 1;
        const suffix = String(index).padStart(2, '0');
        const isExpensiveOmittedGroup = index === 21;
        await store.recordUsageEvent({
          logicalCallId: `garden-ranked-${suffix}`,
          recordedAtMs: 1_752_700_000_000 + index,
          startedAtMs: 1_752_699_999_900 + index,
          status: 'success',
          settlement: 'complete',
          callKind: 'completion',
          attribution: {
            companionId: 'companion-a',
            sessionId: 'garden-ranked-session',
            channelId: `channel-${suffix}`,
            channelType: 'api',
            callType: 'background',
            purpose: 'garden-full-group-ranking',
          },
          provider: 'litellm',
          model: `model-${suffix}`,
          inputTokens: isExpensiveOmittedGroup ? 1 : 1000,
          totalTokens: isExpensiveOmittedGroup ? 1 : 1000,
          costSource: 'none',
        });
      }));
      const service = new AdminModelUsageDataService(store);

      const atLimitOne = await service.getModelUsageData({ limit: 1, groupBy: ['channelId'] });
      const atLimitTwo = await service.getModelUsageData({ limit: 2, groupBy: ['channelId'] });

      expect(atLimitOne.recentEvents).toHaveLength(1);
      expect(atLimitTwo.recentEvents).toHaveLength(2);
      expect(atLimitOne.groups).toEqual(atLimitTwo.groups);
      expect(atLimitOne.groups).toHaveLength(21);
      expect(atLimitOne.groups.at(-1)).toEqual(expect.objectContaining({
        dimensions: { channelId: 'Other' },
        isOther: true,
        metrics: expect.objectContaining({ calls: 1, totalTokens: 1, totalCostUsd: 0 }),
      }));
      expect(atLimitOne.groups.reduce((sum, group) => sum + group.metrics.calls, 0)).toBe(21);
      expect(atLimitOne.totals.totalCostUsd).toBe(0);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('persists immutable component economics across restart and rejects conflicting dedupe', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const firstPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-first',
      allowExitOnIdle: true,
      max: 1,
    });
    const event: ModelUsageEventInput = {
      logicalCallId: 'logical-call-1',
      attempt: 1,
      recordedAtMs: 1_752_400_000_000,
      startedAtMs: 1_752_399_999_900,
      completedAtMs: 1_752_400_000_000,
      status: 'success',
      settlement: 'complete',
      callKind: 'chat',
      attribution: {
        companionId: 'companion-a',
        sessionId: 'session-1',
        channelId: 'channel-1',
        channelType: 'discord',
        callType: 'chat',
        purpose: 'chat',
        originType: 'chat',
        originStage: 'turn',
        service: 'agent',
        process: 'substrate-agent',
        turnId: 'turn-1',
        requestId: 'request-1',
        toolName: 'respond',
        toolCallId: 'tool-call-1',
        chargeLane: 'interactive',
        chargeSurface: 'externalModelConsult',
        chargeRunId: 'run-1',
        chargeRootRunId: 'root-run-1',
        chargeParentRunId: 'parent-run-1',
        conversationId: 'conversation-1',
        rootInitiationId: 'root-initiation-1',
        workloadType: 'conversation',
        workloadId: 'conversation-1',
      },
      provider: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      requestedProvider: 'litellm',
      requestedModel: 'chat-primary',
      inputTokens: 176,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      totalTokens: 196,
      providerCost: { total: 0.95, currency: 'USD' },
      estimatedCost: {
        input: 0.000352,
        output: 0.000016,
        cacheRead: 0.0000014,
        cacheWrite: 0.0000275,
        total: 0.0003969,
        currency: 'USD',
      },
      effectiveCost: { total: 0.95, currency: 'USD' },
      costSource: 'provider',
      metadata: {
        rawUsage: { prompt_tokens: 194, completion_tokens: 2 },
      },
    };

    try {
      const firstStore = new PostgresModelUsageStore(firstPool, { companionId: 'companion-a' });
      await expect(firstStore.recordUsageEvent({
        ...event,
        logicalCallId: 'invalid-negative-usage',
        inputTokens: -1,
        totalTokens: 19,
      })).rejects.toThrow('inputTokens must be a non-negative integer');
      for (const mismatch of [
        { providerCostUsd: 0.96 },
        { estimatedCostUsd: 0.000397 },
        { effectiveCostUsd: 0.96 },
      ]) {
        await expect(firstStore.recordUsageEvent({
          ...event,
          logicalCallId: `mismatched-${Object.keys(mismatch)[0]}`,
          ...mismatch,
        })).rejects.toThrow('must match the structured total');
      }
      await firstStore.recordUsageEvent(event);
      await firstStore.recordUsageEvent(event);

      await expect(firstStore.recordUsageEvent({
        ...event,
        outputTokens: 3,
        totalTokens: 197,
      })).rejects.toThrow('conflicts with an existing immutable model usage attempt');
    } finally {
      await firstPool.end();
    }

    const secondPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-second',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const restartedStore = new PostgresModelUsageStore(secondPool, { companionId: 'companion-a' });
      const usage = await restartedStore.getUsageData();
      expect(usage.totals.calls).toBe(1);
      expect(usage.totals.totalTokens).toBe(196);
      expect(usage.totals.totalCostUsd).toBe(0.95);
      expect(usage.recentEvents).toHaveLength(1);
      expect(usage.recentEvents[0]).toMatchObject({
        logicalCallId: 'logical-call-1',
        attempt: 1,
        settlement: 'complete',
        attribution: {
          companionId: 'companion-a',
          sessionId: 'session-1',
          channelId: 'channel-1',
          channelType: 'discord',
          callType: 'chat',
          purpose: 'chat',
          originType: 'chat',
          originStage: 'turn',
          service: 'agent',
          process: 'substrate-agent',
          conversationId: 'conversation-1',
          rootInitiationId: 'root-initiation-1',
          workloadType: 'conversation',
          workloadId: 'conversation-1',
        },
        providerCost: { total: 0.95, currency: 'USD' },
        estimatedCost: {
          input: 0.000352,
          output: 0.000016,
          cacheRead: 0.0000014,
          cacheWrite: 0.0000275,
          total: 0.0003969,
          currency: 'USD',
        },
        effectiveCost: { total: 0.95, currency: 'USD' },
        costSource: 'provider',
      });
      expect(usage.recentEvents[0]?.providerCost.input).toBeUndefined();
    } finally {
      await secondPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('isolates companion tenants while exposing explicit fleet grouping and attribution coverage', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-attribution',
      allowExitOnIdle: true,
      max: 2,
    });
    for (const invalidScope of [
      undefined,
      null,
      {},
      { fleetAggregation: false },
      { companionId: 'companion-a', fleetAggregation: true },
      { companionId: 'companion-a', unexpected: true },
    ]) {
      expect(() => new PostgresModelUsageStore(pool, invalidScope as never)).toThrow(
        /PostgresModelUsageStore/,
      );
    }
    const companionA = new PostgresModelUsageStore(pool, { companionId: 'companion-a' });
    const event = (
      logicalCallId: string,
      companionId: string,
      channelId: string,
    ): ModelUsageEventInput => ({
      logicalCallId,
      recordedAtMs: 1_752_500_000_000,
      startedAtMs: 1_752_499_999_900,
      completedAtMs: 1_752_500_000_000,
      status: 'success',
      settlement: 'complete',
      callKind: 'chat',
      attribution: {
        companionId,
        sessionId: `${companionId}-session`,
        channelId,
        channelType: 'api',
        callType: 'tool',
        purpose: 'research',
        originType: 'chat',
        originStage: 'tool-loop',
        service: 'agent',
        process: 'substrate-agent',
        toolName: 'web_search',
        chargeLane: 'shard',
        chargeSurface: 'shardLaunch',
        conversationId: `${companionId}-conversation`,
        rootInitiationId: `${companionId}-root`,
      },
      provider: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      slotKey: 'tool-primary',
      requestedProvider: 'litellm',
      requestedModel: 'tool-primary',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 19,
      estimatedCostUsd: 0.01,
      costSource: 'estimate',
      currency: 'USD',
    });

    try {
      await companionA.recordUsageEvent(event('companion-a-call', 'companion-a', 'shard:shard-7'));
      const companionB = new PostgresModelUsageStore(pool, { companionId: 'companion-b' });
      await companionB.recordUsageEvent(event('companion-b-call', 'companion-b', 'channel-b'));
      const fleet = new PostgresModelUsageStore(pool, { fleetAggregation: true });
      await expect(fleet.recordUsageEvent({
        ...event('missing-companion-call', 'companion-a', 'channel-missing'),
        attribution: { callType: 'chat', purpose: 'chat' },
      })).rejects.toThrow('require an explicit companionId');
      await expect(companionA.recordUsageEvent(
        event('cross-tenant-call', 'companion-b', 'channel-cross'),
      )).rejects.toThrow('does not match the store tenant');
      await expect(companionA.getUsageData({ companionId: 'companion-b' }))
        .rejects.toThrow('outside the Garden tenant');
      await expect(companionA.getUsageData({
        groupBy: ['not-a-dimension'] as never,
      })).rejects.toThrow('unsupported dimension');
      await expect(companionA.getUsageData({
        channelType: 'email' as never,
      })).rejects.toThrow('unsupported value');
      await expect(companionA.getUsageData({ unexpected: 'value' } as never))
        .rejects.toThrow('unsupported field');

      const usageA = await companionA.getUsageData({
        channelType: 'api',
        shardId: 'shard-7',
        groupBy: ['companionId', 'channelType'],
      });
      expect(usageA.totals).toMatchObject({ calls: 1, totalTokens: 19 });
      expect(usageA.groupedBy.companionId).toEqual([
        expect.objectContaining({ key: 'companion-a', calls: 1, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      ]);
      expect(usageA.groupedBy.channelType?.[0]).toMatchObject({ key: 'api', calls: 1 });
      expect(usageA.groups[0]).toMatchObject({
        dimensions: { companionId: 'companion-a', channelType: 'api' },
        metrics: { calls: 1 },
      });
      expect(usageA.attributionCoverage.byDimension.shardId).toEqual({
        knownCalls: 1,
        unknownCalls: 0,
        coveragePercent: 100,
      });
      expect(usageA.attributionCoverage.byDimension.subagentId).toEqual({
        knownCalls: 0,
        unknownCalls: 1,
        coveragePercent: 0,
      });
      expect(usageA.recentEvents[0]?.attribution).toMatchObject({
        companionId: 'companion-a',
        shardId: 'shard-7',
        workloadType: 'shard',
        workloadId: 'shard-7',
      });

      expect((await companionB.getUsageData()).totals.calls).toBe(1);
      const fleetUsage = await fleet.getUsageData({ groupBy: ['companionId'] });
      expect(fleetUsage.totals.calls).toBe(2);
      expect(fleetUsage.groupedBy.companionId).toEqual([
        expect.objectContaining({ key: 'companion-a', calls: 1 }),
        expect.objectContaining({ key: 'companion-b', calls: 1 }),
      ]);
      await expect(fleet.getModelBudgetSpend(1_752_500_000_100))
        .rejects.toThrow('require an explicit companionId');
      expect(await fleet.getModelBudgetSpend(
        1_752_500_000_100,
        { companionId: 'companion-a' },
      )).toMatchObject({
        dailyEstimatedCostUsd: 0.01,
        monthlyEstimatedCostUsd: 0.01,
      });
      await expect(companionA.getModelBudgetSpend(
        1_752_500_000_100,
        { companionId: 'companion-b' },
      )).rejects.toThrow('does not match the store tenant');
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('projects UTC daily and monthly budgets from canonical chat and completion attempts', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const firstPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-budget-projection-first',
      allowExitOnIdle: true,
      max: 1,
    });
    const nowMs = Date.parse('2026-03-06T12:00:00.000Z');
    const event = (
      logicalCallId: string,
      recordedAtMs: number,
      callKind: ModelUsageEventInput['callKind'],
      estimatedCostUsd?: number,
    ): ModelUsageEventInput => ({
      logicalCallId,
      attempt: 1,
      recordedAtMs,
      startedAtMs: recordedAtMs - 10,
      completedAtMs: recordedAtMs,
      status: logicalCallId.includes('unknown') ? 'failure' : 'success',
      settlement: estimatedCostUsd === undefined ? 'unknown' : 'complete',
      callKind,
      attribution: {
        callType: callKind === 'chat' ? 'chat' : 'background',
        purpose: callKind,
      },
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 1,
      totalTokens: 1,
      ...(estimatedCostUsd !== undefined
        ? { estimatedCostUsd, costSource: 'estimate' as const, currency: 'USD' }
        : { costSource: 'none' as const }),
    });

    try {
      const store = new PostgresModelUsageStore(firstPool, { companionId: 'companion-a' });
      await store.recordUsageEvent(event(
        'today-chat', Date.parse('2026-03-06T08:00:00.000Z'), 'chat', 0.1,
      ));
      await store.recordUsageEvent(event(
        'month-completion', Date.parse('2026-03-02T08:00:00.000Z'), 'completion', 0.2,
      ));
      await store.recordUsageEvent(event(
        'previous-month-chat', Date.parse('2026-02-28T23:59:59.000Z'), 'chat', 0.4,
      ));
      await store.recordUsageEvent(event(
        'today-embedding-unknown', Date.parse('2026-03-06T09:00:00.000Z'), 'embedding', undefined,
      ));
      await store.recordUsageEvent(event(
        'today-chat-unknown', Date.parse('2026-03-06T10:00:00.000Z'), 'chat', undefined,
      ));
      await store.recordUsageEvent(event(
        'future-chat', Date.parse('2026-03-06T13:00:00.000Z'), 'chat', 0.9,
      ));
      expect(await store.getModelBudgetSpend(nowMs)).toEqual({
        dayKey: '2026-03-06',
        monthKey: '2026-03',
        dailyEstimatedCostUsd: 0.1,
        monthlyEstimatedCostUsd: 0.3,
        dailyUnknownCostAttempts: 1,
        monthlyUnknownCostAttempts: 1,
      });
    } finally {
      await firstPool.end();
    }

    const restartedPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-budget-projection-restart',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const restartedStore = new PostgresModelUsageStore(restartedPool, { companionId: 'companion-a' });
      expect(await restartedStore.getModelBudgetSpend(nowMs)).toEqual({
        dayKey: '2026-03-06',
        monthKey: '2026-03',
        dailyEstimatedCostUsd: 0.1,
        monthlyEstimatedCostUsd: 0.3,
        dailyUnknownCostAttempts: 1,
        monthlyUnknownCostAttempts: 1,
      });
    } finally {
      await restartedPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('preserves valid partial and unknown economics exactly across store restart', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const firstPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-partial-first',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const firstStore = new PostgresModelUsageStore(firstPool, { companionId: 'companion-a' });
      await firstStore.recordUsageEvent({
        logicalCallId: 'valid-partial-call',
        attempt: 1,
        recordedAtMs: 1_752_400_100_000,
        startedAtMs: 1_752_400_099_900,
        completedAtMs: 1_752_400_100_000,
        status: 'success',
        settlement: 'partial',
        callKind: 'chat',
        attribution: { callType: 'chat', purpose: 'chat' },
        provider: 'openrouter',
        model: 'unknown-price-model',
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costSource: 'none',
        metadata: {
          providerCostEvidenceConflict: { fields: ['responseUsage.cost.total'] },
        },
      });
      await firstStore.recordUsageEvent({
        logicalCallId: 'valid-unknown-call',
        attempt: 1,
        recordedAtMs: 1_752_400_200_000,
        startedAtMs: 1_752_400_199_900,
        completedAtMs: 1_752_400_200_000,
        status: 'failure',
        settlement: 'unknown',
        callKind: 'embedding',
        attribution: { callType: 'background', purpose: 'memory' },
        provider: 'api',
        model: 'unknown-price-embedding',
        inputTokens: 3,
        totalTokens: 3,
        costSource: 'none',
      });
      await firstStore.getUsageData();
    } finally {
      await firstPool.end();
    }

    const restartedPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-partial-restart',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const restartedStore = new PostgresModelUsageStore(restartedPool, { companionId: 'companion-a' });
      const usage = await restartedStore.getUsageData();
      const partial = usage.recentEvents.find(event => event.logicalCallId === 'valid-partial-call');
      const unknown = usage.recentEvents.find(event => event.logicalCallId === 'valid-unknown-call');

      expect(partial).toMatchObject({
        settlement: 'partial',
        providerCost: {},
        estimatedCost: {},
        effectiveCost: {},
        costSource: 'none',
        metadata: {
          providerCostEvidenceConflict: { fields: ['responseUsage.cost.total'] },
        },
      });
      expect(partial?.estimatedCostUsd).toBeUndefined();
      expect(partial?.effectiveCostUsd).toBeUndefined();
      expect(unknown).toMatchObject({
        settlement: 'unknown',
        providerCost: {},
        estimatedCost: {},
        effectiveCost: {},
        costSource: 'none',
      });
      expect(unknown?.estimatedCostUsd).toBeUndefined();
      expect(unknown?.effectiveCostUsd).toBeUndefined();

      const rows = await restartedPool.query<{
        logical_call_id: string;
        settlement: string;
        estimated_cost_usd: number | null;
        effective_cost_usd: number | null;
        accounting_schema_version: number;
      }>(`
        SELECT logical_call_id, settlement, estimated_cost_usd, effective_cost_usd,
               accounting_schema_version
        FROM model_usage_events
        ORDER BY logical_call_id
      `);
      expect(rows.rows).toEqual([
        {
          logical_call_id: 'valid-partial-call',
          settlement: 'partial',
          estimated_cost_usd: null,
          effective_cost_usd: null,
          accounting_schema_version: 2,
        },
        {
          logical_call_id: 'valid-unknown-call',
          settlement: 'unknown',
          estimated_cost_usd: null,
          effective_cost_usd: null,
          accounting_schema_version: 2,
        },
      ]);
    } finally {
      await restartedPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('repairs legacy token totals and quarantines non-USD costs before validating constraints', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const legacyPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-legacy-setup',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await legacyPool.query(`
        CREATE TABLE model_usage_events (
          id TEXT PRIMARY KEY,
          logical_call_id TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          recorded_at_ms BIGINT NOT NULL,
          started_at_ms BIGINT NOT NULL,
          completed_at_ms BIGINT,
          duration_ms BIGINT,
          ttft_ms BIGINT,
          day_key TEXT NOT NULL,
          month_key TEXT NOT NULL,
          status TEXT NOT NULL,
          call_kind TEXT NOT NULL,
          call_type TEXT NOT NULL,
          purpose TEXT NOT NULL,
          origin_type TEXT,
          origin_stage TEXT,
          service TEXT,
          process TEXT,
          turn_id TEXT,
          request_id TEXT,
          channel_id TEXT,
          tool_name TEXT,
          tool_call_id TEXT,
          charge_lane TEXT,
          charge_surface TEXT,
          charge_run_id TEXT,
          charge_root_run_id TEXT,
          charge_parent_run_id TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          slot_key TEXT,
          requested_provider TEXT,
          requested_model TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          provider_cost_usd DOUBLE PRECISION,
          estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          cost_source TEXT NOT NULL DEFAULT 'none',
          currency TEXT,
          stop_reason TEXT,
          error_code TEXT,
          error_message TEXT,
          metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          event_fingerprint TEXT NOT NULL,
          UNIQUE (logical_call_id, attempt)
        )
      `);
      await legacyPool.query(`
        INSERT INTO model_usage_events (
          id, logical_call_id, attempt, recorded_at_ms, started_at_ms,
          completed_at_ms, day_key, month_key, status, call_kind, call_type,
          purpose, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens,
          provider_cost_usd, estimated_cost_usd, cost_source, currency,
          metadata_json, event_fingerprint
        ) VALUES (
          'legacy-unknown-event', 'legacy-unknown-call', 0,
          1752300000000, 1752299999900, 1752300000000,
          '2025-07-12', '2025-07', 'failure', 'completion', 'background',
          'background', 'legacy-provider', 'legacy-unknown-model', 3, 0, 0, 0, 3,
          NULL, 0, 'none', 'USD', '{"legacyUnknown":true}'::jsonb,
          'legacy:legacy-unknown-event'
        )
      `);
      await legacyPool.query(`
        INSERT INTO model_usage_events (
          id, logical_call_id, attempt, recorded_at_ms, started_at_ms,
          completed_at_ms, day_key, month_key, status, call_kind, call_type,
          purpose, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens,
          provider_cost_usd, estimated_cost_usd, cost_source, currency,
          metadata_json, event_fingerprint
        ) VALUES (
          'legacy-accounting-event', 'legacy-accounting-call', 0,
          1752400000000, 1752399999900, 1752400000000,
          '2025-07-13', '2025-07', 'success', 'chat', 'chat',
          'chat', 'legacy-provider', 'legacy-model', 10, 5, 3, 2, 25,
          1.25, 0.5, 'provider', 'EUR', '{"legacyMarker":true}'::jsonb,
          'legacy:legacy-accounting-event'
        )
      `);
      await legacyPool.query(`
        INSERT INTO model_usage_events (
          id, logical_call_id, attempt, recorded_at_ms, started_at_ms,
          completed_at_ms, day_key, month_key, status, call_kind, call_type,
          purpose, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens,
          provider_cost_usd, estimated_cost_usd, cost_source, currency,
          metadata_json, event_fingerprint
        ) VALUES (
          'current-unknown-event', 'current-unknown-call', 0,
          1752500000000, 1752499999900, 1752500000000,
          '2025-07-14', '2025-07', 'success', 'chat', 'chat',
          'chat', 'current-provider', 'current-unknown-model', 0, 0, 0, 0, 0,
          NULL, 0, 'none', 'USD', '{"currentUnknown":true}'::jsonb,
          repeat('a', 64)
        )
      `);
    } finally {
      await legacyPool.end();
    }

    const migratedPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-legacy-migration',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const migratedStore = new PostgresModelUsageStore(migratedPool, { fleetAggregation: true });
      const usage = await migratedStore.getUsageData();
      expect(usage.totals).toMatchObject({
        calls: 3,
        totalTokens: 23,
        providerCostUsd: 0,
        estimatedCostUsd: 0,
        totalCostUsd: 0,
      });
      expect(usage.recentEvents).toHaveLength(3);
      const migratedLegacy = usage.recentEvents.find(
        event => event.logicalCallId === 'legacy-accounting-call',
      );
      const migratedUnknown = usage.recentEvents.find(
        event => event.logicalCallId === 'legacy-unknown-call',
      );
      const currentUnknown = usage.recentEvents.find(
        event => event.logicalCallId === 'current-unknown-call',
      );
      expect(migratedLegacy).toMatchObject({
        logicalCallId: 'legacy-accounting-call',
        totalTokens: 20,
        providerCost: {},
        estimatedCost: {},
        effectiveCost: {},
        costSource: 'none',
        metadata: {
          legacyMarker: true,
          _accountingMigration: {
            nonUsdCostQuarantined: true,
            currency: 'EUR',
            providerCost: { total: 1.25 },
            estimatedCost: { total: 0.5 },
            effectiveCost: { total: 1.25 },
            legacyTotalTokens: 25,
            canonicalTotalTokens: 20,
          },
        },
      });
      expect(migratedLegacy?.currency).toBeUndefined();
      expect(migratedLegacy?.providerCostUsd).toBeUndefined();
      expect(migratedLegacy?.estimatedCostUsd).toBeUndefined();
      expect(migratedLegacy?.effectiveCostUsd).toBeUndefined();
      expect(migratedUnknown).toMatchObject({
        settlement: 'unknown',
        providerCost: {},
        estimatedCost: {},
        effectiveCost: {},
        costSource: 'none',
        metadata: { legacyUnknown: true },
      });
      expect(migratedUnknown?.estimatedCostUsd).toBeUndefined();
      expect(migratedUnknown?.effectiveCostUsd).toBeUndefined();
      expect(currentUnknown).toMatchObject({
        settlement: 'unknown',
        providerCost: {},
        estimatedCost: {},
        effectiveCost: {},
        costSource: 'none',
        metadata: { currentUnknown: true },
      });
      expect(currentUnknown?.estimatedCostUsd).toBeUndefined();
      expect(currentUnknown?.effectiveCostUsd).toBeUndefined();

      const version = await migratedPool.query<{
        accounting_schema_version: number;
        attribution_schema_version: number;
        companion_id: string;
        channel_type: string;
        conversation_id: string;
      }>(`
        SELECT accounting_schema_version, attribution_schema_version,
               companion_id, channel_type, conversation_id
        FROM model_usage_events
        WHERE id = 'legacy-accounting-event'
      `);
      expect(version.rows).toEqual([{
        accounting_schema_version: 2,
        attribution_schema_version: 1,
        companion_id: 'unknown',
        channel_type: 'unknown',
        conversation_id: 'unknown',
      }]);

      const constraints = await migratedPool.query<{
        conname: string;
        convalidated: boolean;
      }>(`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conrelid = 'model_usage_events'::regclass
          AND conname IN (
            'model_usage_events_accounting_schema_version_check',
            'model_usage_events_attribution_schema_version_check',
            'model_usage_events_token_accounting_check',
            'model_usage_events_usd_currency_check'
          )
        ORDER BY conname
      `);
      expect(constraints.rows).toEqual([
        { conname: 'model_usage_events_accounting_schema_version_check', convalidated: true },
        { conname: 'model_usage_events_attribution_schema_version_check', convalidated: true },
        { conname: 'model_usage_events_token_accounting_check', convalidated: true },
        { conname: 'model_usage_events_usd_currency_check', convalidated: true },
      ]);

      const indexes = await migratedPool.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'model_usage_events'
          AND indexname IN (
            'idx_model_usage_events_companion_time',
            'idx_model_usage_events_session_time',
            'idx_model_usage_events_channel_time',
            'idx_model_usage_events_charge_attribution_time',
            'idx_model_usage_events_charge_event',
            'idx_model_usage_events_shard_time',
            'idx_model_usage_events_subagent_time',
            'idx_model_usage_events_conversation_time',
            'idx_model_usage_events_root_initiation_time',
            'idx_model_usage_events_workload_time',
            'idx_model_usage_events_status_cost_time'
          )
        ORDER BY indexname
      `);
      expect(indexes.rows.map(row => row.indexname)).toEqual([
        'idx_model_usage_events_channel_time',
        'idx_model_usage_events_charge_attribution_time',
        'idx_model_usage_events_charge_event',
        'idx_model_usage_events_companion_time',
        'idx_model_usage_events_conversation_time',
        'idx_model_usage_events_root_initiation_time',
        'idx_model_usage_events_session_time',
        'idx_model_usage_events_shard_time',
        'idx_model_usage_events_status_cost_time',
        'idx_model_usage_events_subagent_time',
        'idx_model_usage_events_workload_time',
      ]);

      await expect(migratedPool.query(`
        UPDATE model_usage_events
        SET total_tokens = total_tokens + 1
        WHERE id = 'legacy-accounting-event'
      `)).rejects.toMatchObject({
        constraint: 'model_usage_events_token_accounting_check',
      });
      await expect(migratedPool.query(`
        UPDATE model_usage_events
        SET currency = 'EUR'
        WHERE id = 'legacy-accounting-event'
      `)).rejects.toMatchObject({
        constraint: 'model_usage_events_usd_currency_check',
      });
    } finally {
      await migratedPool.end();
    }

    const restartedPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage-legacy-restart',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const restartedStore = new PostgresModelUsageStore(restartedPool, { fleetAggregation: true });
      const usage = await restartedStore.getUsageData();
      expect(usage.totals.totalTokens).toBe(23);
      expect(usage.totals.totalCostUsd).toBe(0);
      const migratedLegacy = usage.recentEvents.find(
        event => event.logicalCallId === 'legacy-accounting-call',
      );
      expect(migratedLegacy?.metadata).toMatchObject({
        _accountingMigration: {
          nonUsdCostQuarantined: true,
          legacyTotalTokens: 25,
          canonicalTotalTokens: 20,
        },
      });
    } finally {
      await restartedPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
