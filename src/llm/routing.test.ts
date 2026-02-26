import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../types.js';
import { resolveRoutingCandidates } from './routing.js';

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'primary/model',
    primaryProvider: 'openrouter',
    extractionModel: 'extract/model',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 4096,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: './data/test.db',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: {
        model: 'primary/model',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 128_000,
      },
      background: {
        model: 'background/model',
        provider: 'openrouter',
        maxTokens: 2048,
      },
    },
    ...overrides,
  };
}

describe('resolveRoutingCandidates(background)', () => {
  it('prefers configured background slot', () => {
    const candidates = resolveRoutingCandidates(makeConfig(), 'background');
    expect(candidates[0]).toMatchObject({
      model: 'background/model',
      provider: 'openrouter',
      maxTokens: 2048,
    });
  });

  it('falls back to primary/chat slot when background is not configured', () => {
    const config = makeConfig({
      modelRoster: {
        chat: {
          model: 'primary/model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
      },
    });

    const candidates = resolveRoutingCandidates(config, 'background');
    expect(candidates[0]).toMatchObject({
      model: 'primary/model',
      provider: 'openrouter',
      maxTokens: 4096,
    });
    expect(candidates.some(candidate => candidate.model === 'extract/model')).toBe(true);
  });

  it('falls back to primary catalog slot when no background assignment exists', () => {
    const config = makeConfig({
      modelCatalog: {
        primary: {
          model: 'catalog/primary',
          provider: 'openrouter',
          overrides: { maxTokens: 6144 },
        },
        extraction: {
          model: 'catalog/extract',
          provider: 'openrouter',
          overrides: { maxTokens: 2048 },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
        extraction: 'extraction',
      },
      modelRoster: {
        chat: {
          model: 'primary/model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
      },
    });

    const candidates = resolveRoutingCandidates(config, 'background');
    expect(candidates[0]).toMatchObject({
      slotKey: 'primary',
      model: 'catalog/primary',
      provider: 'openrouter',
    });
  });
});
