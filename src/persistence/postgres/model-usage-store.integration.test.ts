import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresModelUsageStore } from './model-usage-store.js';
import type { ModelUsageEventInput } from '../../shared/telemetry/model-usage.js';

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

describe('PostgresModelUsageStore reconciliation', () => {
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
        groupBy: ['companionId', 'channelType', 'shardId', 'subagentId'],
      });
      expect(usageA.totals).toMatchObject({ calls: 1, totalTokens: 19 });
      expect(usageA.groupedBy.companionId).toEqual([
        expect.objectContaining({ key: 'companion-a', calls: 1, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      ]);
      expect(usageA.groupedBy.channelType?.[0]).toMatchObject({ key: 'api', calls: 1 });
      expect(usageA.groupedBy.shardId?.[0]).toMatchObject({ key: 'shard-7', calls: 1 });
      expect(usageA.groupedBy.subagentId?.[0]).toMatchObject({ key: 'unknown', calls: 1 });
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
