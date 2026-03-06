import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../types.js';
import { evaluateImportPolicy, resolveRoutingCandidates } from './routing.js';

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

  it('attaches OpenRouter provider preference ordering to OpenRouter candidates', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      openRouterProviderOrder: ['parasail', 'openai'],
    }), 'background');

    expect(candidates[0]?.openRouterProviderOrder).toEqual(['parasail', 'openai']);
    expect(candidates.every(candidate => candidate.provider === 'openrouter')).toBe(true);
  });

  it('prefers slot-level OpenRouter provider ordering over the global setting', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      openRouterProviderOrder: ['global-provider'],
      modelCatalog: {
        primary: {
          model: 'catalog/primary',
          provider: 'openrouter',
          overrides: { maxTokens: 6144 },
          routing: { providerOrder: ['slot-provider', 'backup-provider'] },
        },
      },
      modelRoleAssignments: {
        background: 'primary',
        chat: 'primary',
      },
      modelRoster: {},
    }), 'background');

    expect(candidates[0]).toMatchObject({
      slotKey: 'primary',
      model: 'catalog/primary',
      provider: 'openrouter',
      openRouterProviderOrder: ['slot-provider', 'backup-provider'],
    });
  });

  it('allows a slot to clear inherited global OpenRouter provider ordering', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      openRouterProviderOrder: ['global-provider'],
      modelCatalog: {
        primary: {
          model: 'catalog/primary',
          provider: 'openrouter',
          overrides: { maxTokens: 6144 },
          routing: { providerOrder: [] },
        },
      },
      modelRoleAssignments: {
        background: 'primary',
        chat: 'primary',
      },
      modelRoster: {},
    }), 'background');

    expect(candidates[0]?.openRouterProviderOrder).toEqual([]);
  });
});

describe('resolveRoutingCandidates(context)', () => {
  it('prefers a dedicated context slot before background fallbacks', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelCatalog: {
        primary: {
          model: 'catalog/primary',
          provider: 'openrouter',
          overrides: { maxTokens: 6144, contextWindow: 128_000 },
        },
        extraction: {
          model: 'catalog/extract',
          provider: 'openrouter',
          overrides: { maxTokens: 2048 },
        },
        helper: {
          model: 'catalog/helper',
          provider: 'openrouter',
          overrides: { maxTokens: 1024, contextWindow: 64_000 },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
        background: 'extraction',
        context: 'helper',
        extraction: 'extraction',
      },
      modelRoster: {},
    }), 'context');

    expect(candidates[0]).toMatchObject({
      slotKey: 'helper',
      model: 'catalog/helper',
      provider: 'openrouter',
      maxTokens: 1024,
      contextWindow: 64_000,
    });
  });

  it('falls back from context to background and then chat', () => {
    const backgroundCandidates = resolveRoutingCandidates(makeConfig({
      modelRoster: {
        background: {
          model: 'background/model',
          provider: 'openrouter',
          maxTokens: 2048,
        },
      },
    }), 'context');
    expect(backgroundCandidates[0]).toMatchObject({
      model: 'background/model',
      provider: 'openrouter',
      maxTokens: 2048,
    });

    const chatCandidates = resolveRoutingCandidates(makeConfig({
      modelRoster: {
        chat: {
          model: 'primary/model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
      },
      modelCatalog: {
        primary: {
          model: 'catalog/primary',
          provider: 'openrouter',
          overrides: { maxTokens: 4096, contextWindow: 128_000 },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
      },
    }), 'context');
    expect(chatCandidates[0]).toMatchObject({
      slotKey: 'primary',
      model: 'catalog/primary',
      provider: 'openrouter',
      maxTokens: 4096,
    });
  });
});

describe('resolveRoutingCandidates(import_processing)', () => {
  it('enforces openrouter_zdr mode for import processing', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      importProcessingRouteMode: 'openrouter_zdr',
      modelRoster: {
        background: {
          model: 'background/model',
          provider: 'openrouter',
          maxTokens: 2048,
        },
        chat: {
          model: 'chat/fallback',
          provider: 'anthropic',
          maxTokens: 4096,
        },
      },
    }), 'import_processing');

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(candidate => candidate.provider === 'openrouter')).toBe(true);
    expect(candidates.every(candidate => candidate.openRouterZdrOnly === true)).toBe(true);
    expect(candidates.every(candidate => candidate.importRouteMode === 'openrouter_zdr')).toBe(true);
  });

  it('returns only local endpoint candidate when local mode is configured', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      importProcessingRouteMode: 'local_endpoint',
      importProcessingLocalEndpointUrl: 'http://localhost:11434/v1',
      importProcessingLocalModel: 'llama3.2:latest',
    }), 'import_processing');

    expect(candidates).toEqual([
      {
        model: 'llama3.2:latest',
        provider: 'local_endpoint',
        maxTokens: 2048,
        requestBaseUrl: 'http://localhost:11434/v1',
        requestApiKeyEnv: 'IMPORT_PROCESSING_LOCAL_API_KEY',
        importRouteMode: 'local_endpoint',
      },
    ]);
  });
});

describe('evaluateImportPolicy', () => {
  it('rejects non-zdr import routes when strict policy is enabled', () => {
    const config = makeConfig({
      importProcessingRouteMode: 'background',
      importProcessingStrictPolicy: true,
    });

    const decision = evaluateImportPolicy(config, 'import_processing', {
      model: 'background/model',
      provider: 'openrouter',
      maxTokens: 2048,
      importRouteMode: 'background',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('strict_requires_openrouter_zdr');
    expect(decision.audit.strictPolicyEnabled).toBe(true);
    expect(decision.audit.openRouterZdrOnly).toBe(false);
  });

  it('allows strict-mode import routes when candidate is OpenRouter ZDR', () => {
    const config = makeConfig({
      importProcessingRouteMode: 'openrouter_zdr',
      importProcessingStrictPolicy: true,
    });

    const decision = evaluateImportPolicy(config, 'import_processing', {
      model: 'background/model',
      provider: 'openrouter',
      maxTokens: 2048,
      openRouterZdrOnly: true,
      importRouteMode: 'openrouter_zdr',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });
});
