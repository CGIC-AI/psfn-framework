import {
  DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  DEFAULT_UI_THEME_ID,
  type SubstrateConfig,
} from '../config/runtime-config-contracts.js';
import {
  cloneImageWorkflowSettings,
  normalizeImageWorkflowSettings,
} from '../../primitives/images/types.js';
import {
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudgetPct,
} from '../../shared/context-budget.js';
import {
  createDefaultCompositionalPolicyConfig,
  cloneCompositionalPolicyConfig,
} from '../capabilities/compositional-policy.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import {
  normalizeSttProvider,
  normalizeTtsProvider,
  resolveRuntimeSttProvider,
  resolveRuntimeTtsProvider,
  toNonEmptyString,
} from './coercion.js';
import {
  hasLegacyModelSettingsPayload,
  hasModelSettings,
  normalizeEditableSettings,
  toPromotedToolList,
} from './schema.js';
import {
  RUNTIME_SETTINGS_KEYS,
  type EditableSettings,
  type RuntimeSettingKey,
  type RuntimeSettingsSnapshot,
} from './contracts.js';

function mergeModelSettingsWithConfig(
  config: SubstrateConfig,
  settings: EditableSettings,
): EditableSettings {
  return {
    ...(settings.modelRegistry !== undefined
      ? { modelRegistry: settings.modelRegistry }
      : {}),
    ...(settings.modelRegistry === undefined &&
    config.modelRegistry !== undefined
      ? { modelRegistry: config.modelRegistry }
      : {}),
  };
}

type SnapshotSection<K extends RuntimeSettingKey> = Pick<
  RuntimeSettingsSnapshot,
  K
>;
type SharedConfigSettingKey = Extract<
  keyof EditableSettings & keyof SubstrateConfig,
  string
>;

const DIRECT_DEFINED_CONFIG_SETTINGS = [
  'sessionHistoryBudgetPct',
  'memoryRetrievalBudgetPct',
  'moodCongruenceWeight',
  'adaptiveContextBudgetsEnabled',
  'sessionMirrorEnabled',
  'sessionMirrorMaxChars',
  'sessionMirrorActiveWindowMs',
  'continuityMessageLimit',
  'extractionInterval',
  'extractionThresholdPct',
  'compactionThresholdPct',
  'observationMaskingWindow',
  'compactionEmotionalSalienceThresholdPct',
  'memoryExtractionMinImportance',
  'memoryExtractionMinConfidence',
  'memoryExtractionMinNovelty',
  'memoryExtractionEmotionalIntensityWeight',
  'memoryExtractionMaxWrites',
  'memoryExtractionTelemetryEnabled',
  'memoryRetrievalTelemetryEnabled',
  'profileSynthesisEnabled',
  'profileSynthesisRefreshIntervalMs',
  'profileSynthesisCooldownMs',
  'profileSynthesisMinWrites',
  'profileSynthesisMinImportance',
  'profileSynthesisMinConfidence',
  'profileSynthesisMinNovelty',
  'profileSynthesisSourceMemoryLimit',
  'profileSynthesisMinSourceMemories',
  'thinkMaxTokens',
  'thinkMaxWallTimeMs',
  'thinkMaxSubQueries',
  'retryMaxAttempts',
  'retryBaseDelayMs',
  'moaMaxRounds',
  'moaMaxTokensPerRound',
  'moaTimeoutMs',
] as const satisfies readonly SharedConfigSettingKey[];

function getModelSettingsSnapshot(config: SubstrateConfig) {
  return {
    primaryModel: config.primaryModel,
    primaryProvider: config.primaryProvider,
    primaryMaxTokens: config.primaryMaxTokens,
    extractionModel: config.extractionModel,
    extractionProvider: config.extractionProvider,
    extractionMaxTokens: config.extractionMaxTokens,
  } satisfies SnapshotSection<
    | 'primaryModel'
    | 'primaryProvider'
    | 'primaryMaxTokens'
    | 'extractionModel'
    | 'extractionProvider'
    | 'extractionMaxTokens'
  >;
}

function getContextSettingsSnapshot(config: SubstrateConfig) {
  return {
    sessionHistoryBudgetPct: resolveSessionHistoryBudgetPct(config),
    memoryRetrievalBudgetPct: resolveMemoryRetrievalBudgetPct(config),
    moodCongruenceWeight:
      config.moodCongruenceWeight ?? DEFAULT_MOOD_CONGRUENCE_WEIGHT,
    adaptiveContextBudgetsEnabled:
      config.adaptiveContextBudgetsEnabled ?? false,
    sessionMirrorEnabled: config.sessionMirrorEnabled ?? true,
    sessionMirrorMaxChars: config.sessionMirrorMaxChars ?? 220,
    sessionMirrorActiveWindowMs:
      config.sessionMirrorActiveWindowMs ?? 30 * 60 * 1000,
    sessionMirrorChannelOverrides: structuredClone(
      config.sessionMirrorChannelOverrides ?? {},
    ),
    continuityMessageLimit: config.continuityMessageLimit ?? 10,
    sessionRestartBehavior:
      config.sessionRestartBehavior ?? 'reuse_latest_session',
    extractionInterval: config.extractionInterval,
    maintenanceIntervalMs: config.maintenanceIntervalMs,
    extractionThresholdPct: config.extractionThresholdPct,
    compactionThresholdPct: config.compactionThresholdPct,
    observationMaskingWindow: config.observationMaskingWindow ?? 1,
    compactionEmotionalSalienceThresholdPct:
      config.compactionEmotionalSalienceThresholdPct ?? 75,
  } satisfies SnapshotSection<
    | 'sessionHistoryBudgetPct'
    | 'memoryRetrievalBudgetPct'
    | 'moodCongruenceWeight'
    | 'adaptiveContextBudgetsEnabled'
    | 'sessionMirrorEnabled'
    | 'sessionMirrorMaxChars'
    | 'sessionMirrorActiveWindowMs'
    | 'sessionMirrorChannelOverrides'
    | 'continuityMessageLimit'
    | 'sessionRestartBehavior'
    | 'extractionInterval'
    | 'maintenanceIntervalMs'
    | 'extractionThresholdPct'
    | 'compactionThresholdPct'
    | 'observationMaskingWindow'
    | 'compactionEmotionalSalienceThresholdPct'
  >;
}

function getMemorySettingsSnapshot(config: SubstrateConfig) {
  return {
    memoryExtractionMinImportance: config.memoryExtractionMinImportance ?? null,
    memoryExtractionMinConfidence: config.memoryExtractionMinConfidence ?? null,
    memoryExtractionMinNovelty: config.memoryExtractionMinNovelty ?? null,
    memoryExtractionEmotionalIntensityWeight:
      config.memoryExtractionEmotionalIntensityWeight ?? null,
    memoryExtractionMaxWrites: config.memoryExtractionMaxWrites ?? null,
    memoryExtractionTelemetryEnabled:
      config.memoryExtractionTelemetryEnabled ?? true,
    memoryRetrievalTelemetryEnabled:
      config.memoryRetrievalTelemetryEnabled ?? true,
    profileSynthesisEnabled: config.profileSynthesisEnabled ?? true,
    profileSynthesisRefreshIntervalMs:
      config.profileSynthesisRefreshIntervalMs ?? null,
    profileSynthesisCooldownMs: config.profileSynthesisCooldownMs ?? null,
    profileSynthesisMinWrites: config.profileSynthesisMinWrites ?? null,
    profileSynthesisMinImportance: config.profileSynthesisMinImportance ?? null,
    profileSynthesisMinConfidence: config.profileSynthesisMinConfidence ?? null,
    profileSynthesisMinNovelty: config.profileSynthesisMinNovelty ?? null,
    profileSynthesisSourceMemoryLimit:
      config.profileSynthesisSourceMemoryLimit ?? null,
    profileSynthesisMinSourceMemories:
      config.profileSynthesisMinSourceMemories ?? null,
    thinkMaxTokens: config.thinkMaxTokens ?? null,
    thinkMaxWallTimeMs: config.thinkMaxWallTimeMs ?? null,
    thinkMaxSubQueries: config.thinkMaxSubQueries ?? null,
    retryMaxAttempts: config.retryMaxAttempts ?? null,
    retryBaseDelayMs: config.retryBaseDelayMs ?? null,
  } satisfies SnapshotSection<
    | 'memoryExtractionMinImportance'
    | 'memoryExtractionMinConfidence'
    | 'memoryExtractionMinNovelty'
    | 'memoryExtractionEmotionalIntensityWeight'
    | 'memoryExtractionMaxWrites'
    | 'memoryExtractionTelemetryEnabled'
    | 'memoryRetrievalTelemetryEnabled'
    | 'profileSynthesisEnabled'
    | 'profileSynthesisRefreshIntervalMs'
    | 'profileSynthesisCooldownMs'
    | 'profileSynthesisMinWrites'
    | 'profileSynthesisMinImportance'
    | 'profileSynthesisMinConfidence'
    | 'profileSynthesisMinNovelty'
    | 'profileSynthesisSourceMemoryLimit'
    | 'profileSynthesisMinSourceMemories'
    | 'thinkMaxTokens'
    | 'thinkMaxWallTimeMs'
    | 'thinkMaxSubQueries'
    | 'retryMaxAttempts'
    | 'retryBaseDelayMs'
  >;
}

function getProviderSettingsSnapshot(config: SubstrateConfig) {
  return {
    openRouterProviderOrder: config.openRouterProviderOrder ?? [],
    openRouterModelsApiUrl: config.openRouterModelsApiUrl ?? null,
    importProcessingRouteMode: config.importProcessingRouteMode ?? 'background',
    importProcessingStrictPolicy: config.importProcessingStrictPolicy ?? false,
    importProcessingLocalEndpointUrl:
      config.importProcessingLocalEndpointUrl ?? null,
    importProcessingLocalModel: config.importProcessingLocalModel ?? null,
    embeddingProvider: config.embeddingProvider ?? 'transformers',
    embeddingModel: config.embeddingModel ?? null,
    embeddingDims: config.embeddingDims ?? null,
    embeddingOllamaUrl: config.embeddingOllamaUrl ?? null,
    transformersModel: config.transformersModel ?? null,
    transformersCacheDir: config.transformersCacheDir ?? null,
    textEmotionModel: config.textEmotionModel ?? null,
    textEmotionCacheDir: config.textEmotionCacheDir ?? null,
    textEmotionDtype: config.textEmotionDtype ?? null,
    embeddingApiUrl: config.embeddingApiUrl ?? null,
    embeddingApiModel: config.embeddingApiModel ?? null,
    embeddingApiDims: config.embeddingApiDims ?? null,
  } satisfies SnapshotSection<
    | 'openRouterProviderOrder'
    | 'openRouterModelsApiUrl'
    | 'importProcessingRouteMode'
    | 'importProcessingStrictPolicy'
    | 'importProcessingLocalEndpointUrl'
    | 'importProcessingLocalModel'
    | 'embeddingProvider'
    | 'embeddingModel'
    | 'embeddingDims'
    | 'embeddingOllamaUrl'
    | 'transformersModel'
    | 'transformersCacheDir'
    | 'textEmotionModel'
    | 'textEmotionCacheDir'
    | 'textEmotionDtype'
    | 'embeddingApiUrl'
    | 'embeddingApiModel'
    | 'embeddingApiDims'
  >;
}

function getWebAndGardenSettingsSnapshot(config: SubstrateConfig) {
  return {
    compositionalPolicy: cloneCompositionalPolicyConfig(
      config.compositionalPolicy ?? createDefaultCompositionalPolicyConfig(),
    ),
    webFetchAllowHttp: config.webFetchAllowHttp ?? false,
    webFetchDomainAllowlist: config.webFetchDomainAllowlist ?? [],
    webFetchAllowInternalNetwork:
      config.webFetchAllowInternalNetwork ??
      config.webFetchLocalCrawlerEnabled ??
      false,
    webFetchLocalCrawlerEnabled: config.webFetchLocalCrawlerEnabled ?? false,
    webFetchLocalCrawlerAllowHttp:
      config.webFetchLocalCrawlerAllowHttp ?? false,
    webFetchLocalCrawlerHostAllowlist:
      config.webFetchLocalCrawlerHostAllowlist ?? [],
    webFetchLocalCrawlerDomainAllowlist:
      config.webFetchLocalCrawlerDomainAllowlist ?? [],
    webFetchTlsCaCertPaths: config.webFetchTlsCaCertPaths ?? [],
    capabilityTier: config.capabilityTier ?? 'nursery',
    promotedExtendedTools: config.promotedExtendedTools ?? [],
    chatApiBaseUrl:
      (config as SubstrateConfig & { chatApiBaseUrl?: string })
        .chatApiBaseUrl ?? null,
    comfyUiBaseUrl: config.comfyUiBaseUrl ?? null,
    imageWorkflows: cloneImageWorkflowSettings(config.imageWorkflows),
    uiThemeId: toNonEmptyString(config.uiThemeId) ?? DEFAULT_UI_THEME_ID,
  } satisfies SnapshotSection<
    | 'compositionalPolicy'
    | 'webFetchAllowHttp'
    | 'webFetchDomainAllowlist'
    | 'webFetchAllowInternalNetwork'
    | 'webFetchLocalCrawlerEnabled'
    | 'webFetchLocalCrawlerAllowHttp'
    | 'webFetchLocalCrawlerHostAllowlist'
    | 'webFetchLocalCrawlerDomainAllowlist'
    | 'webFetchTlsCaCertPaths'
    | 'capabilityTier'
    | 'promotedExtendedTools'
    | 'chatApiBaseUrl'
    | 'comfyUiBaseUrl'
    | 'imageWorkflows'
    | 'uiThemeId'
  >;
}

function getVoiceSettingsSnapshot(config: SubstrateConfig) {
  return {
    voiceEnabled: config.voiceEnabled ?? false,
    ttsProvider: resolveRuntimeTtsProvider(config),
    voiceId: config.elevenLabsVoiceId ?? '',
    voiceTargetGuildId: config.voiceTargetGuildId ?? '',
    voiceTargetUserId: config.voiceTargetUserId ?? '',
    voiceReadyCueText: config.voiceReadyCueText ?? '',
    echoTtsUrl: config.echoTtsUrl ?? '',
    echoTtsVoice: config.echoTtsVoice ?? '',
    echoTtsPreset: config.echoTtsPreset ?? '',
    sttProvider: resolveRuntimeSttProvider(config),
    deepgramModel: config.deepgramModel ?? null,
    deepgramSttEndpoint: config.deepgramSttEndpoint ?? null,
    deepgramListenEndpoint: config.deepgramListenEndpoint ?? null,
    elevenLabsModelId: config.elevenLabsModelId ?? null,
    elevenLabsEndpointBase: config.elevenLabsEndpointBase ?? null,
  } satisfies SnapshotSection<
    | 'voiceEnabled'
    | 'ttsProvider'
    | 'voiceId'
    | 'voiceTargetGuildId'
    | 'voiceTargetUserId'
    | 'voiceReadyCueText'
    | 'echoTtsUrl'
    | 'echoTtsVoice'
    | 'echoTtsPreset'
    | 'sttProvider'
    | 'deepgramModel'
    | 'deepgramSttEndpoint'
    | 'deepgramListenEndpoint'
    | 'elevenLabsModelId'
    | 'elevenLabsEndpointBase'
  >;
}

function getChannelSettingsSnapshot(config: SubstrateConfig) {
  return {
    discordTriggerWords: config.discordTriggerWords?.join(', ') ?? null,
    discordTriggerReactions: config.discordTriggerReactions?.join(', ') ?? '👆',
    discordTriggerListenWindowMs:
      config.discordTriggerListenWindowMs ?? 120_000,
    telegramEnabled: config.telegramEnabled ?? false,
    telegramAuthorizedUsers: config.telegramAuthorizedUsers?.join(', ') ?? null,
    wyomingShardRouting: structuredClone(
      config.wyomingShardRouting ?? { enabled: false },
    ),
    shardToolsets: structuredClone(config.shardToolsets ?? {}),
  } satisfies SnapshotSection<
    | 'discordTriggerWords'
    | 'discordTriggerReactions'
    | 'discordTriggerListenWindowMs'
    | 'telegramEnabled'
    | 'telegramAuthorizedUsers'
    | 'wyomingShardRouting'
    | 'shardToolsets'
  >;
}

function getObsidianAndMoaSettingsSnapshot(config: SubstrateConfig) {
  return {
    obsidianVaultName: config.obsidianVaultName ?? null,
    obsidianCliPath: config.obsidianCliPath ?? 'obsidian',
    obsidianAutoPublish: config.obsidianAutoPublish ?? false,
    obsidianTimeoutMs: config.obsidianTimeoutMs ?? 10000,
    moaEnabled: config.moaEnabled ?? false,
    moaReferenceModels: config.moaReferenceModels ?? [],
    moaAggregatorModel: config.moaAggregatorModel ?? null,
    moaMaxRounds: config.moaMaxRounds ?? null,
    moaMaxTokensPerRound: config.moaMaxTokensPerRound ?? null,
    moaTimeoutMs: config.moaTimeoutMs ?? null,
  } satisfies SnapshotSection<
    | 'obsidianVaultName'
    | 'obsidianCliPath'
    | 'obsidianAutoPublish'
    | 'obsidianTimeoutMs'
    | 'moaEnabled'
    | 'moaReferenceModels'
    | 'moaAggregatorModel'
    | 'moaMaxRounds'
    | 'moaMaxTokensPerRound'
    | 'moaTimeoutMs'
  >;
}

function hasSetting(settings: EditableSettings, key: string): boolean {
  return key in settings;
}

function setConfigValue(
  config: SubstrateConfig,
  key: string,
  value: unknown,
): void {
  (config as Record<string, unknown>)[key] = value;
}

function copyDefinedConfigSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
  keys: readonly SharedConfigSettingKey[],
): void {
  for (const key of keys) {
    const value = settings[key];
    if (value !== undefined) {
      setConfigValue(config, key, value);
    }
  }
}

function copyListOrClear(value: string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? [...value] : undefined;
}

function getRawSetting(settings: EditableSettings, key: string): unknown {
  return (settings as Record<string, unknown>)[key];
}

function trimmedSetting(settings: EditableSettings, key: string): string {
  const value = getRawSetting(settings, key);
  return typeof value === 'string' ? value.trim() : '';
}

function applyTrimmedSetting(
  config: SubstrateConfig,
  configKey: string,
  settings: EditableSettings,
  settingsKey: string,
  emptyValue: string | undefined = undefined,
): void {
  if (!hasSetting(settings, settingsKey)) return;
  setConfigValue(
    config,
    configKey,
    trimmedSetting(settings, settingsKey) || emptyValue,
  );
}

function parseCsvList(value: string | undefined): string[] {
  const csv = value?.trim() ?? '';
  return csv
    ? [
        ...new Set(
          csv
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return (RUNTIME_SETTINGS_KEYS as readonly string[]).includes(value);
}

export function getRuntimeSettingsSnapshot(
  config: SubstrateConfig,
): RuntimeSettingsSnapshot {
  return {
    ...getModelSettingsSnapshot(config),
    ...getContextSettingsSnapshot(config),
    ...getMemorySettingsSnapshot(config),
    ...getProviderSettingsSnapshot(config),
    ...getWebAndGardenSettingsSnapshot(config),
    ...getVoiceSettingsSnapshot(config),
    ...getChannelSettingsSnapshot(config),
    ...getObsidianAndMoaSettingsSnapshot(config),
  };
}

function applyCoreSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  copyDefinedConfigSettings(config, settings, DIRECT_DEFINED_CONFIG_SETTINGS);
  if ('sessionMirrorChannelOverrides' in settings) {
    config.sessionMirrorChannelOverrides = structuredClone(
      settings.sessionMirrorChannelOverrides ?? {},
    );
  }
  if ('sessionRestartBehavior' in settings) {
    const behavior = settings.sessionRestartBehavior;
    config.sessionRestartBehavior =
      behavior === 'new_session' ? 'new_session' : 'reuse_latest_session';
  }
}

function applyProviderSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  if ('openRouterProviderOrder' in settings) {
    config.openRouterProviderOrder = copyListOrClear(
      settings.openRouterProviderOrder,
    );
  }
  applyTrimmedSetting(
    config,
    'openRouterModelsApiUrl',
    settings,
    'openRouterModelsApiUrl',
  );
  if ('importProcessingRouteMode' in settings) {
    config.importProcessingRouteMode =
      settings.importProcessingRouteMode ?? 'background';
  }
  if ('importProcessingStrictPolicy' in settings) {
    config.importProcessingStrictPolicy =
      settings.importProcessingStrictPolicy ?? false;
  }
  applyTrimmedSetting(
    config,
    'importProcessingLocalEndpointUrl',
    settings,
    'importProcessingLocalEndpointUrl',
  );
  applyTrimmedSetting(
    config,
    'importProcessingLocalModel',
    settings,
    'importProcessingLocalModel',
  );
  if ('embeddingProvider' in settings) {
    config.embeddingProvider = settings.embeddingProvider ?? 'transformers';
  }
  applyTrimmedSetting(config, 'embeddingModel', settings, 'embeddingModel');
  if ('embeddingDims' in settings) {
    config.embeddingDims = settings.embeddingDims ?? undefined;
  }
  applyTrimmedSetting(
    config,
    'embeddingOllamaUrl',
    settings,
    'embeddingOllamaUrl',
  );
  applyTrimmedSetting(
    config,
    'transformersModel',
    settings,
    'transformersModel',
  );
  applyTrimmedSetting(
    config,
    'transformersCacheDir',
    settings,
    'transformersCacheDir',
  );
  applyTrimmedSetting(config, 'textEmotionModel', settings, 'textEmotionModel');
  applyTrimmedSetting(
    config,
    'textEmotionCacheDir',
    settings,
    'textEmotionCacheDir',
  );
  if ('textEmotionDtype' in settings) {
    config.textEmotionDtype = settings.textEmotionDtype ?? undefined;
  }
  applyTrimmedSetting(config, 'embeddingApiUrl', settings, 'embeddingApiUrl');
  applyTrimmedSetting(
    config,
    'embeddingApiModel',
    settings,
    'embeddingApiModel',
  );
  if ('embeddingApiDims' in settings) {
    config.embeddingApiDims = settings.embeddingApiDims ?? undefined;
  }
  if ('compositionalPolicy' in settings) {
    config.compositionalPolicy = cloneCompositionalPolicyConfig(
      settings.compositionalPolicy,
    );
  }
}

function applyWebAndGardenSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  if ('webFetchAllowHttp' in settings) {
    config.webFetchAllowHttp = settings.webFetchAllowHttp ?? false;
  }
  if ('webFetchDomainAllowlist' in settings) {
    config.webFetchDomainAllowlist = copyListOrClear(
      settings.webFetchDomainAllowlist,
    );
  }
  if ('webFetchAllowInternalNetwork' in settings) {
    config.webFetchAllowInternalNetwork =
      settings.webFetchAllowInternalNetwork ?? false;
  }
  if ('webFetchLocalCrawlerEnabled' in settings) {
    config.webFetchLocalCrawlerEnabled =
      settings.webFetchLocalCrawlerEnabled ?? false;
  }
  if ('webFetchLocalCrawlerAllowHttp' in settings) {
    config.webFetchLocalCrawlerAllowHttp =
      settings.webFetchLocalCrawlerAllowHttp ?? false;
  }
  if ('webFetchLocalCrawlerHostAllowlist' in settings) {
    config.webFetchLocalCrawlerHostAllowlist = copyListOrClear(
      settings.webFetchLocalCrawlerHostAllowlist,
    );
  }
  if ('webFetchLocalCrawlerDomainAllowlist' in settings) {
    config.webFetchLocalCrawlerDomainAllowlist = copyListOrClear(
      settings.webFetchLocalCrawlerDomainAllowlist,
    );
  }
  if ('webFetchTlsCaCertPaths' in settings) {
    config.webFetchTlsCaCertPaths = copyListOrClear(
      settings.webFetchTlsCaCertPaths,
    );
  }

  if (
    settings.capabilityTier !== undefined &&
    isCapabilityTier(settings.capabilityTier)
  ) {
    config.capabilityTier = settings.capabilityTier;
  }
  if ('promotedExtendedTools' in settings) {
    config.promotedExtendedTools = toPromotedToolList(
      settings.promotedExtendedTools,
    );
  }
  applyTrimmedSetting(config, 'chatApiBaseUrl', settings, 'chatApiBaseUrl');
  applyTrimmedSetting(config, 'comfyUiBaseUrl', settings, 'comfyUiBaseUrl');
  if ('imageWorkflows' in settings) {
    config.imageWorkflows = normalizeImageWorkflowSettings(
      settings.imageWorkflows,
    );
  }
  if ('uiThemeId' in settings) {
    const trimmedThemeId = settings.uiThemeId?.trim() ?? '';
    config.uiThemeId = trimmedThemeId || DEFAULT_UI_THEME_ID;
  }
}

function applyVoiceSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  if ('voiceEnabled' in settings) {
    const voiceEnabled = getRawSetting(settings, 'voiceEnabled');
    if (voiceEnabled !== undefined) {
      setConfigValue(config, 'voiceEnabled', voiceEnabled);
    }
  }
  if ('ttsProvider' in settings) {
    config.ttsProvider = normalizeTtsProvider(settings.ttsProvider);
  }
  applyTrimmedSetting(config, 'elevenLabsVoiceId', settings, 'voiceId');
  applyTrimmedSetting(
    config,
    'voiceTargetGuildId',
    settings,
    'voiceTargetGuildId',
    '',
  );
  applyTrimmedSetting(
    config,
    'voiceTargetUserId',
    settings,
    'voiceTargetUserId',
    '',
  );
  applyTrimmedSetting(
    config,
    'voiceReadyCueText',
    settings,
    'voiceReadyCueText',
    '',
  );
  applyTrimmedSetting(config, 'echoTtsUrl', settings, 'echoTtsUrl');
  applyTrimmedSetting(config, 'echoTtsVoice', settings, 'echoTtsVoice');
  applyTrimmedSetting(config, 'echoTtsPreset', settings, 'echoTtsPreset');
  if ('sttProvider' in settings) {
    config.sttProvider = normalizeSttProvider(settings.sttProvider);
  }
  applyTrimmedSetting(config, 'deepgramModel', settings, 'deepgramModel');
  applyTrimmedSetting(
    config,
    'deepgramSttEndpoint',
    settings,
    'deepgramSttEndpoint',
  );
  applyTrimmedSetting(
    config,
    'deepgramListenEndpoint',
    settings,
    'deepgramListenEndpoint',
  );
  applyTrimmedSetting(
    config,
    'elevenLabsModelId',
    settings,
    'elevenLabsModelId',
  );
  applyTrimmedSetting(
    config,
    'elevenLabsEndpointBase',
    settings,
    'elevenLabsEndpointBase',
  );
  if ('wyomingShardRouting' in settings) {
    config.wyomingShardRouting = structuredClone(
      (getRawSetting(
        settings,
        'wyomingShardRouting',
      ) as SubstrateConfig['wyomingShardRouting']) ?? { enabled: false },
    );
  }
  if ('shardToolsets' in settings) {
    config.shardToolsets = structuredClone(
      getRawSetting(
        settings,
        'shardToolsets',
      ) as SubstrateConfig['shardToolsets'],
    );
  }
}

function applyChannelSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  if ('discordTriggerWords' in settings) {
    config.discordTriggerWords = parseCsvList(settings.discordTriggerWords);
  }
  if ('discordTriggerReactions' in settings) {
    const reactions = parseCsvList(settings.discordTriggerReactions);
    config.discordTriggerReactions = reactions.length > 0 ? reactions : ['👆'];
  }
  if ('discordTriggerListenWindowMs' in settings) {
    config.discordTriggerListenWindowMs =
      settings.discordTriggerListenWindowMs ?? 120_000;
  }
  if ('telegramEnabled' in settings) {
    config.telegramEnabled = settings.telegramEnabled ?? false;
  }
  if ('telegramAuthorizedUsers' in settings) {
    config.telegramAuthorizedUsers = copyListOrClear(
      parseCsvList(settings.telegramAuthorizedUsers),
    );
  }
}

function applyObsidianAndMoaSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  applyTrimmedSetting(
    config,
    'obsidianVaultName',
    settings,
    'obsidianVaultName',
  );
  applyTrimmedSetting(config, 'obsidianCliPath', settings, 'obsidianCliPath');
  if ('obsidianAutoPublish' in settings) {
    config.obsidianAutoPublish = settings.obsidianAutoPublish ?? false;
  }
  if ('obsidianTimeoutMs' in settings) {
    config.obsidianTimeoutMs = settings.obsidianTimeoutMs;
  }

  if ('moaEnabled' in settings) {
    config.moaEnabled = settings.moaEnabled ?? false;
  }
  if ('moaReferenceModels' in settings) {
    config.moaReferenceModels = copyListOrClear(settings.moaReferenceModels);
  }
  applyTrimmedSetting(
    config,
    'moaAggregatorModel',
    settings,
    'moaAggregatorModel',
  );
}

function applyModelSettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  if (
    hasLegacyModelSettingsPayload(settings) &&
    settings.modelRegistry === undefined
  ) {
    throw new Error(
      'Legacy model settings payloads are unsupported; use modelRegistry',
    );
  }

  const shouldSyncModels =
    hasModelSettings(settings) || config.modelRegistry !== undefined;

  if (!shouldSyncModels) return;

  const merged = mergeModelSettingsWithConfig(config, settings);
  const normalized = normalizeEditableSettings(merged, {
    defaultContextWindow: config.defaultContextWindow,
  });

  if (normalized.primaryModel !== undefined)
    config.primaryModel = normalized.primaryModel;
  if (normalized.primaryProvider !== undefined)
    config.primaryProvider = normalized.primaryProvider;
  if (normalized.primaryMaxTokens !== undefined)
    config.primaryMaxTokens = normalized.primaryMaxTokens;

  if (normalized.extractionModel !== undefined)
    config.extractionModel = normalized.extractionModel;
  if (normalized.extractionProvider !== undefined)
    config.extractionProvider = normalized.extractionProvider;
  if (normalized.extractionMaxTokens !== undefined)
    config.extractionMaxTokens = normalized.extractionMaxTokens;

  if (normalized.modelRegistry !== undefined)
    config.modelRegistry = normalized.modelRegistry;
  if (normalized.modelRoster !== undefined)
    config.modelRoster = normalized.modelRoster;
  if (normalized.modelCatalog !== undefined)
    config.modelCatalog = normalized.modelCatalog;
  if (normalized.modelRoleAssignments !== undefined) {
    config.modelRoleAssignments = normalized.modelRoleAssignments;
  }
}

/** Mutate config in place with defined settings values. */
export function applySettings(
  config: SubstrateConfig,
  settings: EditableSettings,
): void {
  applyCoreSettings(config, settings);
  applyProviderSettings(config, settings);
  applyWebAndGardenSettings(config, settings);
  applyVoiceSettings(config, settings);
  applyChannelSettings(config, settings);
  applyObsidianAndMoaSettings(config, settings);
  applyModelSettings(config, settings);
}
