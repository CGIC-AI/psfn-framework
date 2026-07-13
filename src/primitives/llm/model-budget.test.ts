import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModelUsageBudgetQueryPort } from '../../shared/telemetry/model-usage.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  findRegistryEntryByModelId,
  findRegistryEntryByProviderModel,
  ModelBudgetController,
  resolveModelUsageCostRatesForIdentity,
} from './model-budget.js';

function makeConfig(dataDir: string, overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  const config: SubstrateConfig = {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 4096,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: join(dataDir, 'test.db'),
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 4096, contextWindow: 128_000 },
      background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 2048, contextWindow: 128_000 },
    },
    modelRegistry: {
      schemaVersion: 1,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 1,
        monthlyUsdLimit: 10,
        currency: 'USD',
      },
      models: [
        {
          id: 'chat',
          rank: 10,
          identity: {
            provider: 'openrouter',
            model: 'z-ai/glm-5',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
          cost: { inputPer1MUsd: 1, outputPer1MUsd: 1, currency: 'USD' },
        },
        {
          id: 'background',
          rank: 20,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
          cost: { inputPer1MUsd: 0.5, outputPer1MUsd: 0.5, currency: 'USD' },
        },
      ],
    },
    ...overrides,
  };

  return config;
}

describe('ModelBudgetController', () => {
  const nowMs = Date.parse('2026-03-06T10:00:00.000Z');
  const zeroSpend = {
    dayKey: '2026-03-06',
    monthKey: '2026-03',
    dailyEstimatedCostUsd: 0,
    monthlyEstimatedCostUsd: 0,
    dailyUnknownCostAttempts: 0,
    monthlyUnknownCostAttempts: 0,
  };
  const makeQuery = (
    snapshot: typeof zeroSpend = zeroSpend,
  ): ModelUsageBudgetQueryPort & { getModelBudgetSpend: ReturnType<typeof vi.fn> } => ({
    getModelBudgetSpend: vi.fn(async () => snapshot),
  });
  const preflightInput = {
    candidate: { provider: 'openrouter', model: 'z-ai/glm-5', maxTokens: 1000, slotKey: 'chat' },
    purpose: 'chat' as const,
    service: 'chat',
    process: 'agent.turn.prompt',
    estimatedInputTokens: 1000,
    estimatedOutputTokens: 1000,
    nowMs,
  };

  it('blocks projected spend using the canonical PostgreSQL budget projection', async () => {
    const dataDir = '/tmp/psfn-model-budget-canonical';
    const baseRegistry = makeConfig(dataDir).modelRegistry!;
    const config = makeConfig(dataDir, {
      modelRegistry: {
        ...baseRegistry,
        budgetPolicy: {
          enabled: true,
          dailyUsdLimit: 0.001,
          monthlyUsdLimit: 10,
          currency: 'USD',
        },
      },
    });
    const query = makeQuery({
      ...zeroSpend,
      dailyEstimatedCostUsd: 0.001,
      monthlyEstimatedCostUsd: 0.1,
    });
    const controller = new ModelBudgetController(config, query);
    const preflight = await controller.evaluatePreflight(preflightInput);

    expect(query.getModelBudgetSpend).toHaveBeenCalledWith(nowMs);
    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('daily_budget_exceeded');
    expect(preflight.blockedEvent?.budget.dailyLimitUsd).toBe(0.001);
    expect(preflight.blockedEvent?.budget.dailySpentUsd).toBeCloseTo(0.001, 8);
  });

  it('fails closed when a canonical historical attempt has unknown estimated cost', async () => {
    const query = makeQuery({
      ...zeroSpend,
      dailyUnknownCostAttempts: 1,
      monthlyUnknownCostAttempts: 1,
    });
    const controller = new ModelBudgetController(makeConfig('/tmp/psfn-model-budget-unknown'), query);
    const preflight = await controller.evaluatePreflight(preflightInput);

    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('unknown_historical_cost');
    expect(preflight.blockedEvent?.budget.dailyUnknownCostAttempts).toBe(1);
  });

  it('fails closed when canonical accounting is unavailable', async () => {
    const controller = new ModelBudgetController(makeConfig('/tmp/psfn-model-budget-unavailable'));
    const preflight = await controller.evaluatePreflight(preflightInput);

    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('accounting_unavailable');
  });

  it('retains the canonical accounting failure as diagnostic cause', async () => {
    const databaseError = new Error('postgres connection refused');
    const controller = new ModelBudgetController(
      makeConfig('/tmp/psfn-model-budget-query-error'),
      { getModelBudgetSpend: vi.fn().mockRejectedValue(databaseError) },
    );
    const preflight = await controller.evaluatePreflight(preflightInput);

    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('accounting_unavailable');
    expect(preflight.accountingError).toBe(databaseError);
  });

  it('fails closed when budget is enabled but candidate cost metadata is missing', async () => {
    const dataDir = '/tmp/psfn-model-budget-missing-rate';
    const baseRegistry = makeConfig(dataDir).modelRegistry!;
    const config = makeConfig(dataDir, {
      modelRegistry: {
        ...baseRegistry,
        models: baseRegistry.models.map((entry) => {
          if (entry.id !== 'chat') return entry;
          const { cost: _unusedCost, ...withoutCost } = entry;
          return withoutCost;
        }),
      },
    });
    const controller = new ModelBudgetController(config, makeQuery());
    const preflight = await controller.evaluatePreflight(preflightInput);

    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('missing_cost_metadata');
  });

  it('does not query canonical spend when budget policy is disabled', async () => {
    const dataDir = '/tmp/psfn-model-budget-disabled';
    const baseRegistry = makeConfig(dataDir).modelRegistry!;
    const query = makeQuery();
    const controller = new ModelBudgetController(makeConfig(dataDir, {
      modelRegistry: {
        ...baseRegistry,
        budgetPolicy: {
          enabled: false,
          dailyUsdLimit: 1,
          monthlyUsdLimit: 10,
          currency: 'USD',
        },
      },
    }), query);

    expect(controller.requiresPreflightEstimate()).toBe(false);
    await expect(controller.evaluatePreflight(preflightInput)).resolves.toMatchObject({
      allowed: true,
      estimatedRequestCostUsd: 0,
      snapshot: null,
    });
    expect(query.getModelBudgetSpend).not.toHaveBeenCalled();
  });
});

describe('resolveModelUsageCostRatesForIdentity', () => {
  it('uses only an exact canonical provider and model identity match', () => {
    const dataDir = '/tmp/psfn-model-budget-rate-resolution';
    const base = makeConfig(dataDir);
    const config = makeConfig(dataDir, {
      modelRegistry: {
        ...base.modelRegistry!,
        models: [
          ...base.modelRegistry!.models,
          {
            id: 'embedding',
            rank: 30,
            identity: {
              provider: 'api',
              model: 'text-embedding-3-small',
              source: { type: 'api' },
            },
            purposes: [{ purpose: 'memory', primary: true }],
            cost: {
              inputPer1MUsd: 2,
              cacheReadPer1MUsd: 0.2,
              currency: 'USD',
            },
          },
        ],
      },
    });

    expect(resolveModelUsageCostRatesForIdentity(config, {
      provider: 'api',
      model: 'text-embedding-3-small',
    })).toEqual({
      inputPer1MUsd: 2,
      cacheReadPer1MUsd: 0.2,
      currency: 'USD',
    });
    expect(resolveModelUsageCostRatesForIdentity(config, {
      provider: 'openai',
      model: 'text-embedding-3-small',
    })).toBeUndefined();
    expect(resolveModelUsageCostRatesForIdentity(config, {
      provider: 'api',
      model: 'text-embedding-3-small',
      slotKey: 'chat',
    })).toBeUndefined();
  });

  it('fails closed for ambiguous exact identities regardless of registry order', () => {
    const dataDir = '/tmp/psfn-model-budget-ambiguous-rate-resolution';
    const base = makeConfig(dataDir);
    const pricedEntry = {
      id: 'embedding-priced',
      rank: 30,
      identity: {
        provider: 'api',
        model: 'text-embedding-3-small',
        source: { type: 'api' as const },
      },
      purposes: [{ purpose: 'memory' as const, primary: true }],
      cost: {
        inputPer1MUsd: 2,
        currency: 'USD',
      },
    };
    const unpricedEntry = {
      id: 'embedding-unpriced',
      rank: 40,
      identity: {
        provider: 'api',
        model: 'text-embedding-3-small',
        source: { type: 'api' as const },
      },
      purposes: [{ purpose: 'chat' as const, primary: false }],
    };

    for (const ambiguousEntries of [
      [pricedEntry, unpricedEntry],
      [unpricedEntry, pricedEntry],
    ]) {
      const config = makeConfig(dataDir, {
        modelRegistry: {
          ...base.modelRegistry!,
          models: [
            ...base.modelRegistry!.models,
            ...ambiguousEntries,
          ],
        },
      });

      expect(resolveModelUsageCostRatesForIdentity(config, {
        provider: 'api',
        model: 'text-embedding-3-small',
      })).toBeUndefined();
      expect(findRegistryEntryByProviderModel(
        config,
        'api',
        'text-embedding-3-small',
      )).toBeUndefined();
    }
  });

  it('fails closed for model-only ambiguity across providers regardless of registry order', () => {
    const dataDir = '/tmp/psfn-model-budget-model-only-ambiguity';
    const base = makeConfig(dataDir);
    const apiEntry = {
      id: 'embedding-api',
      rank: 30,
      identity: {
        provider: 'api',
        model: 'text-embedding-3-small',
        source: { type: 'api' as const },
      },
      purposes: [{ purpose: 'memory' as const, primary: true }],
    };
    const openAiEntry = {
      id: 'embedding-openai',
      rank: 40,
      identity: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        source: { type: 'openai' as const },
      },
      purposes: [{ purpose: 'memory' as const, primary: false }],
    };

    for (const ambiguousEntries of [
      [apiEntry, openAiEntry],
      [openAiEntry, apiEntry],
    ]) {
      const config = makeConfig(dataDir, {
        modelRegistry: {
          ...base.modelRegistry!,
          models: [
            ...base.modelRegistry!.models,
            ...ambiguousEntries,
          ],
        },
      });

      expect(findRegistryEntryByModelId(config, 'text-embedding-3-small'))
        .toBeUndefined();
      expect(findRegistryEntryByProviderModel(config, 'api', 'text-embedding-3-small')?.id)
        .toBe('embedding-api');
      expect(findRegistryEntryByProviderModel(config, 'openai', 'text-embedding-3-small')?.id)
        .toBe('embedding-openai');
    }
  });
});
