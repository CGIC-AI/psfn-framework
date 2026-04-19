import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBackupConfig } from '../../../system/config/backup-config.js';
import { loadCapabilityTierConfig } from '../../../system/config/capability-tier-config.js';
import { loadChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import { loadModelsConfig } from '../../../system/config/models-config.js';
import { loadProvidersConfig } from '../../../system/config/providers-config.js';
import { loadSchedulerConfig } from '../../../system/config/scheduler-config.js';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import { loadSettings } from '../../../system/settings.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { AdminSettingsDataService } from './settings-service.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-settings-service-'));
  return tempDir;
}

function buildConfig(
  root: string,
  hooks?: {
    refreshModels?: () => void;
    refreshCapabilities?: () => void;
  },
): SubstrateConfig {
  const defaultContextWindow = 128_000;
  const models = loadModelsConfig(root, { defaultContextWindow });
  const providers = loadProvidersConfig(root);
  loadSettings(root);

  return {
    primaryModel: models.primaryModel,
    primaryProvider: models.primaryProvider,
    extractionModel: models.extractionModel,
    extractionProvider: models.extractionProvider,
    primaryMaxTokens: models.primaryMaxTokens,
    extractionMaxTokens: models.extractionMaxTokens,
    discordToken: '',
    discordBotId: 'settings-service-test-bot',
    characterCardPath: join(root, 'character.json'),
    dataDir: root,
    databasePath: join(root, 'companion.db'),
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    capabilityTier: 'nursery',
    modelRoster: models.modelRoster,
    modelCatalog: models.modelCatalog,
    modelRoleAssignments: models.modelRoleAssignments,
    modelRegistry: models.modelRegistry,
    providerRegistry: providers.registry,
    litellmBaseUrl: providers.litellmBaseUrl,
    litellmApiKeyRef: providers.litellmApiKeyRef,
    openRouterApiBaseUrl: providers.openRouterApiBaseUrl,
    openRouterModelsApiUrl: providers.openRouterModelsApiUrl,
    openRouterApiKeyRef: providers.openRouterApiKeyRef,
    runtimeHooks: hooks,
  };
}

function buildService(config: SubstrateConfig): AdminSettingsDataService {
  return new AdminSettingsDataService({
    config,
    configStore: createOwnerFileConfigStore({
      dataDir: config.dataDir,
      defaultContextWindow: config.defaultContextWindow,
    }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('AdminSettingsDataService', () => {
  it('round-trips the visible runtime-owned Garden controls through the canonical settings payload', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const payload = {
      sessionRestartBehavior: 'new_session',
      sessionHistoryBudgetPct: 11,
      memoryRetrievalBudgetPct: 7,
      moodCongruenceWeight: 0.55,
      adaptiveContextBudgetsEnabled: true,
      extractionThresholdPct: 34,
      extractionInterval: 7,
      compactionEmotionalSalienceThresholdPct: 82,
      compactionThresholdPct: 76,
      memoryExtractionMinImportance: 0.45,
      memoryExtractionMinConfidence: 0.5,
      memoryExtractionMinNovelty: 0.2,
      memoryExtractionEmotionalIntensityWeight: 0.65,
      memoryExtractionMaxWrites: 14,
      memoryExtractionTelemetryEnabled: false,
      memoryRetrievalTelemetryEnabled: false,
      embeddingProvider: 'api',
      embeddingModel: 'nomic-embed-text',
      embeddingDims: 768,
      embeddingOllamaUrl: 'http://127.0.0.1:11434',
      transformersModel: 'sentence-transformers/all-MiniLM-L6-v2',
      transformersCacheDir: '/tmp/psfn-transformers',
      textEmotionModel: 'j-hartmann/emotion-english-distilroberta-base',
      textEmotionCacheDir: '/tmp/psfn-emotions',
      textEmotionDtype: 'fp16',
      embeddingApiUrl: 'https://example.test/v1/embeddings',
      embeddingApiModel: 'text-embedding-3-small',
      embeddingApiDims: 1536,
      profileSynthesisEnabled: false,
      profileSynthesisRefreshIntervalMs: 7_200_000,
      profileSynthesisCooldownMs: 600_000,
      profileSynthesisMinWrites: 3,
      profileSynthesisMinImportance: 0.7,
      profileSynthesisMinConfidence: 0.75,
      profileSynthesisMinNovelty: 0.22,
      profileSynthesisSourceMemoryLimit: 20,
      profileSynthesisMinSourceMemories: 3,
      uiThemeId: 'generic-dark',
      thinkMaxTokens: 76_000,
      thinkMaxWallTimeMs: 180_000,
      thinkMaxSubQueries: 12,
      retryMaxAttempts: 4,
      retryBaseDelayMs: 2_500,
      importProcessingRouteMode: 'local_endpoint',
      importProcessingStrictPolicy: true,
      importProcessingLocalEndpointUrl: 'http://127.0.0.1:8088',
      importProcessingLocalModel: 'llama3.3:70b',
      openRouterProviderOrder: ['openai', 'anthropic'],
      webFetchAllowHttp: true,
      webFetchDomainAllowlist: ['example.test', 'internal.example'],
      webFetchAllowInternalNetwork: true,
      webFetchTlsCaCertPaths: ['/tmp/ca-one.pem', '/tmp/ca-two.pem'],
      ttsProvider: 'disabled',
      voiceId: 'voice-123',
      echoTtsUrl: 'http://127.0.0.1:8001/v1/audio/speech',
      echoTtsVoice: 'Allison',
      echoTtsPreset: 'High',
      sttProvider: 'disabled',
      deepgramModel: 'nova-2',
      deepgramSttEndpoint: 'https://stt.example.test/v1/listen',
      deepgramListenEndpoint: 'wss://listen.example.test/v1/listen',
      elevenLabsModelId: 'eleven_multilingual_v2',
      elevenLabsEndpointBase: 'https://api.elevenlabs.test',
      obsidianVaultName: 'companion',
      obsidianCliPath: '/usr/bin/obsidian',
      obsidianAutoPublish: true,
      obsidianTimeoutMs: 15_000,
      discordTriggerWords: 'pixie, hey companion',
      discordTriggerReactions: '👆,🔥',
      discordTriggerListenWindowMs: 180_000,
      telegramEnabled: true,
      telegramAuthorizedUsers: '123456,654321',
      promotedExtendedTools: ['obsidian_append_note', 'think'],
      chatApiBaseUrl: 'http://127.0.0.1:3000/api',
      moaEnabled: true,
      moaReferenceModels: ['openai/gpt-4.1-mini', 'anthropic/claude-3.7-sonnet'],
      moaAggregatorModel: 'openai/gpt-4.1',
      moaMaxRounds: 3,
      moaMaxTokensPerRound: 4096,
      moaTimeoutMs: 90_000,
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['apprentice'],
        allowedChannelTypes: ['discord'],
        allowedPurposes: ['think'],
      },
    } satisfies Record<string, unknown>;

    const result = service.updateSettings(JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
    });

    const settingsData = await service.getSettingsData();
    expect(settingsData.config).toEqual(expect.objectContaining(payload));

    const persistedSettings = loadSettings(root);
    expect(persistedSettings).toEqual(expect.objectContaining(payload));
  });

  it('reports local API and admin auth status from runtime config instead of direct env reads', async () => {
    const root = makeTempDir();
    const config = {
      ...buildConfig(root),
      localApiKey: 'local-api-key',
      adminAuthToken: 'admin-token',
    } satisfies SubstrateConfig;
    const service = buildService(config);

    const settingsData = await service.getSettingsData();

    expect(settingsData.env.apiKey).toBe('[set]');
    expect(settingsData.env.adminToken).toBe('[set]');
  });

  it('round-trips model-control runtime settings with persistence and reload guarantees', async () => {
    const root = makeTempDir();
    const refreshModelsSpy = vi.fn();
    const refreshCapabilitiesSpy = vi.fn();
    const config = buildConfig(root, {
      refreshModels: refreshModelsSpy,
      refreshCapabilities: refreshCapabilitiesSpy,
    });
    const service = buildService(config);

    const modelsBefore = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    const runtimeModelControls = {
      thinkMaxTokens: 70000,
      thinkMaxWallTimeMs: 125000,
      thinkMaxSubQueries: 9,
      openRouterProviderOrder: ['parasail', 'openai'],
      uiThemeId: 'generic-dark',
    };

    const result = service.updateSettings(JSON.stringify(runtimeModelControls));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
    });
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);

    const settingsData = await service.getSettingsData();
    expect(settingsData.config).toEqual(expect.objectContaining(runtimeModelControls));

    const reloadedModels = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    expect(settingsData.editors.models).toEqual(modelsBefore);
    expect(reloadedModels).toEqual(modelsBefore);

    const persistedSettings = loadSettings(root);
    expect(persistedSettings).toEqual(expect.objectContaining(runtimeModelControls));
  });

  it('returns field-level errors for malformed and out-of-range model-control payloads and fails closed', () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);

    const modelsBefore = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    const settingsBefore = loadSettings(root);
    const result = service.updateSettings(JSON.stringify({
      thinkMaxTokens: 999,
      thinkMaxWallTimeMs: 1000,
      thinkMaxSubQueries: 0,
      uiThemeId: '',
      modelCatalog: {
        primary: {
          routing: {
            providerOrder: ['openrouter', 123],
          },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('modelCatalog is owned by models.json');
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'thinkMaxTokens',
        message: 'thinkMaxTokens must be 1000-1000000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'thinkMaxWallTimeMs',
        message: 'thinkMaxWallTimeMs must be 5000-600000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'thinkMaxSubQueries',
        message: 'thinkMaxSubQueries must be 1-100',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'uiThemeId',
        message: 'uiThemeId cannot be empty',
        code: 'required',
      }),
      expect.objectContaining({
        field: 'modelCatalog',
        message: 'modelCatalog is owned by models.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'modelCatalog.primary.routing.providerOrder',
        message: 'modelCatalog.primary.routing.providerOrder must be an array of strings',
        code: 'invalid_type',
      }),
    ]));

    const modelsAfter = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    expect(modelsAfter).toEqual(modelsBefore);
    const settingsAfter = loadSettings(root);
    expect(settingsAfter.thinkMaxTokens).toBe(settingsBefore.thinkMaxTokens);
    expect(settingsAfter.thinkMaxWallTimeMs).toBe(settingsBefore.thinkMaxWallTimeMs);
    expect(settingsAfter.thinkMaxSubQueries).toBe(settingsBefore.thinkMaxSubQueries);
  });

  it('applies live context controls through the canonical admin settings mutation path', () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);

    const result = service.updateSettings(JSON.stringify({
      extractionThresholdPct: 34,
      compactionThresholdPct: 76,
    }));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
    });
    expect(config.extractionThresholdPct).toBe(34);
    expect(config.compactionThresholdPct).toBe(76);

    const persistedSettings = loadSettings(root);
    expect(persistedSettings.extractionThresholdPct).toBe(34);
    expect(persistedSettings.compactionThresholdPct).toBe(76);
  });

  it('rejects removed runtime settings instead of silently persisting dead knobs', () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const settingsBefore = loadSettings(root);

    const result = service.updateSettings(JSON.stringify({
      memoryBudgetPct: 24,
      defaultContextWindow: 196_000,
      sessionMessageLimit: 44,
      memoryRetrievalLimit: 12,
      discordEnabled: true,
      discordHeartbeatChannel: '1234567890',
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('memoryBudgetPct has been removed');
    expect(result.message).toContain('defaultContextWindow has been removed');
    expect(result.message).toContain('sessionMessageLimit has been removed');
    expect(result.message).toContain('memoryRetrievalLimit has been removed');
    expect(result.message).toContain('discordEnabled has been removed');
    expect(result.message).toContain('discordHeartbeatChannel has been removed');
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'memoryBudgetPct',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'defaultContextWindow',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'sessionMessageLimit',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'memoryRetrievalLimit',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'discordEnabled',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'discordHeartbeatChannel',
        code: 'removed_field',
      }),
    ]));

    const settingsAfter = loadSettings(root);
    expect((settingsAfter as Record<string, unknown>).memoryBudgetPct).toBeUndefined();
    expect((settingsAfter as Record<string, unknown>).defaultContextWindow).toBeUndefined();
    expect((settingsAfter as Record<string, unknown>).discordEnabled).toBeUndefined();
    expect((settingsAfter as Record<string, unknown>).discordHeartbeatChannel).toBeUndefined();
    expect(settingsAfter).toEqual(settingsBefore);
  });

  it('routes scheduler-backed and capability-tier-backed controls through their owner files', async () => {
    const root = makeTempDir();
    const refreshCapabilitiesSpy = vi.fn();
    const config = buildConfig(root, {
      refreshCapabilities: refreshCapabilitiesSpy,
    });
    const service = buildService(config);
    const schedulerPayload = {
      ...JSON.parse(service.getSubConfigJson('scheduler') ?? '{}'),
      salienceDecayIntervalMs: 180_000,
    };
    const capabilitiesPayload = {
      capabilityTier: 'custom',
      customTokens: ['identity.read', 'memory.write', 'git.read'],
    };

    const schedulerResult = service.saveSubConfigJson('scheduler', JSON.stringify(schedulerPayload));
    const capabilitiesResult = service.saveSubConfigJson('capabilities', JSON.stringify({
      tier: capabilitiesPayload.capabilityTier,
      customTokens: capabilitiesPayload.customTokens,
    }));

    expect(schedulerResult).toEqual({
      ok: true,
      message: 'scheduler.json saved',
    });
    expect(capabilitiesResult).toEqual({
      ok: true,
      message: 'capability-tier.json saved',
    });
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(1);

    const schedulerConfig = loadSchedulerConfig(root);
    expect(schedulerConfig.salienceDecayIntervalMs).toBe(180_000);
    expect(config.maintenanceIntervalMs).toBe(180_000);

    const capabilityConfig = loadCapabilityTierConfig(root);
    expect(capabilityConfig.tier).toBe('custom');
    expect(capabilityConfig.customTokens).toEqual(capabilitiesPayload.customTokens);

    const settingsData = await service.getSettingsData();
    expect(settingsData.editors.scheduler.salienceDecayIntervalMs).toBe(180_000);
    expect(settingsData.editors.capabilities).toEqual(expect.objectContaining({
      tier: 'custom',
      customTokens: capabilitiesPayload.customTokens,
    }));
  });

  it('round-trips models through the raw editor path via the injected config store port', async () => {
    const root = makeTempDir();
    const refreshModelsSpy = vi.fn();
    const config = buildConfig(root, {
      refreshModels: refreshModelsSpy,
    });
    const service = buildService(config);
    const currentModels = JSON.parse(service.getSubConfigJson('models') ?? '{}') as {
      modelRegistry: Record<string, unknown>;
    };
    const nextRegistry = structuredClone(currentModels.modelRegistry);
    const primary = Array.isArray((nextRegistry as { models?: unknown[] }).models)
      ? (nextRegistry as { models: Array<Record<string, unknown>> }).models.find((entry) => entry.id === 'primary')
      : null;
    expect(primary).toBeTruthy();
    if (!primary) {
      throw new Error('expected primary model in seeded model registry');
    }
    primary.identity = {
      ...(primary.identity as Record<string, unknown>),
      model: 'openai/gpt-4.1-mini',
      provider: 'openai',
    };

    const result = service.saveSubConfigJson('models', JSON.stringify(nextRegistry));

    expect(result).toEqual({
      ok: true,
      message: 'models.json saved',
    });
    expect(refreshModelsSpy).toHaveBeenCalledTimes(1);
    expect(loadModelsConfig(root, {
      defaultContextWindow: config.defaultContextWindow,
    }).modelRegistry).toEqual(nextRegistry);
    expect(config.primaryModel).toBe('openai/gpt-4.1-mini');
    expect(config.primaryProvider).toBe('openai');
  });

  it('round-trips backup controls through backup.json owner-file saves', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const payload = {
      intervalHours: 24,
      maxRotatingBackups: 12,
      maxWeeklyBackups: 4,
      maxMonthlyBackups: 3,
      mirrorDir: '/mnt/ai/psfn-bak',
      verifyRestore: false,
    };

    const result = service.saveSubConfigJson('backup', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'backup.json saved',
    });
    expect(loadBackupConfig(root)).toEqual(payload);
    expect(JSON.parse(service.getSubConfigJson('backup') ?? '{}')).toEqual(payload);

    const settingsData = await service.getSettingsData();
    expect(settingsData.editors.backup).toEqual(payload);
  });

  it('returns raw channels owner-file json with credential refs intact', () => {
    const root = makeTempDir();
    const payload = {
      telegram: {
        enabled: false,
        tokenRef: {
          kind: 'env',
          envName: 'TELEGRAM_BOT_TOKEN',
        },
        allowedUsers: [],
        mode: 'polling',
        pollIntervalMs: 1_000,
        webhook: {
          url: 'https://example.test/telegram/webhook',
          secretRef: {
            kind: 'env',
            envName: 'TELEGRAM_WEBHOOK_SECRET',
          },
          host: '0.0.0.0',
          port: 8_080,
          path: '/telegram/webhook',
        },
      },
    };
    writeFileSync(join(root, 'channels.json'), JSON.stringify(payload));
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'resolved-secret');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'resolved-webhook-secret');

    const service = buildService(buildConfig(root));

    expect(JSON.parse(service.getSubConfigJson('channels') ?? '{}')).toEqual(payload);
  });

  it('round-trips channels.json owner-file saves through the Garden raw editor surface', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const payload = {
      discord: {
        heartbeatChannelId: 'heartbeat-123',
      },
      telegram: {
        enabled: false,
        tokenRef: {
          kind: 'env',
          envName: 'TELEGRAM_BOT_TOKEN',
        },
        allowedUsers: [],
        mode: 'polling',
        pollIntervalMs: 1_000,
        webhook: {
          url: 'https://example.test/telegram/webhook',
          secretRef: {
            kind: 'env',
            envName: 'TELEGRAM_WEBHOOK_SECRET',
          },
          host: '0.0.0.0',
          port: 8_080,
          path: '/telegram/webhook',
        },
      },
    };

    const result = service.saveSubConfigJson('channels', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'channels.json saved',
    });
    expect(JSON.parse(service.getSubConfigJson('channels') ?? '{}')).toEqual(payload);
    expect(await service.getSettingsData()).toEqual(expect.objectContaining({
      editors: expect.objectContaining({
        channels: payload,
      }),
    }));
  });

  it('round-trips charge-policy.json owner-file saves through the Garden raw editor surface', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const payload = {
      schemaVersion: 1,
      runChargeQuotaByLane: {
        interactive: 20,
        background: 8,
        maintenance: 0,
        subagent: 5,
        shard: 11,
      },
      surfaceCosts: {
        ownerFileInspection: 0,
        localFilesystem: 0,
        memoryRead: 0,
        memoryWrite: 0,
        localEmbedding: 0,
        externalEmbedding: 0,
        localImageGeneration: 0,
        paidImageGeneration: 5,
        thinkExtensionBand: 1,
        subagentLaunch: 1,
        shardLaunch: 7,
        externalModelConsult: 1,
        moaRoundBase: 1,
      },
      surfaceRationales: {
        paidImageGeneration: 'External image generation spends paid provider credits.',
        thinkExtensionBand: 'Extended think loops get a small cost to keep them bounded.',
        subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
        shardLaunch: 'Launching a shard consumes worker coordination overhead.',
        externalModelConsult: 'Consulting an external model uses a paid API boundary.',
        moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
      },
      moa: {
        perRoundMultiplierByReferenceModelClass: {
          local: 1,
          subscription: 1,
          cheap_cloud: 1,
          premium_cloud: 2,
        },
      },
      referenceModelClassPricing: {
        local: 0,
        subscription: 0,
        cheap_cloud: 1,
        premium_cloud: 4,
      },
      referenceModelClassPricingRationales: {
        cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
        premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
      },
    };

    const result = service.saveSubConfigJson('charge-policy', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'charge-policy.json saved',
    });
    expect(JSON.parse(service.getSubConfigJson('charge-policy') ?? '{}')).toEqual(payload);
    expect(loadChargePolicyConfig(root)).toEqual(payload);
    expect(config.chargePolicy).toEqual(payload);
    expect(await service.getSettingsData()).toEqual(expect.objectContaining({
      editors: expect.objectContaining({
        chargePolicy: payload,
      }),
    }));
  });

  it('round-trips providers through providers.json owner-file saves and refreshes runtime routing', async () => {
    const root = makeTempDir();
    const refreshModelsSpy = vi.fn();
    const config = buildConfig(root, {
      refreshModels: refreshModelsSpy,
    });
    const service = buildService(config);
    const payload = {
      schemaVersion: 1,
      providers: [
        {
          id: 'litellm',
          type: 'litellm_proxy',
          enabled: true,
          apiBaseUrl: 'http://127.0.0.1:4100/v1',
          apiKeyRef: {
            kind: 'env',
            envName: 'LITELLM_API_KEY',
          },
        },
        {
          id: 'openrouter',
          type: 'openrouter',
          enabled: true,
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          apiKeyRef: {
            kind: 'env',
            envName: 'OPENROUTER_API_KEY',
          },
        },
      ],
    };

    const result = service.saveSubConfigJson('providers', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'providers.json saved',
    });
    expect(refreshModelsSpy).toHaveBeenCalledTimes(1);
    expect(loadProvidersConfig(root).registry).toEqual(payload);
    expect(config.litellmBaseUrl).toBe('http://127.0.0.1:4100/v1');
    expect(JSON.parse(service.getSubConfigJson('providers') ?? '{}')).toEqual(payload);

    const settingsData = await service.getSettingsData();
    expect(settingsData.editors.providers).toEqual(expect.objectContaining({
      registry: payload,
      litellmBaseUrl: 'http://127.0.0.1:4100/v1',
    }));
  });
});
