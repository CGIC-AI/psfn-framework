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
      callType: 'chat',
      purpose: 'chat',
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
      const firstStore = new PostgresModelUsageStore(firstPool);
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
      const restartedStore = new PostgresModelUsageStore(secondPool);
      const usage = await restartedStore.getUsageData();
      expect(usage.totals.calls).toBe(1);
      expect(usage.totals.totalTokens).toBe(196);
      expect(usage.totals.totalCostUsd).toBe(0.95);
      expect(usage.recentEvents).toHaveLength(1);
      expect(usage.recentEvents[0]).toMatchObject({
        logicalCallId: 'logical-call-1',
        attempt: 1,
        settlement: 'complete',
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
          metadata_json
        ) VALUES (
          'legacy-accounting-event', 'legacy-accounting-call', 0,
          1752400000000, 1752399999900, 1752400000000,
          '2025-07-13', '2025-07', 'success', 'chat', 'chat',
          'chat', 'legacy-provider', 'legacy-model', 10, 5, 3, 2, 25,
          1.25, 0.5, 'provider', 'EUR', '{"legacyMarker":true}'::jsonb
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
      const migratedStore = new PostgresModelUsageStore(migratedPool);
      const usage = await migratedStore.getUsageData();
      expect(usage.totals).toMatchObject({
        calls: 1,
        totalTokens: 20,
        providerCostUsd: 0,
        estimatedCostUsd: 0,
        totalCostUsd: 0,
      });
      expect(usage.recentEvents).toHaveLength(1);
      expect(usage.recentEvents[0]).toMatchObject({
        logicalCallId: 'legacy-accounting-call',
        totalTokens: 20,
        providerCost: {},
        estimatedCost: { total: 0 },
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
      expect(usage.recentEvents[0]?.currency).toBeUndefined();
      expect(usage.recentEvents[0]?.providerCostUsd).toBeUndefined();
      expect(usage.recentEvents[0]?.effectiveCostUsd).toBeUndefined();

      const constraints = await migratedPool.query<{
        conname: string;
        convalidated: boolean;
      }>(`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conrelid = 'model_usage_events'::regclass
          AND conname IN (
            'model_usage_events_token_accounting_check',
            'model_usage_events_usd_currency_check'
          )
        ORDER BY conname
      `);
      expect(constraints.rows).toEqual([
        { conname: 'model_usage_events_token_accounting_check', convalidated: true },
        { conname: 'model_usage_events_usd_currency_check', convalidated: true },
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
      const restartedStore = new PostgresModelUsageStore(restartedPool);
      const usage = await restartedStore.getUsageData();
      expect(usage.totals.totalTokens).toBe(20);
      expect(usage.totals.totalCostUsd).toBe(0);
      expect(usage.recentEvents[0]?.metadata).toMatchObject({
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
