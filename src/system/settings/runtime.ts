import { DEFAULT_MOOD_CONGRUENCE_WEIGHT, DEFAULT_UI_THEME_ID, type SubstrateConfig } from '../config/runtime-config-contracts.js';
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

function mergeModelSettingsWithConfig(config: SubstrateConfig, settings: EditableSettings): EditableSettings {
  return {
    ...(settings.modelRegistry !== undefined
      ? { modelRegistry: settings.modelRegistry }
      : {}),
    ...(settings.modelRegistry === undefined && config.modelRegistry !== undefined
      ? { modelRegistry: config.modelRegistry }
      : {}),
  };
}

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return (RUNTIME_SETTINGS_KEYS as readonly string[]).includes(value);
}

export function getRuntimeSettingsSnapshot(config: SubstrateConfig): RuntimeSettingsSnapshot {
  const sessionBudgetPct = resolveSessionHistoryBudgetPct(config);
  const retrievalBudgetPct = resolveMemoryRetrievalBudgetPct(config);

  return {
    primaryModel: config.primaryModel,
    primaryProvider: config.primaryProvider,
    primaryMaxTokens: config.primaryMaxTokens,
    extractionModel: config.extractionModel,
    extractionProvider: config.extractionProvider,
    extractionMaxTokens: config.extractionMaxTokens,
    sessionHistoryBudgetPct: sessionBudgetPct,
    memoryRetrievalBudgetPct: retrievalBudgetPct,
    moodCongruenceWeight: config.moodCongruenceWeight ?? DEFAULT_MOOD_CONGRUENCE_WEIGHT,
    adaptiveContextBudgetsEnabled: config.adaptiveContextBudgetsEnabled ?? false,
    sessionRestartBehavior: config.sessionRestartBehavior ?? 'reuse_latest_session',
    extractionInterval: config.extractionInterval,
    maintenanceIntervalMs: config.maintenanceIntervalMs,
    extractionThresholdPct: config.extractionThresholdPct,
    compactionThresholdPct: config.compactionThresholdPct,
    observationMaskingWindow: config.observationMaskingWindow ?? 10,
    compactionEmotionalSalienceThresholdPct: config.compactionEmotionalSalienceThresholdPct ?? 75,
    memoryExtractionMinImportance: config.memoryExtractionMinImportance ?? null,
    memoryExtractionMinConfidence: config.memoryExtractionMinConfidence ?? null,
    memoryExtractionMinNovelty: config.memoryExtractionMinNovelty ?? null,
    memoryExtractionEmotionalIntensityWeight: config.memoryExtractionEmotionalIntensityWeight ?? null,
    memoryExtractionMaxWrites: config.memoryExtractionMaxWrites ?? null,
    memoryExtractionTelemetryEnabled: config.memoryExtractionTelemetryEnabled ?? true,
    memoryRetrievalTelemetryEnabled: config.memoryRetrievalTelemetryEnabled ?? true,
    profileSynthesisEnabled: config.profileSynthesisEnabled ?? true,
    profileSynthesisRefreshIntervalMs: config.profileSynthesisRefreshIntervalMs ?? null,
    profileSynthesisCooldownMs: config.profileSynthesisCooldownMs ?? null,
    profileSynthesisMinWrites: config.profileSynthesisMinWrites ?? null,
    profileSynthesisMinImportance: config.profileSynthesisMinImportance ?? null,
    profileSynthesisMinConfidence: config.profileSynthesisMinConfidence ?? null,
    profileSynthesisMinNovelty: config.profileSynthesisMinNovelty ?? null,
    profileSynthesisSourceMemoryLimit: config.profileSynthesisSourceMemoryLimit ?? null,
    profileSynthesisMinSourceMemories: config.profileSynthesisMinSourceMemories ?? null,
    thinkMaxTokens: config.thinkMaxTokens ?? null,
    thinkMaxWallTimeMs: config.thinkMaxWallTimeMs ?? null,
    thinkMaxSubQueries: config.thinkMaxSubQueries ?? null,
    retryMaxAttempts: config.retryMaxAttempts ?? null,
    retryBaseDelayMs: config.retryBaseDelayMs ?? null,
    openRouterProviderOrder: config.openRouterProviderOrder ?? [],
    openRouterModelsApiUrl: config.openRouterModelsApiUrl ?? null,
    importProcessingRouteMode: config.importProcessingRouteMode ?? 'background',
    importProcessingStrictPolicy: config.importProcessingStrictPolicy ?? false,
    importProcessingLocalEndpointUrl: config.importProcessingLocalEndpointUrl ?? null,
    importProcessingLocalModel: config.importProcessingLocalModel ?? null,
    embeddingProvider: config.embeddingProvider ?? 'ollama',
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
    compositionalPolicy: cloneCompositionalPolicyConfig(
      config.compositionalPolicy ?? createDefaultCompositionalPolicyConfig(),
    ),
    webFetchAllowHttp: config.webFetchAllowHttp ?? false,
    webFetchDomainAllowlist: config.webFetchDomainAllowlist ?? [],
    webFetchAllowInternalNetwork: config.webFetchAllowInternalNetwork
      ?? config.webFetchLocalCrawlerEnabled
      ?? false,
    webFetchLocalCrawlerEnabled: config.webFetchLocalCrawlerEnabled ?? false,
    webFetchLocalCrawlerAllowHttp: config.webFetchLocalCrawlerAllowHttp ?? false,
    webFetchLocalCrawlerHostAllowlist: config.webFetchLocalCrawlerHostAllowlist ?? [],
    webFetchLocalCrawlerDomainAllowlist: config.webFetchLocalCrawlerDomainAllowlist ?? [],
    webFetchTlsCaCertPaths: config.webFetchTlsCaCertPaths ?? [],
    capabilityTier: config.capabilityTier ?? 'nursery',
    promotedExtendedTools: config.promotedExtendedTools ?? [],
    chatApiBaseUrl: (config as SubstrateConfig & { chatApiBaseUrl?: string }).chatApiBaseUrl ?? null,
    comfyUiBaseUrl: config.comfyUiBaseUrl ?? null,
    imageWorkflows: cloneImageWorkflowSettings(config.imageWorkflows),
    uiThemeId: toNonEmptyString(config.uiThemeId) ?? DEFAULT_UI_THEME_ID,
    // Voice / TTS
    ttsProvider: resolveRuntimeTtsProvider(config),
    voiceId: config.elevenLabsVoiceId ?? '',
    echoTtsUrl: config.echoTtsUrl ?? '',
    echoTtsVoice: config.echoTtsVoice ?? '',
    echoTtsPreset: config.echoTtsPreset ?? '',
    sttProvider: resolveRuntimeSttProvider(config),
    deepgramModel: config.deepgramModel ?? null,
    deepgramSttEndpoint: config.deepgramSttEndpoint ?? null,
    deepgramListenEndpoint: config.deepgramListenEndpoint ?? null,
    elevenLabsModelId: config.elevenLabsModelId ?? null,
    elevenLabsEndpointBase: config.elevenLabsEndpointBase ?? null,
    // Channels
    discordTriggerWords: config.discordTriggerWords?.join(', ') ?? null,
    discordTriggerReactions: config.discordTriggerReactions?.join(', ') ?? '👆',
    discordTriggerListenWindowMs: config.discordTriggerListenWindowMs ?? 120_000,
    telegramEnabled: config.telegramEnabled ?? false,
    telegramAuthorizedUsers: config.telegramAuthorizedUsers?.join(', ') ?? null,
    // Obsidian vault
    obsidianVaultName: config.obsidianVaultName ?? null,
    obsidianCliPath: config.obsidianCliPath ?? 'obsidian',
    obsidianAutoPublish: config.obsidianAutoPublish ?? false,
    obsidianTimeoutMs: config.obsidianTimeoutMs ?? 10000,
    // MoA (Mixture of Agents)
    moaEnabled: config.moaEnabled ?? false,
    moaReferenceModels: config.moaReferenceModels ?? [],
    moaAggregatorModel: config.moaAggregatorModel ?? null,
    moaMaxRounds: config.moaMaxRounds ?? null,
    moaMaxTokensPerRound: config.moaMaxTokensPerRound ?? null,
    moaTimeoutMs: config.moaTimeoutMs ?? null,
  };
}

/** Mutate config in place with defined settings values. */
export function applySettings(config: SubstrateConfig, settings: EditableSettings): void {
  if (settings.sessionHistoryBudgetPct !== undefined) {
    config.sessionHistoryBudgetPct = settings.sessionHistoryBudgetPct;
  }
  if (settings.memoryRetrievalBudgetPct !== undefined) {
    config.memoryRetrievalBudgetPct = settings.memoryRetrievalBudgetPct;
  }
  if (settings.moodCongruenceWeight !== undefined) {
    config.moodCongruenceWeight = settings.moodCongruenceWeight;
  }
  if (settings.adaptiveContextBudgetsEnabled !== undefined) {
    config.adaptiveContextBudgetsEnabled = settings.adaptiveContextBudgetsEnabled;
  }
  if ('sessionRestartBehavior' in settings) {
    const behavior = settings.sessionRestartBehavior;
    config.sessionRestartBehavior = behavior === 'new_session' ? 'new_session' : 'reuse_latest_session';
  }
  if (settings.extractionInterval !== undefined) config.extractionInterval = settings.extractionInterval;
  if (settings.extractionThresholdPct !== undefined) {
    config.extractionThresholdPct = settings.extractionThresholdPct;
  }
  if (settings.compactionThresholdPct !== undefined) {
    config.compactionThresholdPct = settings.compactionThresholdPct;
  }
  if (settings.observationMaskingWindow !== undefined) {
    config.observationMaskingWindow = settings.observationMaskingWindow;
  }
  if (settings.compactionEmotionalSalienceThresholdPct !== undefined) {
    config.compactionEmotionalSalienceThresholdPct = settings.compactionEmotionalSalienceThresholdPct;
  }
  if (settings.memoryExtractionMinImportance !== undefined) {
    config.memoryExtractionMinImportance = settings.memoryExtractionMinImportance;
  }
  if (settings.memoryExtractionMinConfidence !== undefined) {
    config.memoryExtractionMinConfidence = settings.memoryExtractionMinConfidence;
  }
  if (settings.memoryExtractionMinNovelty !== undefined) {
    config.memoryExtractionMinNovelty = settings.memoryExtractionMinNovelty;
  }
  if (settings.memoryExtractionEmotionalIntensityWeight !== undefined) {
    config.memoryExtractionEmotionalIntensityWeight = settings.memoryExtractionEmotionalIntensityWeight;
  }
  if (settings.memoryExtractionMaxWrites !== undefined) {
    config.memoryExtractionMaxWrites = settings.memoryExtractionMaxWrites;
  }
  if (settings.memoryExtractionTelemetryEnabled !== undefined) {
    config.memoryExtractionTelemetryEnabled = settings.memoryExtractionTelemetryEnabled;
  }
  if (settings.memoryRetrievalTelemetryEnabled !== undefined) {
    config.memoryRetrievalTelemetryEnabled = settings.memoryRetrievalTelemetryEnabled;
  }
  if (settings.profileSynthesisEnabled !== undefined) {
    config.profileSynthesisEnabled = settings.profileSynthesisEnabled;
  }
  if (settings.profileSynthesisRefreshIntervalMs !== undefined) {
    config.profileSynthesisRefreshIntervalMs = settings.profileSynthesisRefreshIntervalMs;
  }
  if (settings.profileSynthesisCooldownMs !== undefined) {
    config.profileSynthesisCooldownMs = settings.profileSynthesisCooldownMs;
  }
  if (settings.profileSynthesisMinWrites !== undefined) {
    config.profileSynthesisMinWrites = settings.profileSynthesisMinWrites;
  }
  if (settings.profileSynthesisMinImportance !== undefined) {
    config.profileSynthesisMinImportance = settings.profileSynthesisMinImportance;
  }
  if (settings.profileSynthesisMinConfidence !== undefined) {
    config.profileSynthesisMinConfidence = settings.profileSynthesisMinConfidence;
  }
  if (settings.profileSynthesisMinNovelty !== undefined) {
    config.profileSynthesisMinNovelty = settings.profileSynthesisMinNovelty;
  }
  if (settings.profileSynthesisSourceMemoryLimit !== undefined) {
    config.profileSynthesisSourceMemoryLimit = settings.profileSynthesisSourceMemoryLimit;
  }
  if (settings.profileSynthesisMinSourceMemories !== undefined) {
    config.profileSynthesisMinSourceMemories = settings.profileSynthesisMinSourceMemories;
  }
  if (settings.thinkMaxTokens !== undefined) config.thinkMaxTokens = settings.thinkMaxTokens;
  if (settings.thinkMaxWallTimeMs !== undefined) config.thinkMaxWallTimeMs = settings.thinkMaxWallTimeMs;
  if (settings.thinkMaxSubQueries !== undefined) config.thinkMaxSubQueries = settings.thinkMaxSubQueries;
  if (settings.retryMaxAttempts !== undefined) config.retryMaxAttempts = settings.retryMaxAttempts;
  if (settings.retryBaseDelayMs !== undefined) config.retryBaseDelayMs = settings.retryBaseDelayMs;
  if ('openRouterProviderOrder' in settings) {
    config.openRouterProviderOrder = settings.openRouterProviderOrder && settings.openRouterProviderOrder.length > 0
      ? [...settings.openRouterProviderOrder]
      : undefined;
  }
  if ('openRouterModelsApiUrl' in settings) {
    const trimmed = settings.openRouterModelsApiUrl?.trim() ?? '';
    config.openRouterModelsApiUrl = trimmed || undefined;
  }
  if ('importProcessingRouteMode' in settings) {
    config.importProcessingRouteMode = settings.importProcessingRouteMode ?? 'background';
  }
  if ('importProcessingStrictPolicy' in settings) {
    config.importProcessingStrictPolicy = settings.importProcessingStrictPolicy ?? false;
  }
  if ('importProcessingLocalEndpointUrl' in settings) {
    const trimmed = settings.importProcessingLocalEndpointUrl?.trim() ?? '';
    config.importProcessingLocalEndpointUrl = trimmed || undefined;
  }
  if ('importProcessingLocalModel' in settings) {
    const trimmed = settings.importProcessingLocalModel?.trim() ?? '';
    config.importProcessingLocalModel = trimmed || undefined;
  }
  if ('embeddingProvider' in settings) {
    config.embeddingProvider = settings.embeddingProvider ?? 'ollama';
  }
  if ('embeddingModel' in settings) {
    const trimmed = settings.embeddingModel?.trim() ?? '';
    config.embeddingModel = trimmed || undefined;
  }
  if ('embeddingDims' in settings) {
    config.embeddingDims = settings.embeddingDims ?? undefined;
  }
  if ('embeddingOllamaUrl' in settings) {
    const trimmed = settings.embeddingOllamaUrl?.trim() ?? '';
    config.embeddingOllamaUrl = trimmed || undefined;
  }
  if ('transformersModel' in settings) {
    const trimmed = settings.transformersModel?.trim() ?? '';
    config.transformersModel = trimmed || undefined;
  }
  if ('transformersCacheDir' in settings) {
    const trimmed = settings.transformersCacheDir?.trim() ?? '';
    config.transformersCacheDir = trimmed || undefined;
  }
  if ('textEmotionModel' in settings) {
    const trimmed = settings.textEmotionModel?.trim() ?? '';
    config.textEmotionModel = trimmed || undefined;
  }
  if ('textEmotionCacheDir' in settings) {
    const trimmed = settings.textEmotionCacheDir?.trim() ?? '';
    config.textEmotionCacheDir = trimmed || undefined;
  }
  if ('textEmotionDtype' in settings) {
    config.textEmotionDtype = settings.textEmotionDtype ?? undefined;
  }
  if ('embeddingApiUrl' in settings) {
    const trimmed = settings.embeddingApiUrl?.trim() ?? '';
    config.embeddingApiUrl = trimmed || undefined;
  }
  if ('embeddingApiModel' in settings) {
    const trimmed = settings.embeddingApiModel?.trim() ?? '';
    config.embeddingApiModel = trimmed || undefined;
  }
  if ('embeddingApiDims' in settings) {
    config.embeddingApiDims = settings.embeddingApiDims ?? undefined;
  }
  if ('compositionalPolicy' in settings) {
    config.compositionalPolicy = cloneCompositionalPolicyConfig(settings.compositionalPolicy);
  }
  if ('webFetchAllowHttp' in settings) {
    config.webFetchAllowHttp = settings.webFetchAllowHttp ?? false;
  }
  if ('webFetchDomainAllowlist' in settings) {
    config.webFetchDomainAllowlist = settings.webFetchDomainAllowlist && settings.webFetchDomainAllowlist.length > 0
      ? [...settings.webFetchDomainAllowlist]
      : undefined;
  }
  if ('webFetchAllowInternalNetwork' in settings) {
    config.webFetchAllowInternalNetwork = settings.webFetchAllowInternalNetwork ?? false;
  }
  if ('webFetchLocalCrawlerEnabled' in settings) {
    config.webFetchLocalCrawlerEnabled = settings.webFetchLocalCrawlerEnabled ?? false;
  }
  if ('webFetchLocalCrawlerAllowHttp' in settings) {
    config.webFetchLocalCrawlerAllowHttp = settings.webFetchLocalCrawlerAllowHttp ?? false;
  }
  if ('webFetchLocalCrawlerHostAllowlist' in settings) {
    config.webFetchLocalCrawlerHostAllowlist =
      settings.webFetchLocalCrawlerHostAllowlist && settings.webFetchLocalCrawlerHostAllowlist.length > 0
        ? [...settings.webFetchLocalCrawlerHostAllowlist]
        : undefined;
  }
  if ('webFetchLocalCrawlerDomainAllowlist' in settings) {
    config.webFetchLocalCrawlerDomainAllowlist =
      settings.webFetchLocalCrawlerDomainAllowlist && settings.webFetchLocalCrawlerDomainAllowlist.length > 0
        ? [...settings.webFetchLocalCrawlerDomainAllowlist]
        : undefined;
  }
  if ('webFetchTlsCaCertPaths' in settings) {
    config.webFetchTlsCaCertPaths = settings.webFetchTlsCaCertPaths && settings.webFetchTlsCaCertPaths.length > 0
      ? [...settings.webFetchTlsCaCertPaths]
      : undefined;
  }

  if (settings.capabilityTier !== undefined && isCapabilityTier(settings.capabilityTier)) {
    config.capabilityTier = settings.capabilityTier;
  }
  if ('promotedExtendedTools' in settings) {
    config.promotedExtendedTools = toPromotedToolList(settings.promotedExtendedTools);
  }
  if ('chatApiBaseUrl' in settings) {
    const trimmed = settings.chatApiBaseUrl?.trim() ?? '';
    (config as SubstrateConfig & { chatApiBaseUrl?: string }).chatApiBaseUrl = trimmed || undefined;
  }
  if ('comfyUiBaseUrl' in settings) {
    const trimmed = settings.comfyUiBaseUrl?.trim() ?? '';
    config.comfyUiBaseUrl = trimmed || undefined;
  }
  if ('imageWorkflows' in settings) {
    config.imageWorkflows = normalizeImageWorkflowSettings(settings.imageWorkflows);
  }
  if ('uiThemeId' in settings) {
    const trimmedThemeId = settings.uiThemeId?.trim() ?? '';
    config.uiThemeId = trimmedThemeId || DEFAULT_UI_THEME_ID;
  }

  // Voice / TTS
  if ('ttsProvider' in settings) {
    config.ttsProvider = normalizeTtsProvider(settings.ttsProvider);
  }
  if ('voiceId' in settings) {
    const trimmed = settings.voiceId?.trim() ?? '';
    config.elevenLabsVoiceId = trimmed || undefined;
  }
  if ('echoTtsUrl' in settings) {
    const trimmed = settings.echoTtsUrl?.trim() ?? '';
    config.echoTtsUrl = trimmed || undefined;
  }
  if ('echoTtsVoice' in settings) {
    const trimmed = settings.echoTtsVoice?.trim() ?? '';
    config.echoTtsVoice = trimmed || undefined;
  }
  if ('echoTtsPreset' in settings) {
    const trimmed = settings.echoTtsPreset?.trim() ?? '';
    config.echoTtsPreset = trimmed || undefined;
  }
  if ('sttProvider' in settings) {
    config.sttProvider = normalizeSttProvider(settings.sttProvider);
  }
  if ('deepgramModel' in settings) {
    const trimmed = settings.deepgramModel?.trim() ?? '';
    config.deepgramModel = trimmed || undefined;
  }
  if ('deepgramSttEndpoint' in settings) {
    const trimmed = settings.deepgramSttEndpoint?.trim() ?? '';
    config.deepgramSttEndpoint = trimmed || undefined;
  }
  if ('deepgramListenEndpoint' in settings) {
    const trimmed = settings.deepgramListenEndpoint?.trim() ?? '';
    config.deepgramListenEndpoint = trimmed || undefined;
  }
  if ('elevenLabsModelId' in settings) {
    const trimmed = settings.elevenLabsModelId?.trim() ?? '';
    config.elevenLabsModelId = trimmed || undefined;
  }
  if ('elevenLabsEndpointBase' in settings) {
    const trimmed = settings.elevenLabsEndpointBase?.trim() ?? '';
    config.elevenLabsEndpointBase = trimmed || undefined;
  }

  // Channels
  if ('discordTriggerWords' in settings) {
    const csv = settings.discordTriggerWords?.trim() ?? '';
    config.discordTriggerWords = csv
      ? [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))]
      : [];
  }
  if ('discordTriggerReactions' in settings) {
    const csv = settings.discordTriggerReactions?.trim() ?? '';
    const reactions = csv
      ? [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))]
      : [];
    config.discordTriggerReactions = reactions.length > 0 ? reactions : ['👆'];
  }
  if ('discordTriggerListenWindowMs' in settings) {
    config.discordTriggerListenWindowMs = settings.discordTriggerListenWindowMs ?? 120_000;
  }
  if ('telegramEnabled' in settings) {
    config.telegramEnabled = settings.telegramEnabled ?? false;
  }
  if ('telegramAuthorizedUsers' in settings) {
    const csv = settings.telegramAuthorizedUsers?.trim() ?? '';
    config.telegramAuthorizedUsers = csv
      ? [...new Set(csv.split(',').map(s => s.trim()).filter(Boolean))]
      : undefined;
  }

  // Obsidian vault
  if ('obsidianVaultName' in settings) {
    config.obsidianVaultName = settings.obsidianVaultName?.trim() || undefined;
  }
  if ('obsidianCliPath' in settings) {
    config.obsidianCliPath = settings.obsidianCliPath?.trim() || undefined;
  }
  if ('obsidianAutoPublish' in settings) {
    config.obsidianAutoPublish = settings.obsidianAutoPublish ?? false;
  }
  if ('obsidianTimeoutMs' in settings) {
    config.obsidianTimeoutMs = settings.obsidianTimeoutMs;
  }

  // MoA (Mixture of Agents)
  if ('moaEnabled' in settings) {
    config.moaEnabled = settings.moaEnabled ?? false;
  }
  if ('moaReferenceModels' in settings) {
    config.moaReferenceModels = settings.moaReferenceModels && settings.moaReferenceModels.length > 0
      ? [...settings.moaReferenceModels]
      : undefined;
  }
  if ('moaAggregatorModel' in settings) {
    const trimmed = settings.moaAggregatorModel?.trim() ?? '';
    config.moaAggregatorModel = trimmed || undefined;
  }
  if (settings.moaMaxRounds !== undefined) config.moaMaxRounds = settings.moaMaxRounds;
  if (settings.moaMaxTokensPerRound !== undefined) config.moaMaxTokensPerRound = settings.moaMaxTokensPerRound;
  if (settings.moaTimeoutMs !== undefined) config.moaTimeoutMs = settings.moaTimeoutMs;

  if (hasLegacyModelSettingsPayload(settings) && settings.modelRegistry === undefined) {
    throw new Error('Legacy model settings payloads are unsupported; use modelRegistry');
  }

  const shouldSyncModels = hasModelSettings(settings)
    || config.modelRegistry !== undefined;

  if (!shouldSyncModels) return;

  const merged = mergeModelSettingsWithConfig(config, settings);
  const normalized = normalizeEditableSettings(merged, {
    defaultContextWindow: config.defaultContextWindow,
  });

  if (normalized.primaryModel !== undefined) config.primaryModel = normalized.primaryModel;
  if (normalized.primaryProvider !== undefined) config.primaryProvider = normalized.primaryProvider;
  if (normalized.primaryMaxTokens !== undefined) config.primaryMaxTokens = normalized.primaryMaxTokens;

  if (normalized.extractionModel !== undefined) config.extractionModel = normalized.extractionModel;
  if (normalized.extractionProvider !== undefined) config.extractionProvider = normalized.extractionProvider;
  if (normalized.extractionMaxTokens !== undefined) config.extractionMaxTokens = normalized.extractionMaxTokens;

  if (normalized.modelRegistry !== undefined) config.modelRegistry = normalized.modelRegistry;
  if (normalized.modelRoster !== undefined) config.modelRoster = normalized.modelRoster;
  if (normalized.modelCatalog !== undefined) config.modelCatalog = normalized.modelCatalog;
  if (normalized.modelRoleAssignments !== undefined) {
    config.modelRoleAssignments = normalized.modelRoleAssignments;
  }
}
