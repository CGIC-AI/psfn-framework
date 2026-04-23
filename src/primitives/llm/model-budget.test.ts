import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { ModelBudgetController } from './model-budget.js';

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
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-model-budget-'));
    tempDirs.push(dir);
    return dir;
  }

  it('records usage and returns queryable daily/monthly aggregates', () => {
    const dataDir = makeTempDir();
    const controller = new ModelBudgetController(makeConfig(dataDir));

    expect(controller.requiresPreflightEstimate()).toBe(true);

    controller.recordUsage({
      candidate: { provider: 'openrouter', model: 'z-ai/glm-5', maxTokens: 4096, slotKey: 'chat' },
      purpose: 'chat',
      service: 'chat',
      process: 'agent.turn.prompt',
      inputTokens: 1200,
      outputTokens: 800,
      nowMs: Date.parse('2026-03-06T12:00:00.000Z'),
    });

    const snapshot = controller.getUsageSnapshot(Date.parse('2026-03-06T18:00:00.000Z'));
    expect(snapshot.dailyTotals.calls).toBe(1);
    expect(snapshot.dailyTotals.inputTokens).toBe(1200);
    expect(snapshot.dailyTotals.outputTokens).toBe(800);
    expect(snapshot.dailyTotals.estimatedCostUsd).toBeCloseTo(0.002, 8);
    expect(snapshot.totalsByModel['openrouter:z-ai/glm-5'].calls).toBe(1);
    expect(snapshot.totalsByServiceProcess['chat:agent.turn.prompt'].calls).toBe(1);
  });

  it('blocks when projected daily budget would be exceeded', () => {
    const dataDir = makeTempDir();
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
    const controller = new ModelBudgetController(config);

    controller.recordUsage({
      candidate: { provider: 'openrouter', model: 'z-ai/glm-5', maxTokens: 4096, slotKey: 'chat' },
      purpose: 'chat',
      service: 'chat',
      process: 'agent.turn.prompt',
      inputTokens: 1000,
      outputTokens: 0,
      nowMs: Date.parse('2026-03-06T09:00:00.000Z'),
    });

    const preflight = controller.evaluatePreflight({
      candidate: { provider: 'openrouter', model: 'z-ai/glm-5', maxTokens: 1000, slotKey: 'chat' },
      purpose: 'chat',
      service: 'chat',
      process: 'agent.turn.prompt',
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 1000,
      nowMs: Date.parse('2026-03-06T10:00:00.000Z'),
    });

    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('daily_budget_exceeded');
    expect(preflight.blockedEvent?.budget.dailyLimitUsd).toBe(0.001);
    expect(preflight.blockedEvent?.budget.dailySpentUsd).toBeCloseTo(0.001, 8);
  });

  it('fails closed when budget is enabled but cost metadata is missing', () => {
    const dataDir = makeTempDir();
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
    const controller = new ModelBudgetController(config);

    const preflight = controller.evaluatePreflight({
      candidate: { provider: 'openrouter', model: 'z-ai/glm-5', maxTokens: 1000, slotKey: 'chat' },
      purpose: 'chat',
      service: 'chat',
      process: 'agent.turn.prompt',
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 1000,
      nowMs: Date.parse('2026-03-06T10:00:00.000Z'),
    });

    expect(preflight.allowed).toBe(false);
    expect(preflight.blockedEvent?.reason).toBe('missing_cost_metadata');
  });

  it('does not require preflight estimates when budget policy is disabled', () => {
    const dataDir = makeTempDir();
    const baseRegistry = makeConfig(dataDir).modelRegistry!;
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
    }));

    expect(controller.requiresPreflightEstimate()).toBe(false);
    expect(controller.evaluatePreflight({
      candidate: { provider: 'openrouter', model: 'z-ai/glm-5', maxTokens: 1000, slotKey: 'chat' },
      purpose: 'chat',
      service: 'chat',
      process: 'agent.turn.prompt',
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      nowMs: Date.parse('2026-03-06T10:00:00.000Z'),
    })).toMatchObject({
      allowed: true,
      estimatedRequestCostUsd: 0,
      snapshot: null,
    });
  });
});
