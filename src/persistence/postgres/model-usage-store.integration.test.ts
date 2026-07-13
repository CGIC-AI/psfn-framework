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
});
