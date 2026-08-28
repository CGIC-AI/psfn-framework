import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBackupConfig } from '../../../system/config/backup-config.js';
import { loadCapabilityTierConfig } from '../../../system/config/capability-tier-config.js';
import { loadChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import { loadModelsConfig } from '../../../system/config/models-config.js';
import { loadProvidersConfig } from '../../../system/config/providers-config.js';
import { loadSchedulerConfig } from '../../../system/config/scheduler-config.js';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import { loadCompanionSettingsOverlay } from '../../../system/config/settings-overlay.js';
import { createDefaultGroupMemorySettings } from '../../../system/config/group-memory-config.js';
import { createDefaultMemoryRetrievalPolicy } from '../../../system/config/memory-retrieval-policy.js';
import { loadSettings } from '../../../system/settings.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createDefaultEmoSimProactivitySettings } from '../../../system/config/runtime-config-contracts.js';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import {
  AdminSettingsDataService,
  type CapabilityTierChangeHandler,
} from './settings-service.js';
import type { GatewayCredentialPresenceResult } from '../../../boundary/gateway/protocol.js';
import type { GatewaySystemDataWriterPort } from '../../../boundary/gateway/system-data-writer.js';
import { INTAKE_POLICY_SCHEMA_VERSION } from '../../../system/config/intake-policy-config.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-settings-service-'));
  for (const ownerFile of [
    'settings.json',
    'models.json',
    'providers.json',
    'trust-policy.json',
    'intake-policy.json',
    'scheduler.json',
    'capability-tier.json',
    'charge-policy.json',
    'backup.json',
    'skills.json',
    'mcp-servers.json',
    'automata-policy.json',
  ]) {
    const seedFile = ownerFile.replace(/\.json$/u, '.seed.json');
    writeFileSync(
      join(tempDir, ownerFile),
      readFileSync(join(process.cwd(), 'config', seedFile), 'utf8'),
      'utf8',
    );
  }
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
    openRouterApiBaseUrl: providers.openRouterApiBaseUrl,
    openRouterModelsApiUrl: providers.openRouterModelsApiUrl,
    openRouterApiKeyRef: providers.openRouterApiKeyRef,
    runtimeHooks: hooks,
  };
}

function buildService(
  config: SubstrateConfig,
  getCredentialPresence?: () => Promise<GatewayCredentialPresenceResult>,
  onCapabilityTierChanged?: CapabilityTierChangeHandler,
  systemDataWriter?: GatewaySystemDataWriterPort,
): AdminSettingsDataService {
  return new AdminSettingsDataService({
    config,
    configStore: createOwnerFileConfigStore({
      dataDir: config.dataDir,
      defaultContextWindow: config.defaultContextWindow,
    }),
    effectiveSchedulerConfig: loadSchedulerConfig(config.dataDir),
    ...(getCredentialPresence ? { getCredentialPresence } : {}),
    ...(onCapabilityTierChanged ? { onCapabilityTierChanged } : {}),
    ...(systemDataWriter ? { systemDataWriter } : {}),
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
  it('projects an overlay-selected chat model without changing the fleet catalog primary', async () => {
    const root = makeTempDir();
    const modelsPath = join(root, 'models.json');
    const modelsOwner = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
      models: Array<Record<string, unknown>>;
    };
    const fleetPrimary = modelsOwner.models.find(entry => entry.id === 'primary');
    if (!fleetPrimary || typeof fleetPrimary.identity !== 'object' || fleetPrimary.identity === null) {
      throw new Error('Expected primary model fixture');
    }
    (fleetPrimary.identity as Record<string, unknown>).model = 'moonshotai/kimi-k3';
    modelsOwner.models.push({
      id: 'companion-chat',
      rank: 90,
      identity: {
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        source: { type: 'openrouter' },
      },
      purposes: [{ purpose: 'chat', primary: false }],
      capabilities: { maxOutputTokens: 16_384, contextWindow: 128_000 },
      tuning: { maxOutputTokens: 16_384 },
    });
    writeFileSync(modelsPath, JSON.stringify(modelsOwner), 'utf8');
    writeFileSync(
      join(root, 'settings.overlay.json'),
      JSON.stringify({ modelPurposeSelection: { chat: 'companion-chat' } }),
      'utf8',
    );

    const service = buildService(buildConfig(root));
    const settingsData = await service.getSettingsData();

    expect(settingsData.effectiveModelSelection.chat).toEqual({
      purpose: 'chat',
      source: 'companion_selection',
      slotKey: 'companion-chat',
      provider: 'openrouter',
      model: 'z-ai/glm-5.2',
    });
    expect(settingsData.effectiveModelSelection.fleetDefaultChat).toEqual({
      purpose: 'chat',
      source: 'fleet_default',
      slotKey: 'primary',
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
    });
    const canonicalPrimary = settingsData.editors.models.modelRegistry.models.find(entry => (
      entry.id === 'primary'
    ));
    expect(canonicalPrimary?.identity.model).toBe('moonshotai/kimi-k3');
  });

  it('round-trips the MCP owner file through the raw Garden surface', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));
    const payload = {
      schemaVersion: 1,
      limits: {
        connectTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        idleConnectionTtlMs: 300_000,
        metadataCacheTtlMs: 300_000,
        maxCatalogToolsPerServer: 256,
        maxPaginationPages: 32,
        maxStaticMetadataBytes: 1_048_576,
        maxDynamicOutputBytes: 4_194_304,
      },
      servers: [],
    };

    expect(await service.saveSubConfigJson('mcp', JSON.stringify(payload))).toEqual({
      ok: true,
      message: 'mcp-servers.json saved; restart required before MCP connections change',
    });
    expect(JSON.parse(service.getSubConfigJson('mcp') ?? '{}')).toEqual(payload);
  });

  it('round-trips the operator-owned automata policy through the raw Garden surface', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));
    const payload = JSON.parse(readFileSync(join(root, 'automata-policy.json'), 'utf8')) as object;

    expect(await service.saveSubConfigJson('automata-policy', JSON.stringify(payload))).toEqual({
      ok: true,
      message: 'automata-policy.json saved; restart required before automata policy changes take effect',
    });
    expect(JSON.parse(service.getSubConfigJson('automata-policy') ?? '{}')).toEqual(payload);
  });

  it('exposes skill_write through the typed and raw Garden intake-policy surfaces', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));

    expect(service.getIntakePolicyOverview()).toMatchObject({
      schemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      chatBodyHandling: {
        highestTrustPrivateDirect: {
          findingDisposition: 'mark_only',
          eligibleChannelClasses: ['api_direct', 'companion_ui'],
          trustResolutionMaxAgeMs: 5_000,
        },
      },
      urlScanner: {
        schemeActions: {
          javascript: 'deny',
          data: 'deny_except_inline_image',
          mailto: 'allow',
          tel: 'allow',
        },
      },
      sinkGates: {
        benignClasses: {
          beads_database_create: [{
            ruleId: 'persona_mutation_request',
            riskLabels: ['persona/mutation_attempt'],
          }],
          beads_database_show: [{
            ruleId: 'persona_mutation_request',
            riskLabels: ['persona/mutation_attempt'],
          }],
        },
        sinks: {
          skill_write: {
            maxSourceRiskTier: 'untrusted',
            unscreened: 'deny',
          },
        },
      },
    });

    const raw = service.getSubConfigJson('intake-policy');
    expect(raw).not.toBeNull();
    const owner = JSON.parse(raw!) as {
      chatBodyHandling: {
        highestTrustPrivateDirect: { eligibleChannelClasses: string[] };
      };
      sinkGates: { sinks: Record<string, unknown> };
    };
    const unsupportedDiscordEligibility = structuredClone(owner);
    unsupportedDiscordEligibility.chatBodyHandling
      .highestTrustPrivateDirect.eligibleChannelClasses = ['discord'];
    expect(await service.saveSubConfigJson(
      'intake-policy',
      JSON.stringify(unsupportedDiscordEligibility),
    )).toMatchObject({
      ok: false,
      message: expect.stringMatching(/unsupported.*discord/i),
    });
    const missingSkillWrite = structuredClone(owner);
    delete missingSkillWrite.sinkGates.sinks.skill_write;
    expect(await service.saveSubConfigJson(
      'intake-policy',
      JSON.stringify(missingSkillWrite),
    )).toMatchObject({
      ok: false,
      message: expect.stringMatching(/sinkGates\.sinks\.skill_write is required/),
    });
  });

  it('exposes fleet personal/shared workspace posture without an env escape hatch', async () => {
    const root = makeTempDir();
    const service = buildService({
      ...buildConfig(root),
      multiCompanion: true,
      workspacePath: join(root, 'workspaces/personal/companion-a'),
      sharedWorkspacePath: join(root, 'workspaces/shared'),
    });

    expect((await service.getSettingsData()).workspaceLayout).toEqual({
      mode: 'fleet',
      personalWorkspacePath: join(root, 'workspaces/personal/companion-a'),
      sharedWorkspacePath: join(root, 'workspaces/shared'),
      companionSharedAccess: 'read_only',
      executableAutoLoad: false,
      promptAutoLoad: false,
    });
  });

  it('exposes fleet-auth as an honest read-only off state and rejects raw edits', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));

    expect((await service.getSettingsData()).fleetAuth).toMatchObject({
      ownerFile: 'fleet-auth.json',
      access: { mode: 'read_only', editableFields: [] },
      featureState: 'off',
      status: 'off',
      effective: { state: 'off' },
      onDisk: { state: 'absent' },
      restartRequired: false,
    });
    expect(service.getSubConfigJson('fleet-auth')).toBeNull();
    expect(await service.saveSubConfigJson('fleet-auth', '{}')).toEqual({
      ok: false,
      message: 'fleet-auth.json is read-only in Garden; edit the canonical system owner file outside Garden',
    });
  });

  it('returns a structured malformed-owner error for the raw sub-config viewer', () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));
    writeFileSync(join(root, 'settings.json'), '{"invalid"');

    const raw = service.getSubConfigJson('settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      error: 'Unable to load settings config; owner file is missing or malformed',
      key: 'settings',
    });
  });

  it('round-trips the visible runtime-owned Garden controls through the canonical settings payload', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const groupMemory = {
      ...createDefaultGroupMemorySettings(),
      memoryMode: 'group' as const,
      onlineExtraction: {
        ...createDefaultGroupMemorySettings().onlineExtraction,
        observedMessageTriggerCount: 40,
        maxMessagesPerChunk: 60,
      },
      writeCaps: {
        ...createDefaultGroupMemorySettings().writeCaps,
        maxWritesPerRun: 6,
      },
    };
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
      memoryRetrievalPolicy: createDefaultMemoryRetrievalPolicy(),
      groupMemory,
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
      analysisWorkbenchMaxTokens: 76_000,
      analysisWorkbenchMaxWallTimeMs: 300_000,
      analysisWorkbenchMaxSubQueries: 24,
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
      promotedExtendedTools: ['obsidian_append_note', 'analysis_workbench'],
      chatApiBaseUrl: 'http://127.0.0.1:3000/api',
      imageProvider: 'fal',
      imageFalCreateModel: 'fal-ai/nano-banana-2',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
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
        allowedPurposes: ['analysis_workbench'],
      },
    } satisfies Record<string, unknown>;

    const result = await service.updateSettings(JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
      status: {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      },
    });

    const settingsData = await service.getSettingsData();
    expect(settingsData.config).toEqual(expect.objectContaining(payload));

    const persistedSettings = loadSettings(root);
    const {
      imageProvider,
      imageFalCreateModel,
      imageFalEditModel,
      imageSelfieEditModel,
      moaReferenceModels,
      moaAggregatorModel,
      ...globalPayload
    } = payload;
    expect(persistedSettings).toEqual(expect.objectContaining(globalPayload));
    expect(persistedSettings.imageProvider).toBeUndefined();
    expect(persistedSettings.imageFalCreateModel).toBeUndefined();
    expect(persistedSettings.imageFalEditModel).toBeUndefined();
    expect(persistedSettings.imageSelfieEditModel).toBeUndefined();
    expect(loadCompanionSettingsOverlay(root)).toEqual(expect.objectContaining({
      imageProvider,
      imageFalCreateModel,
      imageFalEditModel,
      imageSelfieEditModel,
      moaReferenceModels,
      moaAggregatorModel,
    }));
  });

  it('rejects unsupported image provider and model settings without persisting them', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));

    const result = await service.updateSettings(JSON.stringify({
      imageProvider: 'unknown-provider',
      imageFalCreateModel: 'not-in-the-catalog',
      imageFalEditModel: 'also-not-in-the-catalog',
      imageSelfieEditModel: 'still-not-in-the-catalog',
    }));

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'imageProvider', code: 'invalid_enum' }),
      expect.objectContaining({ field: 'imageFalCreateModel', code: 'invalid_enum' }),
      expect.objectContaining({ field: 'imageFalEditModel', code: 'invalid_enum' }),
      expect.objectContaining({ field: 'imageSelfieEditModel', code: 'invalid_enum' }),
    ]));
    const persisted = loadSettings(root);
    expect(persisted.imageProvider).toBeUndefined();
    expect(persisted.imageFalCreateModel).toBeUndefined();
    expect(persisted.imageFalEditModel).toBeUndefined();
    expect(persisted.imageSelfieEditModel).toBeUndefined();
  });

  it('persists model purpose selections that resolve against the live models.json registry (23pp)', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));

    const result = await service.updateSettings(JSON.stringify({
      modelPurposeSelection: { chat: 'extraction', vision: 'primary' },
    }));

    expect(result.ok).toBe(true);
    const persisted = loadSettings(root);
    expect(persisted.modelPurposeSelection).toBeUndefined();
    expect(loadCompanionSettingsOverlay(root)?.modelPurposeSelection).toEqual({
      chat: 'extraction',
      vision: 'primary',
    });
  });

  it('rejects model purpose selections referencing unknown registry slots without persisting them (23pp)', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));

    const result = await service.updateSettings(JSON.stringify({
      modelPurposeSelection: { chat: 'not-a-registry-slot' },
    }));

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'modelPurposeSelection',
        code: 'invalid_object',
        message: expect.stringContaining('not-a-registry-slot'),
      }),
    ]));
    expect(loadSettings(root).modelPurposeSelection).toBeUndefined();
  });

  it('rejects model purpose selections with unknown purpose keys (23pp)', async () => {
    const root = makeTempDir();
    const service = buildService(buildConfig(root));

    const result = await service.updateSettings(JSON.stringify({
      modelPurposeSelection: { bigBrain: 'primary' },
    }));

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'modelPurposeSelection',
        code: 'invalid_object',
        message: expect.stringContaining('unknown model purpose'),
      }),
    ]));
  });

  it('writes per-companion image selections to the selected overlay without mutating the fleet-global owner', async () => {
    const root = makeTempDir();
    const companionA = join(root, 'companions', 'a');
    const companionB = join(root, 'companions', 'b');
    mkdirSync(companionA, { recursive: true });
    mkdirSync(companionB, { recursive: true });
    const config = {
      ...buildConfig(root),
      companionDataDir: companionA,
    } satisfies SubstrateConfig;
    const service = new AdminSettingsDataService({
      config,
      configStore: createOwnerFileConfigStore({
        dataDir: root,
        companionDataDir: companionA,
        defaultContextWindow: config.defaultContextWindow,
      }),
    });
    const globalSettingsBefore = readFileSync(join(root, 'settings.json'), 'utf8');

    expect((await service.updateSettings(JSON.stringify({
      imageProvider: 'comfyui',
      imageFalCreateModel: 'xai/grok-imagine-image',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
    }))).ok).toBe(true);

    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(globalSettingsBefore);
    expect(loadSettings(root)).not.toEqual(expect.objectContaining({
      imageProvider: expect.anything(),
      imageFalCreateModel: expect.anything(),
      imageFalEditModel: expect.anything(),
      imageSelfieEditModel: expect.anything(),
    }));
    expect(loadCompanionSettingsOverlay(companionA)).toEqual({
      imageProvider: 'comfyui',
      imageFalCreateModel: 'xai/grok-imagine-image',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
    });
    expect(loadCompanionSettingsOverlay(companionB)).toBeUndefined();
    expect(config).toMatchObject({
      imageProvider: 'comfyui',
      imageFalCreateModel: 'xai/grok-imagine-image',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
    });
  });

  it('deep-merges and clears companion model selections without mutating siblings or global settings', async () => {
    const root = makeTempDir();
    const companionA = join(root, 'companions', 'a');
    const companionB = join(root, 'companions', 'b');
    mkdirSync(companionA, { recursive: true });
    mkdirSync(companionB, { recursive: true });
    writeFileSync(
      join(companionA, 'settings.overlay.json'),
      JSON.stringify({
        modelPurposeSelection: {
          chat: 'primary',
          vision: 'primary',
        },
        moaReferenceModels: ['openrouter:old/reference'],
        moaAggregatorModel: 'openrouter:old/aggregator',
      }),
      'utf8',
    );
    const config = {
      ...buildConfig(root),
      companionDataDir: companionA,
    } satisfies SubstrateConfig;
    const service = new AdminSettingsDataService({
      config,
      configStore: createOwnerFileConfigStore({
        dataDir: root,
        companionDataDir: companionA,
        defaultContextWindow: config.defaultContextWindow,
      }),
    });
    const globalSettingsBefore = readFileSync(join(root, 'settings.json'), 'utf8');

    expect((await service.updateSettings(JSON.stringify({
      modelPurposeSelection: { chat: 'extraction' },
      moaReferenceModels: ['openrouter:new/reference'],
      moaAggregatorModel: 'openrouter:new/aggregator',
    }))).ok).toBe(true);

    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(globalSettingsBefore);
    expect(loadCompanionSettingsOverlay(companionA)).toEqual({
      modelPurposeSelection: {
        chat: 'extraction',
        vision: 'primary',
      },
      moaReferenceModels: ['openrouter:new/reference'],
      moaAggregatorModel: 'openrouter:new/aggregator',
    });
    expect(loadCompanionSettingsOverlay(companionB)).toBeUndefined();

    expect((await service.updateSettings(JSON.stringify({
      modelPurposeSelection: null,
      moaReferenceModels: [],
      moaAggregatorModel: null,
    }))).ok).toBe(true);

    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(globalSettingsBefore);
    expect(loadCompanionSettingsOverlay(companionA)).toEqual({
      modelPurposeSelection: null,
      moaReferenceModels: [],
      moaAggregatorModel: null,
    });
    expect(loadCompanionSettingsOverlay(companionB)).toBeUndefined();
    expect(config.modelPurposeSelection).toBeUndefined();
    expect(config.moaReferenceModels).toBeUndefined();
    expect(config.moaAggregatorModel).toBeUndefined();
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

  it('renders gateway-redacted credential presence without reading provider secrets locally', async () => {
    const root = makeTempDir();
    vi.stubEnv('DISCORD_TOKEN', 'must-not-be-read');
    const service = buildService(buildConfig(root), async () => ({
      discordToken: false,
      apiKey: true,
      adminToken: true,
      openrouterApiKey: true,
      importProcessingLocalApiKey: true,
      falApiKey: true,
      telegramBotToken: true,
    }));

    const env = (await service.getSettingsData()).env;

    expect(env.discordToken).toBe('[not set]');
    expect(env.apiKey).toBe('[set]');
    expect(env.adminToken).toBe('[set]');
    expect(env.openrouterApiKey).toBe('[set]');
    expect(env.importProcessingLocalApiKey).toBe('[set]');
    expect(env.falApiKey).toBe('[set]');
    expect(env.telegramBotToken).toBe('[set]');
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
      analysisWorkbenchMaxTokens: 70000,
      analysisWorkbenchMaxWallTimeMs: 125000,
      analysisWorkbenchMaxSubQueries: 9,
      openRouterProviderOrder: ['parasail', 'openai'],
      uiThemeId: 'generic-dark',
    };

    const result = await service.updateSettings(JSON.stringify(runtimeModelControls));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
      status: {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      },
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

  it('returns field-level errors for malformed and out-of-range model-control payloads and fails closed', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);

    const modelsBefore = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    const settingsBefore = loadSettings(root);
    const result = await service.updateSettings(JSON.stringify({
      analysisWorkbenchMaxTokens: 999,
      analysisWorkbenchMaxWallTimeMs: 1000,
      analysisWorkbenchMaxSubQueries: 0,
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
        field: 'analysisWorkbenchMaxTokens',
        message: 'analysisWorkbenchMaxTokens must be 1000-1000000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'analysisWorkbenchMaxWallTimeMs',
        message: 'analysisWorkbenchMaxWallTimeMs must be 5000-600000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'analysisWorkbenchMaxSubQueries',
        message: 'analysisWorkbenchMaxSubQueries must be 1-100',
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
    expect(settingsAfter.analysisWorkbenchMaxTokens).toBe(settingsBefore.analysisWorkbenchMaxTokens);
    expect(settingsAfter.analysisWorkbenchMaxWallTimeMs).toBe(settingsBefore.analysisWorkbenchMaxWallTimeMs);
    expect(settingsAfter.analysisWorkbenchMaxSubQueries).toBe(settingsBefore.analysisWorkbenchMaxSubQueries);
  });

  it('rejects a partial memory retrieval policy without persisting or applying it', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const settingsBefore = loadSettings(root);

    const result = await service.updateSettings(JSON.stringify({
      memoryRetrievalPolicy: {
        nonTemporalRecencyFloor: 0.4,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'memoryRetrievalPolicy',
        code: 'invalid_object',
      }),
    ]));
    expect(loadSettings(root)).toEqual(settingsBefore);
    expect(config.memoryRetrievalPolicy).toBeUndefined();
  });

  it('applies live context controls through the canonical admin settings mutation path', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);

    const result = await service.updateSettings(JSON.stringify({
      extractionThresholdPct: 34,
      compactionThresholdPct: 76,
    }));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
      status: {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      },
    });
    expect(config.extractionThresholdPct).toBe(34);
    expect(config.compactionThresholdPct).toBe(76);

    const persistedSettings = loadSettings(root);
    expect(persistedSettings.extractionThresholdPct).toBe(34);
    expect(persistedSettings.compactionThresholdPct).toBe(76);
  });

  it('persists an EmoSim profile only in the selected companion overlay', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const baselineGlobal = loadSettings(root).emosimProactivity;
    const profile = createDefaultEmoSimProactivitySettings().thresholdProfile;

    const result = await service.updateSettings(JSON.stringify({
      emosimProactivity: {
        mode: 'shadow',
        thresholdProfile: {
          ...profile,
          profileId: 'companion-profile-v2',
          revision: 'companion-profile-v2.1',
          reviewNote: 'Sanitized operator-reviewed companion calibration.',
        },
      },
    }));

    expect(result.ok).toBe(true);
    expect(loadSettings(root).emosimProactivity).toEqual(baselineGlobal);
    expect(loadCompanionSettingsOverlay(root)?.emosimProactivity).toMatchObject({
      mode: 'shadow',
      thresholdProfile: { profileId: 'companion-profile-v2' },
    });
    expect(config.emosimProactivity).toMatchObject({
      mode: 'shadow',
      thresholdProfile: { profileId: 'companion-profile-v2' },
    });
  });

  it('rejects removed runtime settings instead of silently persisting dead knobs', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const settingsBefore = loadSettings(root);

    const result = await service.updateSettings(JSON.stringify({
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
      backgroundMaintenance: {
        ...loadSchedulerConfig(root).backgroundMaintenance,
        intervalMs: 180_000,
      },
    };
    const capabilitiesPayload = {
      capabilityTier: 'custom',
      customTokens: ['identity.read', 'memory.write', 'git.read'],
    };

    const schedulerResult = await service.saveSubConfigJson('scheduler', JSON.stringify(schedulerPayload));
    const capabilitiesResult = await service.saveSubConfigJson('capabilities', JSON.stringify({
      tier: capabilitiesPayload.capabilityTier,
      customTokens: capabilitiesPayload.customTokens,
    }));

    expect(schedulerResult).toEqual({
      ok: true,
      message:
        'scheduler.json saved; restart required before scheduler changes take effect; '
        + 'live background-maintenance cadence remains '
        + '3,600,000 ms until restart (on disk: 180,000 ms)',
    });
    expect(capabilitiesResult).toEqual({
      ok: true,
      message: 'capability-tier.json saved',
      status: {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      },
    });
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(1);

    const schedulerConfig = loadSchedulerConfig(root);
    expect(schedulerConfig.backgroundMaintenance.intervalMs).toBe(180_000);
    expect(config.maintenanceIntervalMs).toBe(300_000);

    const capabilityConfig = loadCapabilityTierConfig(root);
    expect(capabilityConfig.tier).toBe('custom');
    expect(capabilityConfig.customTokens).toEqual(capabilitiesPayload.customTokens);

    const settingsData = await service.getSettingsData();
    expect(settingsData.editors.scheduler.backgroundMaintenance.intervalMs).toBe(180_000);
    expect(settingsData.editors.scheduler.backgroundMaintenance.sharedWorldWikiCaretaker)
      .toEqual({ batchSize: 25 });
    expect(settingsData.effectiveBackgroundMaintenance).toEqual({
      ownerFile: 'scheduler.json',
      effectiveIntervalMs: 3_600_000,
      onDiskIntervalMs: 180_000,
      restartRequired: true,
    });
    expect(settingsData.editors.capabilities).toEqual(expect.objectContaining({
      tier: 'custom',
      customTokens: capabilitiesPayload.customTokens,
    }));
  });

  it('reports the exact effective grant delta after a capability-tier mutation', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const onCapabilityTierChanged = vi.fn<CapabilityTierChangeHandler>();
    const service = buildService(config, undefined, onCapabilityTierChanged);

    const result = await service.saveSubConfigJson('capabilities', JSON.stringify({
      tier: 'custom',
      customTokens: ['identity.read', 'memory.delete'],
    }));

    expect(result.ok).toBe(true);
    expect(onCapabilityTierChanged).toHaveBeenCalledWith({
      previous: {
        tier: 'nursery',
        grantedTokens: [
          'identity.read',
          'identity.write.runtime',
          'memory.write',
          'automata.bus.read',
          'automata.bus.write',
          'git.read',
          'issue.read',
          'repl.execute',
        ],
      },
      current: {
        tier: 'custom',
        grantedTokens: ['identity.read', 'memory.delete'],
      },
      granted: ['memory.delete'],
      withdrawn: [
        'identity.write.runtime',
        'memory.write',
        'automata.bus.read',
        'automata.bus.write',
        'git.read',
        'issue.read',
        'repl.execute',
      ],
    });
  });

  it('retains both live-refresh and companion-notice divergence details', async () => {
    const root = makeTempDir();
    const config = buildConfig(root, {
      refreshCapabilities: () => {
        throw new Error('live capability refresh failed');
      },
    });
    const service = buildService(config, undefined, () => {
      throw new Error('companion notice failed');
    });

    const result = await service.saveSubConfigJson('capabilities', JSON.stringify({
      tier: 'apprentice',
      customTokens: [],
    }));

    expect(result).toMatchObject({
      ok: true,
      status: {
        status: 'degraded',
        divergences: [{ key: 'capabilities', state: 'diverged' }],
      },
    });
    if (!result.ok || !result.status) {
      throw new Error('expected a degraded successful save result');
    }
    expect(result.status.divergences).toHaveLength(1);
    expect(result.status.detail).toContain('live capability refresh failed');
    expect(result.status.detail).toContain('companion notice delivery failed');
    expect(result.status.detail).toContain('companion notice failed');
  });

  it('governs durable background-work tuning through scheduler.json and rejects malformed edits', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const current = loadSchedulerConfig(root);
    const edited = {
      ...current,
      backgroundWork: {
        ...current.backgroundWork,
        supervisor: {
          ...current.backgroundWork.supervisor,
          maxConcurrentSessions: 6,
        },
        postTurn: {
          ...current.backgroundWork.postTurn,
          extractionDrainRequeueDelayMs: 1_500,
        },
      },
    };

    expect(await service.saveSubConfigJson('scheduler', JSON.stringify(edited))).toMatchObject({
      ok: true,
    });
    expect(loadSchedulerConfig(root).backgroundWork).toEqual(edited.backgroundWork);
    expect((await service.getSettingsData()).editors.scheduler.backgroundWork)
      .toEqual(edited.backgroundWork);

    const malformed = {
      ...edited,
      backgroundWork: {
        ...edited.backgroundWork,
        supervisor: {
          ...edited.backgroundWork.supervisor,
          retryBaseDelayMs: 5_000,
          retryMaxDelayMs: 1_000,
        },
      },
    };
    expect(await service.saveSubConfigJson('scheduler', JSON.stringify(malformed))).toEqual({
      ok: false,
      message:
        'Invalid scheduler config: backgroundWork.supervisor.retryMaxDelayMs '
        + 'must be greater than or equal to backgroundWork.supervisor.retryBaseDelayMs',
    });
    expect(loadSchedulerConfig(root).backgroundWork).toEqual(edited.backgroundWork);
  });

  it('reports the live 1h cadence, a saved 10m cadence, and restart alignment end to end', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);
    const editedScheduler = {
      ...loadSchedulerConfig(root),
      backgroundMaintenance: {
        ...loadSchedulerConfig(root).backgroundMaintenance,
        intervalMs: 600_000,
      },
    };

    expect(await service.saveSubConfigJson('scheduler', JSON.stringify(editedScheduler))).toEqual({
      ok: true,
      message:
        'scheduler.json saved; restart required before scheduler changes take effect; '
        + 'live background-maintenance cadence remains '
        + '3,600,000 ms until restart (on disk: 600,000 ms)',
    });
    expect((await service.getSettingsData()).effectiveBackgroundMaintenance).toEqual({
      ownerFile: 'scheduler.json',
      effectiveIntervalMs: 3_600_000,
      onDiskIntervalMs: 600_000,
      restartRequired: true,
    });

    const restartedService = buildService(config);
    expect((await restartedService.getSettingsData()).effectiveBackgroundMaintenance).toEqual({
      ownerFile: 'scheduler.json',
      effectiveIntervalMs: 600_000,
      onDiskIntervalMs: 600_000,
      restartRequired: false,
    });
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

    const result = await service.saveSubConfigJson('models', JSON.stringify(nextRegistry));

    expect(result).toEqual({
      ok: true,
      message: 'models.json saved',
      status: {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      },
    });
    expect(refreshModelsSpy).toHaveBeenCalledTimes(1);
    expect(loadModelsConfig(root, {
      defaultContextWindow: config.defaultContextWindow,
    }).modelRegistry).toEqual(nextRegistry);
    expect(config.primaryModel).toBe('openai/gpt-4.1-mini');
    expect(config.primaryProvider).toBe('openai');
  });

  it('returns degraded success and exposes model divergence when live model refresh fails', async () => {
    const root = makeTempDir();
    const config = buildConfig(root, {
      refreshModels: () => {
        throw new Error('model cache rebuild exploded');
      },
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

    const result = await service.saveSubConfigJson('models', JSON.stringify(nextRegistry));

    expect(result.ok).toBe(true);
    expect(result.message).toContain('models.json saved with divergence');
    expect(result.status).toEqual(expect.objectContaining({
      status: 'degraded',
      divergences: [
        expect.objectContaining({
          key: 'models',
          state: 'diverged',
        }),
      ],
    }));

    const settingsData = await service.getSettingsData();
    expect(settingsData.status).toEqual(expect.objectContaining({
      status: 'degraded',
      divergences: [
        expect.objectContaining({
          key: 'models',
          detail: expect.stringContaining('model cache rebuild exploded'),
        }),
      ],
    }));
  });

  it('returns degraded success and exposes capability divergence when live capability refresh fails', async () => {
    const root = makeTempDir();
    const config = buildConfig(root, {
      refreshCapabilities: () => {
        throw new Error('capability runtime reload exploded');
      },
    });
    const service = buildService(config);

    const result = await service.saveSubConfigJson('capabilities', JSON.stringify({
      tier: 'custom',
      customTokens: ['identity.read'],
    }));

    expect(result.ok).toBe(true);
    expect(result.message).toContain('capability-tier.json saved with divergence');
    expect(result.status).toEqual(expect.objectContaining({
      status: 'degraded',
      divergences: [
        expect.objectContaining({
          key: 'capabilities',
          state: 'diverged',
        }),
      ],
    }));

    const settingsData = await service.getSettingsData();
    expect(settingsData.status).toEqual(expect.objectContaining({
      status: 'degraded',
      divergences: [
        expect.objectContaining({
          key: 'capabilities',
          detail: expect.stringContaining('capability runtime reload exploded'),
        }),
      ],
    }));
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
      mirrorDir: '/srv/backup-mirror',
      verifyRestore: false,
      groupMode: false,
      encryption: {
        mode: 'required',
        keyRef: {
          kind: 'env',
          envName: 'PSFN_BACKUP_ENCRYPTION_KEY',
        },
      },
    };

    const result = await service.saveSubConfigJson('backup', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'backup.json saved',
    });
    expect(loadBackupConfig(root)).toEqual(payload);
    expect(JSON.parse(service.getSubConfigJson('backup') ?? '{}')).toEqual(payload);

    const settingsData = await service.getSettingsData();
    expect(settingsData.editors.backup).toEqual(payload);
  });

  it('proxies a backup owner write when the agent filesystem is read-only', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const writableStore = createOwnerFileConfigStore({
      dataDir: root,
      defaultContextWindow: config.defaultContextWindow,
    });
    const saveBackup = vi.fn(() => {
      const error = new Error(
        `EROFS: read-only file system, open '${join(root, 'backup.json.tmp')}'`,
      ) as NodeJS.ErrnoException;
      error.code = 'EROFS';
      throw error;
    });
    const readOnlyStore = { ...writableStore, saveBackup };
    const writeSystemData = vi.fn(async (request) => {
      if (request.kind !== 'owner_file' || request.ownerFile !== 'backup') {
        throw new Error('unexpected system-data write');
      }
      writableStore.saveBackup(request.payload);
      return { ok: true as const };
    });
    const service = new AdminSettingsDataService({
      config,
      configStore: readOnlyStore,
      effectiveSchedulerConfig: loadSchedulerConfig(config.dataDir),
      systemDataWriter: { writeSystemData },
    });
    const payload = {
      ...loadBackupConfig(root),
      maxRotatingBackups: 17,
    };

    await expect(service.saveSubConfigJson('backup', JSON.stringify(payload))).resolves.toEqual({
      ok: true,
      message: 'backup.json saved',
    });
    expect(writeSystemData).toHaveBeenCalledWith({
      kind: 'owner_file',
      ownerFile: 'backup',
      payload,
    });
    expect(saveBackup).not.toHaveBeenCalled();
    expect(loadBackupConfig(root).maxRotatingBackups).toBe(17);
  });

  it('replaces raw EROFS details with an actionable system-write error', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const configStore = createOwnerFileConfigStore({
      dataDir: root,
      defaultContextWindow: config.defaultContextWindow,
    });
    const service = new AdminSettingsDataService({
      config,
      configStore: {
        ...configStore,
        saveBackup: () => {
          const error = new Error('EROFS: read-only file system') as NodeJS.ErrnoException;
          error.code = 'EROFS';
          throw error;
        },
      },
      effectiveSchedulerConfig: loadSchedulerConfig(config.dataDir),
    });

    const result = await service.saveSubConfigJson(
      'backup',
      JSON.stringify(loadBackupConfig(root)),
    );

    expect(result).toEqual({
      ok: false,
      message:
        'This deployment does not permit direct system-scope owner-file writes. '
        + 'The authenticated gateway system-data writer is unavailable.',
    });
    expect(result.message).not.toContain('EROFS');
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

    const result = await service.saveSubConfigJson('channels', JSON.stringify(payload));

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
        companion_social: 12,
        background: 8,
        maintenance: 0,
        subagent: 5,
        shard: 11,
      },
      surfaceCosts: {
        localImageGeneration: 0,
        paidImageGeneration: 5,
        analysisWorkbenchExtensionBand: 4,
        subagentLaunch: 1,
        shardLaunch: 7,
        externalModelConsult: 1,
        moaRoundBase: 1,
        companionSocialContinuation: 1,
      },
      surfaceRationales: {
        paidImageGeneration: 'External image generation spends paid provider credits.',
        analysisWorkbenchExtensionBand: 'Extended analysis workbench loops reserve scarce deep-analysis budget after the first pass.',
        subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
        shardLaunch: 'Launching a shard consumes worker coordination overhead.',
        externalModelConsult: 'Consulting an external model uses a paid API boundary.',
        moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
        companionSocialContinuation: 'Autonomous companion continuation spends relationship-sensitive social budget.',
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
      icpCostBreaker: { enabled: false as const },
      fatigue: makeTestFatiguePolicyConfig(),
    };

    const result = await service.saveSubConfigJson('charge-policy', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'charge-policy.json saved',
    });
    expect(JSON.parse(service.getSubConfigJson('charge-policy') ?? '{}')).toEqual(payload);
    expect(loadChargePolicyConfig(root)).toEqual(payload);
    expect(config.chargePolicy).not.toEqual(payload);
    expect(await service.getSettingsData()).toEqual(expect.objectContaining({
      editors: expect.objectContaining({
        chargePolicy: payload,
      }),
    }));
  });

  it('surfaces effective vs on-disk charge quotas with a restart-required indicator (psfn-framework-9bgk)', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = buildService(config);

    const seed = loadChargePolicyConfig(root);

    // Operator edits the owner file on disk to raise the interactive quota.
    const editedOnDisk = {
      ...seed,
      runChargeQuotaByLane: { ...seed.runChargeQuotaByLane, interactive: 100 },
    };
    const saveResult = await service.saveSubConfigJson('charge-policy', JSON.stringify(editedOnDisk));
    expect(saveResult.ok).toBe(true);

    // The running process still carries the stale quota it loaded at startup.
    const staleQuotaByLane = { ...seed.runChargeQuotaByLane, interactive: 24 };
    config.chargePolicy = { ...seed, runChargeQuotaByLane: staleQuotaByLane };

    const diverged = await service.getSettingsData();
    expect(diverged.effectiveChargeQuota).toEqual({
      effectiveChargeQuotaByLane: staleQuotaByLane,
      onDiskChargeQuotaByLane: editedOnDisk.runChargeQuotaByLane,
      restartRequired: true,
    });

    // Once the runtime is restarted (effective == on-disk), no restart is required.
    config.chargePolicy = { ...seed, runChargeQuotaByLane: editedOnDisk.runChargeQuotaByLane };
    const aligned = await service.getSettingsData();
    expect(aligned.effectiveChargeQuota.restartRequired).toBe(false);

    // With no loaded charge policy the effective lanes are null and no restart is flagged.
    delete config.chargePolicy;
    const unloaded = await service.getSettingsData();
    expect(unloaded.effectiveChargeQuota).toEqual({
      effectiveChargeQuotaByLane: null,
      onDiskChargeQuotaByLane: editedOnDisk.runChargeQuotaByLane,
      restartRequired: false,
    });
  });

  it('reports canonical effective, on-disk, and restart state for ICP owner settings', async () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const effectiveSchedulerConfig = loadSchedulerConfig(root);
    config.chargePolicy = loadChargePolicyConfig(root);
    const service = new AdminSettingsDataService({
      config,
      configStore: createOwnerFileConfigStore({
        dataDir: config.dataDir,
        defaultContextWindow: config.defaultContextWindow,
      }),
      effectiveSchedulerConfig,
    });
    // The seed default is enabled:true (operator ruling D4, hrmrq.34), so the
    // divergence under test is an operator turning the owner flag OFF.
    const editedScheduler = {
      ...effectiveSchedulerConfig,
      icpAutonomy: {
        ...effectiveSchedulerConfig.icpAutonomy,
        enabled: false,
      },
    };

    expect(await service.saveSubConfigJson('scheduler', JSON.stringify(editedScheduler))).toEqual({
      ok: true,
      message:
        'scheduler.json saved; restart required before scheduler changes take effect; '
        + 'background-maintenance cadence remains aligned at 3,600,000 ms',
    });
    const data = await service.getSettingsData();

    expect(data.effectiveIcpAutonomy.scheduler).toMatchObject({
      ownerFile: 'scheduler.json',
      effectiveValue: { enabled: true },
      onDiskValue: { enabled: false },
      restartRequired: true,
    });
    expect(data.effectiveIcpAutonomy.chargePolicy).toMatchObject({
      ownerFile: 'charge-policy.json',
      restartRequired: false,
      effectiveValue: {
        companionSocialQuota: 12,
        companionSocialContinuationCost: 1,
      },
    });
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
          id: 'shared-router',
          type: 'generic_openai',
          enabled: true,
          apiBaseUrl: 'http://127.0.0.1:4100/v1',
          apiKeyRef: {
            kind: 'env',
            envName: 'SHARED_ROUTER_API_KEY',
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

    const result = await service.saveSubConfigJson('providers', JSON.stringify(payload));

    expect(result).toEqual({
      ok: true,
      message: 'providers.json saved',
      status: {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      },
    });
    expect(refreshModelsSpy).toHaveBeenCalledTimes(1);
    expect(loadProvidersConfig(root).registry).toEqual(payload);
    expect(JSON.parse(service.getSubConfigJson('providers') ?? '{}')).toEqual(payload);

    const settingsData = await service.getSettingsData();
    expect(settingsData.editors.providers).toEqual(expect.objectContaining({
      registry: payload,
    }));
  });
});
