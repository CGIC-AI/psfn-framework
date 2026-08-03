import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';

import { EventBus } from '../../shared/event-bus.js';
import { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import type { ModelUsageEventInput, ModelUsageTotals } from '../../shared/telemetry/model-usage.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SessionStore } from '../sessions/store.js';
import { createPostgresPool } from '../postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { loadModelUsageCertificationFixture } from '../../test-support/model-usage-certification-fixtures.js';
import { AdminDashboardDataService } from '../../operator/garden/services/dashboard-service.js';
import { AdminModelUsageDataService } from '../../operator/garden/services/model-usage-service.js';
import { AdminChargeCostReconciliationDataService } from '../../operator/garden/services/charge-cost-reconciliation-service.js';
import { PostgresModelUsageStore } from './model-usage-store.js';

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

function certificationLog(phase: string, data: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({
    suite: 'model-usage-certification',
    phase,
    ...data,
  })}\n`);
}

function sumTotals(totals: readonly ModelUsageTotals[]): Pick<
  ModelUsageTotals,
  'calls' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'totalTokens' | 'totalCostUsd'
> {
  return totals.reduce((sum, value) => ({
    calls: sum.calls + value.calls,
    inputTokens: sum.inputTokens + value.inputTokens,
    cacheReadTokens: sum.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + value.cacheWriteTokens,
    outputTokens: sum.outputTokens + value.outputTokens,
    totalTokens: sum.totalTokens + value.totalTokens,
    totalCostUsd: sum.totalCostUsd + value.totalCostUsd,
  }), {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  });
}

function makeDashboard(
  service: AdminModelUsageDataService,
  nowMs: number,
): AdminDashboardDataService {
  return new AdminDashboardDataService({
    getMemoryStatsForRequest: async () => ({ total: 0, avgSalience: 0, byType: {} }),
    sessionStore: { listChannels: () => [] } as unknown as SessionStore,
    scheduler: { taskCount: 0 } as Scheduler,
    shardManager: {
      getActiveCount: () => 0,
      getActiveShards: () => [],
    } as unknown as ShardExecutionPort,
    eventBus: new EventBus(),
    modelUsageService: service,
    now: () => nowMs,
  });
}

async function rawTotals(pool: Pool): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, string | number>>(`
    SELECT
      COUNT(*) AS calls,
      COUNT(*) FILTER (WHERE status = 'success') AS successful_calls,
      COUNT(*) FILTER (WHERE status = 'failure') AS failed_calls,
      SUM(input_tokens) AS input_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_tokens) AS total_tokens,
      COALESCE(SUM(provider_cost_usd), 0) AS provider_cost_usd,
      COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
      COALESCE(SUM(effective_cost_usd), 0) AS total_cost_usd,
      COUNT(*) FILTER (WHERE cost_source = 'provider') AS provider_calls,
      COUNT(*) FILTER (WHERE cost_source = 'estimate') AS estimate_calls,
      COUNT(*) FILTER (WHERE cost_source = 'none') AS none_calls
    FROM model_usage_events
    WHERE companion_id = 'companion-a'
  `);
  return Object.fromEntries(
    Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
  );
}

describe('golden accounting certification against real PostgreSQL', () => {
  it('reconciles raw events through every operator view across processes, restart, and tenant boundaries', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const fixture = loadModelUsageCertificationFixture();
    const { databaseUrl } = await harness.createDatabase();
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'accounting-certification-writer',
      allowExitOnIdle: true,
      max: 2,
    });
    const operatorPool = createPostgresPool(databaseUrl, {
      applicationName: 'accounting-certification-operator',
      allowExitOnIdle: true,
      max: 1,
    });
    const companionAWriter = new PostgresModelUsageStore(writerPool, { companionId: 'companion-a' });
    const companionBWriter = new PostgresModelUsageStore(writerPool, { companionId: 'companion-b' });
    const companionAOperator = new PostgresModelUsageStore(operatorPool, { companionId: 'companion-a' });
    const operatorService = new AdminModelUsageDataService(companionAOperator);
    const dataDir = mkdtempSync(join(tmpdir(), 'accounting-certification-'));
    const ledgerPath = join(dataDir, 'charge-ledger.jsonl');
    const firstLedger = new RunChargeLedger(ledgerPath, null, { now: () => fixture.nowMs });
    let restartedPool: Pool | null = null;
    let restartedLedger: RunChargeLedger | null = null;

    try {
      const companionAEvents = fixture.events.filter(event => event.attribution.companionId === 'companion-a');
      const companionBEvents = fixture.events.filter(event => event.attribution.companionId === 'companion-b');
      const finalCrossProcessEvent = companionAEvents.find(event => event.logicalCallId === 'fixture-shard');
      if (!finalCrossProcessEvent) throw new Error('Certification fixture is missing its cross-process shard event');

      certificationLog('setup', {
        companionAEvents: companionAEvents.length,
        companionBEvents: companionBEvents.length,
        chargeEvents: fixture.charges.length,
      });
      for (const event of companionAEvents.filter(candidate => candidate !== finalCrossProcessEvent)) {
        await companionAWriter.recordUsageEvent(event);
      }
      for (const event of companionBEvents) await companionBWriter.recordUsageEvent(event);
      for (const charge of fixture.charges) firstLedger.recordChargeEvent(charge);

      const initialDashboard = await makeDashboard(operatorService, fixture.nowMs)
        .getDashboardData({ costWindow: 'today' });
      expect(initialDashboard.stats.modelUsage.usage?.calls).toBe(fixture.expected.companionA.calls - 1);

      await companionAWriter.recordUsageEvent(finalCrossProcessEvent);
      const liveRefresh = await makeDashboard(operatorService, fixture.nowMs)
        .getDashboardData({ costWindow: 'today' });
      expect(liveRefresh.stats.modelUsage).toMatchObject({
        usage: {
          calls: fixture.expected.companionA.calls,
          totalTokens: fixture.expected.companionA.totalTokens,
          effectiveCostUsd: fixture.expected.companionA.totalCostUsd,
        },
        freshness: {
          state: 'fresh',
          source: 'postgres_model_usage',
        },
      });

      const canonical = await operatorService.getModelUsageData(fixture.query);
      const { costSourceCalls: _costSourceCalls, ...expectedCompanionATotals } = fixture.expected.companionA;
      expect(canonical.totals).toMatchObject(expectedCompanionATotals);
      expect(canonical.attributionCoverage.totalCalls).toBe(fixture.expected.companionA.calls);
      expect(canonical.attributionCoverage.byDimension.channelId).toEqual({
        knownCalls: fixture.expected.companionA.calls,
        unknownCalls: 0,
        coveragePercent: 100,
      });

      const raw = await rawTotals(writerPool);
      expect(raw).toMatchObject({
        calls: fixture.expected.companionA.calls,
        successful_calls: fixture.expected.companionA.successfulCalls,
        failed_calls: fixture.expected.companionA.failedCalls,
        input_tokens: fixture.expected.companionA.inputTokens,
        cache_read_tokens: fixture.expected.companionA.cacheReadTokens,
        cache_write_tokens: fixture.expected.companionA.cacheWriteTokens,
        output_tokens: fixture.expected.companionA.outputTokens,
        total_tokens: fixture.expected.companionA.totalTokens,
        provider_calls: fixture.expected.companionA.costSourceCalls.provider,
        estimate_calls: fixture.expected.companionA.costSourceCalls.estimate,
        none_calls: fixture.expected.companionA.costSourceCalls.none,
      });
      expect(raw.provider_cost_usd).toBeCloseTo(fixture.expected.companionA.providerCostUsd, 12);
      expect(raw.estimated_cost_usd).toBeCloseTo(fixture.expected.companionA.estimatedCostUsd, 12);
      expect(raw.total_cost_usd).toBeCloseTo(fixture.expected.companionA.totalCostUsd, 12);

      expect(sumTotals(canonical.timeSeries)).toMatchObject({
        calls: fixture.expected.companionA.calls,
        inputTokens: fixture.expected.companionA.inputTokens,
        cacheReadTokens: fixture.expected.companionA.cacheReadTokens,
        cacheWriteTokens: fixture.expected.companionA.cacheWriteTokens,
        outputTokens: fixture.expected.companionA.outputTokens,
        totalTokens: fixture.expected.companionA.totalTokens,
        totalCostUsd: fixture.expected.companionA.totalCostUsd,
      });
      expect(sumTotals(canonical.groups.map(group => group.metrics))).toMatchObject({
        calls: fixture.expected.companionA.calls,
        totalTokens: fixture.expected.companionA.totalTokens,
        totalCostUsd: fixture.expected.companionA.totalCostUsd,
      });

      const jsonExport = await operatorService.exportModelUsageData(fixture.query, 'json');
      const exported = JSON.parse(jsonExport.body) as { rows: ModelUsageEventInput[] };
      expect(jsonExport.rowCount).toBe(fixture.expected.companionA.calls);
      expect(exported.rows).toHaveLength(fixture.expected.companionA.calls);
      expect(jsonExport.body).not.toMatch(/systemPrompt|messages|promptBody|messageBody/u);
      const csvExport = await operatorService.exportModelUsageData(fixture.query, 'csv');
      expect(csvExport.rowCount).toBe(fixture.expected.companionA.calls);
      expect(csvExport.body.split('\r\n').filter(Boolean)).toHaveLength(fixture.expected.companionA.calls + 1);

      const channelMain = await operatorService.getModelUsageData({
        ...fixture.query,
        channelId: 'channel-main',
      });
      expect(channelMain.totals.calls).toBe(8);
      expect(channelMain.recentEvents.every(event => event.attribution.channelId === 'channel-main')).toBe(true);
      await expect(operatorService.getModelUsageData({
        ...fixture.query,
        companionId: 'companion-b',
      })).rejects.toThrow('outside the Garden tenant');

      const companionBData = await companionBWriter.getUsageData(fixture.query);
      expect(companionBData.totals).toMatchObject(fixture.expected.companionB);
      expect(companionBData.recentEvents.every(event => event.attribution.companionId === 'companion-b')).toBe(true);

      firstLedger.close();
      restartedLedger = new RunChargeLedger(ledgerPath, null, { now: () => fixture.nowMs });
      const reconciliation = await new AdminChargeCostReconciliationDataService(
        restartedLedger,
        companionAOperator,
        'companion-a',
      ).getChargeCostReconciliation({
        sinceMs: fixture.query.sinceMs,
        untilMs: fixture.query.untilMs,
      });
      certificationLog('charge-groups', {
        groups: reconciliation.groups.map(group => ({
          disposition: group.disposition,
          chargeEventIds: group.chargeEventIds,
          usageEventIds: group.usageEventIds,
          chargeUnits: group.metrics.chargeUnits,
          calls: group.metrics.calls,
          effectiveCostUsd: group.metrics.effectiveCostUsd,
        })),
      });
      expect(reconciliation.sourceTotals).toMatchObject({
        chargeUnits: fixture.expected.charge.chargeUnits,
        chargeEvents: fixture.expected.charge.chargeEvents,
        calls: fixture.expected.charge.calls,
        effectiveCostUsd: fixture.expected.charge.effectiveCostUsd,
      });
      expect(reconciliation.buckets.attributable).toMatchObject({
        chargeUnits: fixture.expected.charge.attributableChargeUnits,
        calls: fixture.expected.charge.attributableCalls,
        effectiveCostUsd: fixture.expected.charge.attributableEffectiveCostUsd,
      });
      expect(reconciliation.buckets.ambiguous).toMatchObject({
        chargeUnits: fixture.expected.charge.ambiguousChargeUnits,
        calls: fixture.expected.charge.ambiguousCalls,
        effectiveCostUsd: fixture.expected.charge.ambiguousEffectiveCostUsd,
      });
      expect(reconciliation.buckets.usageWithoutCharge).toMatchObject({
        calls: fixture.expected.charge.usageWithoutChargeCalls,
        effectiveCostUsd: fixture.expected.charge.usageWithoutChargeEffectiveCostUsd,
      });
      expect(reconciliation.ledgerReconciliation).toMatchObject({
        charge: {
          sourceUnits: fixture.expected.charge.chargeUnits,
          classifiedUnits: fixture.expected.charge.chargeUnits,
          sourceEvents: fixture.expected.charge.chargeEvents,
          classifiedEvents: fixture.expected.charge.chargeEvents,
          reconciled: true,
        },
        usage: {
          sourceCalls: fixture.expected.charge.calls,
          classifiedCalls: fixture.expected.charge.calls,
          sourceEffectiveCostUsd: fixture.expected.charge.effectiveCostUsd,
          classifiedEffectiveCostUsd: fixture.expected.charge.effectiveCostUsd,
          sourceTotalTokens: fixture.expected.companionA.totalTokens,
          classifiedTotalTokens: fixture.expected.companionA.totalTokens,
          reconciled: true,
        },
      });

      await operatorPool.end();
      restartedPool = createPostgresPool(databaseUrl, {
        applicationName: 'accounting-certification-restarted-operator',
        allowExitOnIdle: true,
        max: 1,
      });
      const restartedStore = new PostgresModelUsageStore(restartedPool, { companionId: 'companion-a' });
      const restartedDashboard = await makeDashboard(
        new AdminModelUsageDataService(restartedStore),
        fixture.nowMs,
      ).getDashboardData({ costWindow: 'today' });
      expect(restartedDashboard.stats.modelUsage).toMatchObject({
        usage: {
          calls: fixture.expected.companionA.calls,
          totalTokens: fixture.expected.companionA.totalTokens,
          effectiveCostUsd: fixture.expected.companionA.totalCostUsd,
        },
        freshness: { state: 'fresh', source: 'postgres_model_usage' },
      });
      expect(restartedDashboard.stats.transientSessionTelemetry.turnsSinceOperatorStart).toBe(0);
      certificationLog('assert', {
        rawCalls: raw.calls,
        canonicalCalls: canonical.totals.calls,
        exportRows: jsonExport.rowCount,
        chargeConserved: reconciliation.ledgerReconciliation.charge.reconciled,
        usageConserved: reconciliation.ledgerReconciliation.usage.reconciled,
        restartCalls: restartedDashboard.stats.modelUsage.usage?.calls,
      });
    } finally {
      firstLedger.close();
      restartedLedger?.close();
      await Promise.all([
        writerPool.end(),
        ...(operatorPool.ended ? [] : [operatorPool.end()]),
        ...(restartedPool ? [restartedPool.end()] : []),
      ]);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);
});
