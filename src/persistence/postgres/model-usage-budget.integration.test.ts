import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { ModelBudgetController } from '../../primitives/llm/model-budget.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresModelUsageStore } from './model-usage-store.js';

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

const MODEL_ENTRY = {
  id: 'background',
  rank: 10,
  identity: {
    provider: 'test-provider',
    model: 'priced-historical-model',
    source: { type: 'configured' as const },
  },
  purposes: [{ purpose: 'background' as const, primary: true }],
  capabilities: { maxOutputTokens: 1_024, contextWindow: 128_000 },
  tuning: { maxOutputTokens: 1_024 },
  cost: {
    inputPer1MUsd: 3,
    outputPer1MUsd: 15,
    cacheReadPer1MUsd: 3,
    cacheWritePer1MUsd: 3,
    currency: 'USD',
  },
};

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function makeBudgetConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'priced-historical-model',
    primaryProvider: 'test-provider',
    extractionModel: 'priced-historical-model',
    extractionProvider: 'test-provider',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    extractionInterval: 5,
    primaryMaxTokens: 1_024,
    extractionMaxTokens: 1_024,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    companionId: 'companion-a',
    modelRoster: {
      background: {
        model: 'priced-historical-model',
        provider: 'test-provider',
        maxTokens: 1_024,
        contextWindow: 128_000,
      },
    },
    modelRegistry: {
      schemaVersion: 1,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 20,
        monthlyUsdLimit: 20,
        currency: 'USD',
      },
      models: [MODEL_ENTRY],
    },
  };
}

describe('Postgres model-usage budget projection', () => {
  it('prices only a registry-matched historical success before budget preflight', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-historical-budget-regression',
      allowExitOnIdle: true,
      max: 1,
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'model-usage-historical-budget-'));
    const config = makeBudgetConfig(dataDir);
    const modelEntry = MODEL_ENTRY;

    try {
      const store = new PostgresModelUsageStore(pool, { companionId: 'companion-a' });
      const nowMs = Date.now();
      await store.recordUsageEvent({
        logicalCallId: 'historical-unpriced-success',
        attempt: 1,
        recordedAtMs: nowMs - 1_000,
        startedAtMs: nowMs - 1_010,
        completedAtMs: nowMs - 1_000,
        status: 'success',
        settlement: 'unknown',
        callKind: 'completion',
        attribution: { callType: 'background', purpose: 'background' },
        provider: modelEntry.identity.provider,
        model: modelEntry.identity.model,
        slotKey: modelEntry.id,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costSource: 'none',
      });
      await store.recordUsageEvent({
        logicalCallId: 'local-embedding-free',
        attempt: 1,
        recordedAtMs: nowMs - 500,
        startedAtMs: nowMs - 510,
        completedAtMs: nowMs - 500,
        status: 'success',
        settlement: 'unknown',
        callKind: 'embedding',
        attribution: { callType: 'background', purpose: 'memory.embedding' },
        provider: 'transformers',
        model: 'Xenova/all-MiniLM-L6-v2',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costSource: 'none',
      });

      await expect(store.getModelBudgetSpend(nowMs, undefined, [{
        slotKey: modelEntry.id,
        provider: modelEntry.identity.provider,
        model: modelEntry.identity.model,
        inputPer1MUsd: -3,
        outputPer1MUsd: modelEntry.cost.outputPer1MUsd,
        cacheReadPer1MUsd: modelEntry.cost.cacheReadPer1MUsd,
        cacheWritePer1MUsd: modelEntry.cost.cacheWritePer1MUsd,
      }])).rejects.toThrow('pricing[0].inputPer1MUsd must be a finite number >= 0');
      await expect(store.getModelBudgetSpend(nowMs, undefined, [{
        slotKey: modelEntry.id,
        provider: modelEntry.identity.provider,
        model: modelEntry.identity.model,
        inputPer1MUsd: modelEntry.cost.inputPer1MUsd,
        outputPer1MUsd: Number.POSITIVE_INFINITY,
        cacheReadPer1MUsd: modelEntry.cost.cacheReadPer1MUsd,
        cacheWritePer1MUsd: modelEntry.cost.cacheWritePer1MUsd,
      }])).rejects.toThrow('pricing[0].outputPer1MUsd must be a finite number >= 0');
      await expect(store.getModelBudgetSpend(nowMs, undefined, [{
        slotKey: ' ',
        provider: modelEntry.identity.provider,
        model: modelEntry.identity.model,
        inputPer1MUsd: modelEntry.cost.inputPer1MUsd,
        outputPer1MUsd: modelEntry.cost.outputPer1MUsd,
        cacheReadPer1MUsd: modelEntry.cost.cacheReadPer1MUsd,
        cacheWritePer1MUsd: modelEntry.cost.cacheWritePer1MUsd,
      }])).rejects.toThrow('pricing[0].slotKey must be non-empty');
      const matchingPricing = {
        slotKey: modelEntry.id,
        provider: modelEntry.identity.provider,
        model: modelEntry.identity.model,
        inputPer1MUsd: modelEntry.cost.inputPer1MUsd,
        outputPer1MUsd: modelEntry.cost.outputPer1MUsd,
        cacheReadPer1MUsd: modelEntry.cost.cacheReadPer1MUsd,
        cacheWritePer1MUsd: modelEntry.cost.cacheWritePer1MUsd,
      };
      await expect(store.getModelBudgetSpend(
        nowMs,
        undefined,
        [matchingPricing, matchingPricing],
      )).rejects.toThrow(
        'pricing[1] duplicates the exact slot/provider/model identity from pricing[0]',
      );

      const preflight = await new ModelBudgetController(config, store).evaluatePreflight({
        candidate: {
          provider: modelEntry.identity.provider,
          model: modelEntry.identity.model,
          maxTokens: modelEntry.capabilities.maxOutputTokens,
          slotKey: modelEntry.id,
        },
        purpose: 'background',
        service: 'background',
        process: 'regression.next-call',
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        nowMs,
      });
      expect(preflight).toMatchObject({
        allowed: true,
        snapshot: {
          dailySpentUsd: 0.0006,
          monthlySpentUsd: 0.0006,
          dailyUnknownCostAttempts: 0,
          monthlyUnknownCostAttempts: 0,
        },
      });
      expect(await store.getModelBudgetSpend(nowMs)).toMatchObject({
        dailyUnknownCostAttempts: 1,
        monthlyUnknownCostAttempts: 1,
      });
      expect(await store.getModelBudgetSpend(
        nowMs,
        { accountingStartMs: nowMs - 750 },
        [],
      )).toMatchObject({
        dailyEstimatedCostUsd: 0,
        monthlyEstimatedCostUsd: 0,
        dailyUnknownCostAttempts: 0,
        monthlyUnknownCostAttempts: 0,
      });
      await expect(store.getModelBudgetSpend(
        nowMs,
        { accountingStartMs: nowMs + 1 },
        [],
      )).rejects.toThrow('accountingStartMs cannot be later than nowMs');
      expect(await store.getModelBudgetSpend(nowMs, undefined, [{
        slotKey: modelEntry.id,
        provider: modelEntry.identity.provider,
        model: 'different-model',
        inputPer1MUsd: modelEntry.cost.inputPer1MUsd,
        outputPer1MUsd: modelEntry.cost.outputPer1MUsd,
        cacheReadPer1MUsd: modelEntry.cost.cacheReadPer1MUsd,
        cacheWritePer1MUsd: modelEntry.cost.cacheWritePer1MUsd,
      }])).toMatchObject({
        dailyUnknownCostAttempts: 1,
        monthlyUnknownCostAttempts: 1,
      });
      const accountingStartMs = nowMs - 750;
      await store.recordUsageEvent({
        logicalCallId: 'cutover-inclusive-priced-success',
        attempt: 1,
        recordedAtMs: accountingStartMs,
        startedAtMs: accountingStartMs - 10,
        completedAtMs: accountingStartMs,
        status: 'success',
        settlement: 'unknown',
        callKind: 'completion',
        attribution: { callType: 'background', purpose: 'background' },
        provider: modelEntry.identity.provider,
        model: modelEntry.identity.model,
        slotKey: modelEntry.id,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costSource: 'none',
      });
      await store.recordUsageEvent({
        logicalCallId: 'post-cutover-unknown-success',
        attempt: 1,
        recordedAtMs: nowMs - 250,
        startedAtMs: nowMs - 260,
        completedAtMs: nowMs - 250,
        status: 'success',
        settlement: 'unknown',
        callKind: 'chat',
        attribution: { callType: 'chat', purpose: 'chat' },
        provider: 'retired-provider',
        model: 'unpriced-model',
        slotKey: 'retired-slot',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costSource: 'none',
      });
      expect(await store.getModelBudgetSpend(
        nowMs,
        { accountingStartMs },
        [matchingPricing],
      )).toMatchObject({
        dailyEstimatedCostUsd: 0.0006,
        monthlyEstimatedCostUsd: 0.0006,
        dailyUnknownCostAttempts: 1,
        monthlyUnknownCostAttempts: 1,
      });
      const historicalEvent = (await store.getUsageData({ limit: 4 })).recentEvents
        .find(event => event.logicalCallId === 'historical-unpriced-success');
      expect(historicalEvent).toMatchObject({
        status: 'success',
        settlement: 'unknown',
        costSource: 'none',
      });
    } finally {
      await pool.end();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);
});
