import { describe, expect, it } from 'vitest';
import type { CanonicalModelPurpose, CanonicalModelRegistry, ModelRegistryEntry } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { evaluateImportPolicy, resolveRoutingCandidates } from './routing.js';

interface RegistryModelInput {
  id: string;
  rank: number;
  provider: string;
  model: string;
  source?: ModelRegistryEntry['identity']['source'];
  maxOutputTokens: number;
  contextWindow: number;
  supportsVision?: boolean;
  purposes: Array<{ purpose: CanonicalModelPurpose; primary: boolean }>;
  cost?: { inputPer1MUsd?: number; outputPer1MUsd?: number };
}

function makeRegistry(models: RegistryModelInput[]): CanonicalModelRegistry {
  return {
    schemaVersion: 1,
    models: models.map((model): ModelRegistryEntry => ({
      id: model.id,
      rank: model.rank,
      identity: {
        provider: model.provider,
        model: model.model,
        source: model.source ?? { type: model.provider },
      },
      purposes: model.purposes,
      capabilities: {
        maxOutputTokens: model.maxOutputTokens,
        contextWindow: model.contextWindow,
        ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
      },
      tuning: {
        maxOutputTokens: model.maxOutputTokens,
        contextWindow: model.contextWindow,
      },
      ...(model.cost ? { cost: model.cost } : {}),
    })),
  };
}

function makeBaseRegistry(): CanonicalModelRegistry {
  return makeRegistry([
    {
      id: 'chat-primary',
      rank: 20,
      provider: 'openrouter',
      model: 'chat/model',
      maxOutputTokens: 8192,
      contextWindow: 128_000,
      purposes: [
        { purpose: 'chat', primary: true },
        { purpose: 'summary', primary: true },
        { purpose: 'reasoning', primary: true },
        { purpose: 'longContext', primary: true },
        { purpose: 'moa', primary: true },
      ],
      cost: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    },
    {
      id: 'vision-primary',
      rank: 25,
      provider: 'openrouter',
      model: 'vision/model',
      maxOutputTokens: 4096,
      contextWindow: 1_000_000,
      supportsVision: true,
      purposes: [
        { purpose: 'vision', primary: true },
      ],
      cost: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    },
    {
      id: 'background-primary',
      rank: 30,
      provider: 'openrouter',
      model: 'background/model',
      maxOutputTokens: 2048,
      contextWindow: 64_000,
      purposes: [
        { purpose: 'background', primary: true },
        { purpose: 'extraction', primary: true },
        { purpose: 'import_processing', primary: true },
      ],
      cost: { inputPer1MUsd: 0.2, outputPer1MUsd: 0.4 },
    },
  ]);
}

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'chat/model',
    primaryProvider: 'openrouter',
    extractionModel: 'background/model',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 8192,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: './data/test.db',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {},
    modelRegistry: makeBaseRegistry(),
    ...overrides,
  };
}

describe('resolveRoutingCandidates(background)', () => {
  it('orders candidates with primary first, then lower rank, then capability fit, then cost', () => {
    const config = makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'background-primary',
          rank: 100,
          provider: 'openrouter',
          model: 'background/primary',
          maxOutputTokens: 1024,
          contextWindow: 16_000,
          purposes: [{ purpose: 'background', primary: true }],
          cost: { inputPer1MUsd: 10, outputPer1MUsd: 10 },
        },
        {
          id: 'background-secondary-rank-1',
          rank: 1,
          provider: 'openrouter',
          model: 'background/secondary-rank-1',
          maxOutputTokens: 2048,
          contextWindow: 32_000,
          purposes: [{ purpose: 'background', primary: false }],
          cost: { inputPer1MUsd: 4, outputPer1MUsd: 8 },
        },
        {
          id: 'background-secondary-rank-5',
          rank: 5,
          provider: 'openrouter',
          model: 'background/secondary-rank-5',
          maxOutputTokens: 8192,
          contextWindow: 128_000,
          purposes: [{ purpose: 'background', primary: false }],
          cost: { inputPer1MUsd: 0.1, outputPer1MUsd: 0.2 },
        },
      ]),
    });

    const candidates = resolveRoutingCandidates(config, 'background');
    expect(candidates.map(candidate => candidate.model)).toEqual([
      'background/primary',
      'background/secondary-rank-1',
      'background/secondary-rank-5',
    ]);
  });

  it('uses capability fit before cost when rank ties', () => {
    const config = makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'background-primary',
          rank: 100,
          provider: 'openrouter',
          model: 'background/primary',
          maxOutputTokens: 1024,
          contextWindow: 16_000,
          purposes: [{ purpose: 'background', primary: true }],
        },
        {
          id: 'high-capability-high-cost',
          rank: 10,
          provider: 'openrouter',
          model: 'background/high-capability',
          maxOutputTokens: 8192,
          contextWindow: 128_000,
          purposes: [{ purpose: 'background', primary: false }],
          cost: { inputPer1MUsd: 5, outputPer1MUsd: 8 },
        },
        {
          id: 'lower-capability-low-cost',
          rank: 10,
          provider: 'openrouter',
          model: 'background/lower-capability',
          maxOutputTokens: 2048,
          contextWindow: 32_000,
          purposes: [{ purpose: 'background', primary: false }],
          cost: { inputPer1MUsd: 0.01, outputPer1MUsd: 0.02 },
        },
      ]),
    });

    const candidates = resolveRoutingCandidates(config, 'background');
    expect(candidates.map(candidate => candidate.model)).toEqual([
      'background/primary',
      'background/high-capability',
      'background/lower-capability',
    ]);
  });

  it('uses lower cost as a tiebreaker when rank and capabilities are equal', () => {
    const config = makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'background-primary',
          rank: 100,
          provider: 'openrouter',
          model: 'background/primary',
          maxOutputTokens: 1024,
          contextWindow: 16_000,
          purposes: [{ purpose: 'background', primary: true }],
        },
        {
          id: 'expensive',
          rank: 10,
          provider: 'openrouter',
          model: 'background/expensive',
          maxOutputTokens: 4096,
          contextWindow: 64_000,
          purposes: [{ purpose: 'background', primary: false }],
          cost: { inputPer1MUsd: 8, outputPer1MUsd: 8 },
        },
        {
          id: 'cheap',
          rank: 10,
          provider: 'openrouter',
          model: 'background/cheap',
          maxOutputTokens: 4096,
          contextWindow: 64_000,
          purposes: [{ purpose: 'background', primary: false }],
          cost: { inputPer1MUsd: 0.1, outputPer1MUsd: 0.2 },
        },
      ]),
    });

    const candidates = resolveRoutingCandidates(config, 'background');
    expect(candidates.map(candidate => candidate.model)).toEqual([
      'background/primary',
      'background/cheap',
      'background/expensive',
    ]);
  });

  it('attaches global OpenRouter provider preference ordering to OpenRouter candidates', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      openRouterProviderOrder: ['parasail', 'openai'],
      openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
    }), 'background');

    expect(candidates[0]?.openRouterProviderOrder).toEqual(['parasail', 'openai']);
    expect(candidates.every(candidate => candidate.provider === 'openrouter')).toBe(true);
  });

  it('routes OpenRouter-sourced models through the configured OpenRouter endpoint without local registry coupling', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
      modelRegistry: makeRegistry([
        {
          id: 'pi-live-chat',
          rank: 10,
          provider: 'openrouter',
          model: 'z-ai/glm-5.2',
          maxOutputTokens: 16384,
          contextWindow: 202752,
          purposes: [{ purpose: 'chat', primary: true }],
        },
      ]),
    }), 'chat');

    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        requestBaseUrl: 'https://openrouter.ai/api/v1',
        requestApiKeyEnv: 'OPENROUTER_API_KEY',
      }),
    ]);
  });

  it('normalizes Pi LiteLLM-labeled entries with OpenRouter source metadata to direct OpenRouter candidates', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'pi-live-openrouter-source',
          rank: 10,
          provider: 'litellm',
          model: 'moonshotai/kimi-k2.6',
          source: {
            type: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
          },
          maxOutputTokens: 8192,
          contextWindow: 262144,
          purposes: [{ purpose: 'chat', primary: true }],
        },
      ]),
    }), 'chat');

    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.6',
        requestBaseUrl: 'https://openrouter.ai/api/v1',
        requestApiKeyEnv: 'OPENROUTER_API_KEY',
      }),
    ]);
  });

  it('uses the configured OpenRouter API key reference for direct OpenRouter endpoint routes', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
      openRouterApiKeyRef: { kind: 'env', envName: 'CUSTOM_OPENROUTER_KEY' },
      modelRegistry: makeRegistry([
        {
          id: 'pi-live-custom-key',
          rank: 10,
          provider: 'openrouter',
          model: 'z-ai/glm-5.2',
          maxOutputTokens: 16384,
          contextWindow: 202752,
          purposes: [{ purpose: 'chat', primary: true }],
        },
      ]),
    }), 'chat');

    expect(candidates[0]).toEqual(expect.objectContaining({
      provider: 'openrouter',
      model: 'z-ai/glm-5.2',
      requestApiKeyEnv: 'CUSTOM_OPENROUTER_KEY',
    }));
  });
});

describe('resolveRoutingCandidates(vision)', () => {
  it('uses only registry candidates that explicitly support vision input', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'text-tagged-primary',
          rank: 1,
          provider: 'openrouter',
          model: 'text/tagged-primary',
          maxOutputTokens: 4096,
          contextWindow: 128_000,
          purposes: [{ purpose: 'vision', primary: true }],
        },
        {
          id: 'vision-secondary',
          rank: 2,
          provider: 'openrouter',
          model: 'vision/secondary',
          maxOutputTokens: 4096,
          contextWindow: 1_000_000,
          supportsVision: true,
          purposes: [{ purpose: 'vision', primary: false }],
        },
        {
          id: 'vision-false',
          rank: 3,
          provider: 'openrouter',
          model: 'vision/false',
          maxOutputTokens: 4096,
          contextWindow: 1_000_000,
          supportsVision: false,
          purposes: [{ purpose: 'vision', primary: false }],
        },
      ]),
    }), 'vision');

    expect(candidates).toEqual([
      expect.objectContaining({
        model: 'vision/secondary',
        supportsVision: true,
      }),
    ]);
  });
});

describe('resolveRoutingCandidates(context legacy alias)', () => {
  it('prefers longContext candidates and then falls back to background and chat candidates', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'chat-primary',
          rank: 20,
          provider: 'openrouter',
          model: 'chat/model',
          maxOutputTokens: 4096,
          contextWindow: 128_000,
          purposes: [{ purpose: 'chat', primary: true }],
        },
        {
          id: 'background-primary',
          rank: 30,
          provider: 'openrouter',
          model: 'background/model',
          maxOutputTokens: 2048,
          contextWindow: 64_000,
          purposes: [{ purpose: 'background', primary: true }],
        },
        {
          id: 'long-context-primary',
          rank: 40,
          provider: 'openrouter',
          model: 'long-context/model',
          maxOutputTokens: 6144,
          contextWindow: 256_000,
          purposes: [{ purpose: 'longContext', primary: true }],
        },
      ]),
    }), 'context');

    expect(candidates.map(candidate => candidate.model)).toEqual([
      'long-context/model',
      'background/model',
      'chat/model',
    ]);
  });

  it('falls back deterministically to background then chat when longContext tags are absent', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'chat-primary',
          rank: 20,
          provider: 'openrouter',
          model: 'chat/model',
          maxOutputTokens: 4096,
          contextWindow: 128_000,
          purposes: [{ purpose: 'chat', primary: true }],
        },
        {
          id: 'background-primary',
          rank: 30,
          provider: 'openrouter',
          model: 'background/model',
          maxOutputTokens: 2048,
          contextWindow: 64_000,
          purposes: [{ purpose: 'background', primary: true }],
        },
      ]),
    }), 'context');

    expect(candidates.map(candidate => candidate.model)).toEqual([
      'background/model',
      'chat/model',
    ]);
  });
});

describe('resolveRoutingCandidates(import_processing)', () => {
  it('enforces openrouter_zdr mode for import processing', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      importProcessingRouteMode: 'openrouter_zdr',
      modelRegistry: makeRegistry([
        {
          id: 'import-openrouter',
          rank: 10,
          provider: 'openrouter',
          model: 'import/openrouter',
          maxOutputTokens: 2048,
          contextWindow: 64_000,
          purposes: [{ purpose: 'import_processing', primary: true }],
        },
        {
          id: 'import-anthropic',
          rank: 20,
          provider: 'anthropic',
          model: 'import/anthropic',
          maxOutputTokens: 2048,
          contextWindow: 64_000,
          purposes: [{ purpose: 'import_processing', primary: false }],
        },
      ]),
    }), 'import_processing');

    expect(candidates).toEqual([
      expect.objectContaining({
        model: 'import/openrouter',
        provider: 'openrouter',
        openRouterZdrOnly: true,
        importRouteMode: 'openrouter_zdr',
      }),
    ]);
  });

  it('returns only local endpoint candidate when local mode is configured', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      importProcessingRouteMode: 'local_endpoint',
      importProcessingLocalEndpointUrl: 'http://localhost:11434/v1',
      importProcessingLocalModel: 'llama3.2:latest',
      modelRegistry: makeRegistry([
        {
          id: 'import-primary',
          rank: 10,
          provider: 'openrouter',
          model: 'import/openrouter',
          maxOutputTokens: 4096,
          contextWindow: 64_000,
          purposes: [{ purpose: 'import_processing', primary: true }],
        },
      ]),
    }), 'import_processing');

    expect(candidates).toEqual([
      {
        model: 'llama3.2:latest',
        provider: 'local_endpoint',
        maxTokens: 4096,
        requestBaseUrl: 'http://localhost:11434/v1',
        requestApiKeyEnv: 'IMPORT_PROCESSING_LOCAL_API_KEY',
        importRouteMode: 'local_endpoint',
      },
    ]);
  });
});

describe('resolveRoutingCandidates(memory)', () => {
  it('prefers memory-primary candidates over background candidates', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'memory-primary',
          rank: 20,
          provider: 'openrouter',
          model: 'memory/model',
          maxOutputTokens: 2048,
          contextWindow: 96_000,
          purposes: [{ purpose: 'memory', primary: true }],
        },
        {
          id: 'background-primary',
          rank: 10,
          provider: 'openrouter',
          model: 'background/model',
          maxOutputTokens: 4096,
          contextWindow: 128_000,
          purposes: [{ purpose: 'background', primary: true }],
        },
      ]),
    }), 'memory');

    expect(candidates.map((candidate) => candidate.model)).toEqual(['memory/model']);
  });
});

describe('resolveRoutingCandidates prompt caching', () => {
  it('defaults prompt cache retention and scope when prompt caching is enabled', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'summary-cache',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'summary/cached',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
              supportsPromptCaching: true,
              promptCacheStrategy: 'openai_responses',
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
        ],
      },
    }), 'summary');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      model: 'summary/cached',
      promptCacheStrategy: 'openai_responses',
      promptCacheRetention: 'short',
      promptCacheScope: 'channel',
    });
  });

  it('fails closed when prompt caching is enabled without a strategy', () => {
    expect(() => resolveRoutingCandidates(makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'summary-cache',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'summary/cached',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
              supportsPromptCaching: true,
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
        ],
      },
    }), 'summary')).toThrow('promptCacheStrategy is required when supportsPromptCaching is true');
  });
});
describe('resolveRoutingCandidates fail-closed behavior', () => {
  it('returns no candidates when no eligible registry models exist for the requested purpose', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: makeRegistry([
        {
          id: 'chat-primary',
          rank: 1,
          provider: 'openrouter',
          model: 'chat/model',
          maxOutputTokens: 4096,
          contextWindow: 128_000,
          purposes: [{ purpose: 'chat', primary: true }],
        },
      ]),
    }), 'background');

    expect(candidates).toEqual([]);
  });

  it('does not route from legacy modelRoster data when canonical modelRegistry is absent', () => {
    const candidates = resolveRoutingCandidates(makeConfig({
      modelRegistry: undefined,
      modelRoster: {
        chat: {
          model: 'legacy/chat',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
        background: {
          model: 'legacy/background',
          provider: 'openrouter',
          maxTokens: 2048,
        },
      },
    }), 'chat');

    expect(candidates).toEqual([]);
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

describe('registry-wide promptCaching policy (E2.4)', () => {
  it('leaves candidates untouched when the policy is absent or disabled (default off)', () => {
    for (const config of [
      makeConfig(),
      makeConfig({
        modelRegistry: { ...makeBaseRegistry(), promptCaching: { enabled: false } },
      }),
    ]) {
      const candidates = resolveRoutingCandidates(config, 'chat');
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(candidate.promptCacheEnabled).toBeUndefined();
        expect(candidate.promptCacheRetention).toBeUndefined();
        expect(candidate.promptCacheScope).toBeUndefined();
      }
    }
  });

  it('marks every candidate cache-enabled with policy retention/scope when enabled', () => {
    const config = makeConfig({
      modelRegistry: {
        ...makeBaseRegistry(),
        promptCaching: { enabled: true, retention: 'long', scope: 'request' },
      },
    });
    for (const purpose of ['chat', 'background'] as const) {
      const candidates = resolveRoutingCandidates(config, purpose);
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(candidate.promptCacheEnabled).toBe(true);
        expect(candidate.promptCacheRetention).toBe('long');
        expect(candidate.promptCacheScope).toBe('request');
      }
    }
  });

  it('defaults retention to short and scope to channel', () => {
    const config = makeConfig({
      modelRegistry: {
        ...makeBaseRegistry(),
        promptCaching: { enabled: true },
      },
    });
    const [candidate] = resolveRoutingCandidates(config, 'chat');
    expect(candidate.promptCacheEnabled).toBe(true);
    expect(candidate.promptCacheRetention).toBe('short');
    expect(candidate.promptCacheScope).toBe('channel');
  });
});
