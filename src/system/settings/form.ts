import {
  DEFAULT_UI_THEME_ID,
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
} from '../config/runtime-config-contracts.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from '../../shared/context-budget.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import {
  toBoolean,
  toEmbeddingProvider,
  toConfiguredSttProvider,
  toConfiguredTtsProvider,
  toImportProcessingRouteMode,
  toSessionRestartBehavior,
} from './coercion.js';
import {
  normalizeCanonicalModelRegistry,
  normalizeEditableSettings,
} from './schema.js';
import {
  COMPACTION_THRESHOLD_PCT_RANGE,
  EXTRACTION_THRESHOLD_PCT_RANGE,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  type EditableSettings,
} from './contracts.js';

/** Validation ranges for settings values. */
export const SETTINGS_VALIDATION = {
  primaryMaxTokens: { min: 256, max: 1_000_000 },
  extractionMaxTokens: { min: 256, max: 1_000_000 },
  sessionHistoryBudgetPct: {
    min: SESSION_HISTORY_BUDGET_PCT_RANGE.min,
    max: SESSION_HISTORY_BUDGET_PCT_RANGE.max,
  },
  memoryRetrievalBudgetPct: {
    min: MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    max: MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
  },
  sessionMirrorMaxChars: { min: 32, max: 1_000_000 },
  sessionMirrorActiveWindowMs: { min: 1_000, max: 86_400_000 },
  continuityMessageLimit: { min: 1, max: 1_000 },
  extractionInterval: { min: 1, max: 50 },
  extractionThresholdPct: {
    min: EXTRACTION_THRESHOLD_PCT_RANGE.min,
    max: EXTRACTION_THRESHOLD_PCT_RANGE.max,
  },
  compactionThresholdPct: {
    min: COMPACTION_THRESHOLD_PCT_RANGE.min,
    max: COMPACTION_THRESHOLD_PCT_RANGE.max,
  },
  observationMaskingWindow: { min: 0, max: 200 },
  compactionEmotionalSalienceThresholdPct: { min: 0, max: 100 },
  thinkMaxTokens: { min: 1000, max: 1000000 },
  thinkMaxWallTimeMs: { min: 5000, max: 600000 },
  thinkMaxSubQueries: { min: 1, max: 100 },
  retryMaxAttempts: { min: 0, max: 10 },
  retryBaseDelayMs: { min: 500, max: 30000 },
  embeddingDims: { min: 1, max: 1_000_000 },
  embeddingApiDims: { min: 1, max: 1_000_000 },
  discordTriggerListenWindowMs: { min: 10_000, max: 600_000 },
  obsidianTimeoutMs: { min: 1000, max: 30000 },
  moaMaxRounds: { min: 1, max: 10 },
  moaMaxTokensPerRound: { min: 256, max: 1_000_000 },
  moaTimeoutMs: { min: 5000, max: 600_000 },
} as const;

const TEXT_EMOTION_DTYPE_VALUES = [
  'auto',
  'fp32',
  'fp16',
  'q8',
  'int8',
  'uint8',
  'q4',
  'bnb4',
  'q4f16',
] as const;
const TEXT_EMOTION_DTYPE_SET = new Set<string>(TEXT_EMOTION_DTYPE_VALUES);
const REMOVED_CONTEXT_CONTROL_FIELD_MESSAGES = {
  sessionMessageLimit:
    'sessionMessageLimit has been removed; session history now trims by token budget only',
  memoryRetrievalLimit:
    'memoryRetrievalLimit has been removed; memory retrieval now trims by token budget only',
} as const;

/** Validate and parse form data into EditableSettings. Returns [settings, errors]. */
export function parseSettingsForm(
  params: URLSearchParams,
): [EditableSettings, string[]] {
  const settings: EditableSettings = {};
  const errors: string[] = [];
  const parseCsvList = (value: string): string[] => [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  const validateHttpUrl = (field: string, value: string): void => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`${field} must use http or https`);
      }
    } catch {
      errors.push(`${field} must be a valid URL`);
    }
  };
  const validateWsUrl = (field: string, value: string): void => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        errors.push(`${field} must use ws or wss`);
      }
    } catch {
      errors.push(`${field} must be a valid URL`);
    }
  };

  const parseRoutingFields = (): void => {
    const openRouterProviderOrderRaw = params.get('openRouterProviderOrder');
    if (openRouterProviderOrderRaw !== null) {
      settings.openRouterProviderOrder = parseCsvList(
        openRouterProviderOrderRaw,
      );
    }

    const openRouterModelsApiUrlRaw = params.get('openRouterModelsApiUrl');
    if (openRouterModelsApiUrlRaw !== null) {
      const endpointUrl = openRouterModelsApiUrlRaw.trim();
      settings.openRouterModelsApiUrl = endpointUrl;
      validateHttpUrl('openRouterModelsApiUrl', endpointUrl);
    }

    const importProcessingRouteModeRaw = params.get(
      'importProcessingRouteMode',
    );
    if (importProcessingRouteModeRaw !== null) {
      const mode = toImportProcessingRouteMode(importProcessingRouteModeRaw);
      if (!mode) {
        errors.push(
          'importProcessingRouteMode must be one of: background, openrouter_zdr, local_endpoint',
        );
      } else {
        settings.importProcessingRouteMode = mode;
      }
    }

    const importProcessingStrictPolicyRaw = params.get(
      'importProcessingStrictPolicy',
    );
    if (importProcessingStrictPolicyRaw !== null) {
      const strictPolicy = toBoolean(importProcessingStrictPolicyRaw);
      if (strictPolicy === undefined) {
        errors.push('importProcessingStrictPolicy must be true or false');
      } else {
        settings.importProcessingStrictPolicy = strictPolicy;
      }
    }

    const adaptiveContextBudgetsEnabledRaw = params.get(
      'adaptiveContextBudgetsEnabled',
    );
    if (adaptiveContextBudgetsEnabledRaw !== null) {
      const enabled = toBoolean(adaptiveContextBudgetsEnabledRaw);
      if (enabled === undefined) {
        errors.push('adaptiveContextBudgetsEnabled must be true or false');
      } else {
        settings.adaptiveContextBudgetsEnabled = enabled;
      }
    }

    const moodCongruenceWeightRaw = params.get('moodCongruenceWeight');
    if (moodCongruenceWeightRaw !== null && moodCongruenceWeightRaw !== '') {
      const parsed = Number.parseFloat(moodCongruenceWeightRaw);
      if (
        !Number.isFinite(parsed) ||
        parsed < MOOD_CONGRUENCE_WEIGHT_RANGE.min ||
        parsed > MOOD_CONGRUENCE_WEIGHT_RANGE.max
      ) {
        errors.push(
          `moodCongruenceWeight must be ${MOOD_CONGRUENCE_WEIGHT_RANGE.min}-${MOOD_CONGRUENCE_WEIGHT_RANGE.max}`,
        );
      } else {
        settings.moodCongruenceWeight = parsed;
      }
    }

    const importProcessingLocalEndpointUrlRaw = params.get(
      'importProcessingLocalEndpointUrl',
    );
    if (importProcessingLocalEndpointUrlRaw !== null) {
      const endpointUrl = importProcessingLocalEndpointUrlRaw.trim();
      settings.importProcessingLocalEndpointUrl = endpointUrl;
      if (endpointUrl) {
        try {
          const parsed = new URL(endpointUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push(
              'importProcessingLocalEndpointUrl must use http or https',
            );
          }
        } catch {
          errors.push('importProcessingLocalEndpointUrl must be a valid URL');
        }
      }
    }

    const importProcessingLocalModelRaw = params.get(
      'importProcessingLocalModel',
    );
    if (importProcessingLocalModelRaw !== null) {
      settings.importProcessingLocalModel =
        importProcessingLocalModelRaw.trim();
    }
  };

  const parseEmbeddingFields = (): void => {
    const embeddingProviderRaw = params.get('embeddingProvider');
    if (embeddingProviderRaw !== null) {
      const provider = toEmbeddingProvider(embeddingProviderRaw);
      if (!provider) {
        errors.push(
          'embeddingProvider must be one of: ollama, transformers, api',
        );
      } else {
        settings.embeddingProvider = provider;
      }
    }

    const embeddingModelRaw = params.get('embeddingModel');
    if (embeddingModelRaw !== null) {
      settings.embeddingModel = embeddingModelRaw.trim();
    }

    const embeddingOllamaUrlRaw = params.get('embeddingOllamaUrl');
    if (embeddingOllamaUrlRaw !== null) {
      const endpointUrl = embeddingOllamaUrlRaw.trim();
      settings.embeddingOllamaUrl = endpointUrl;
      validateHttpUrl('embeddingOllamaUrl', endpointUrl);
    }

    const transformersModelRaw = params.get('transformersModel');
    if (transformersModelRaw !== null) {
      settings.transformersModel = transformersModelRaw.trim();
    }

    const transformersCacheDirRaw = params.get('transformersCacheDir');
    if (transformersCacheDirRaw !== null) {
      settings.transformersCacheDir = transformersCacheDirRaw.trim();
    }

    const textEmotionModelRaw = params.get('textEmotionModel');
    if (textEmotionModelRaw !== null) {
      const model = textEmotionModelRaw.trim();
      if (!model) {
        errors.push('textEmotionModel must be a non-empty string');
      } else {
        settings.textEmotionModel = model;
      }
    }

    const textEmotionCacheDirRaw = params.get('textEmotionCacheDir');
    if (textEmotionCacheDirRaw !== null) {
      settings.textEmotionCacheDir = textEmotionCacheDirRaw.trim();
    }

    const textEmotionDtypeRaw = params.get('textEmotionDtype');
    if (textEmotionDtypeRaw !== null) {
      const dtype = textEmotionDtypeRaw.trim();
      if (!TEXT_EMOTION_DTYPE_SET.has(dtype)) {
        errors.push(
          `textEmotionDtype must be one of: ${TEXT_EMOTION_DTYPE_VALUES.join(', ')}`,
        );
      } else {
        settings.textEmotionDtype =
          dtype as EditableSettings['textEmotionDtype'];
      }
    }

    const embeddingApiUrlRaw = params.get('embeddingApiUrl');
    if (embeddingApiUrlRaw !== null) {
      const endpointUrl = embeddingApiUrlRaw.trim();
      settings.embeddingApiUrl = endpointUrl;
      validateHttpUrl('embeddingApiUrl', endpointUrl);
    }

    const embeddingApiModelRaw = params.get('embeddingApiModel');
    if (embeddingApiModelRaw !== null) {
      settings.embeddingApiModel = embeddingApiModelRaw.trim();
    }
  };

  const parseWebFetchFields = (): void => {
    const webFetchAllowHttpRaw = params.get('webFetchAllowHttp');
    if (webFetchAllowHttpRaw !== null) {
      const allowHttp = toBoolean(webFetchAllowHttpRaw);
      if (allowHttp === undefined) {
        errors.push('webFetchAllowHttp must be true or false');
      } else {
        settings.webFetchAllowHttp = allowHttp;
      }
    }

    const webFetchDomainAllowlistRaw = params.get('webFetchDomainAllowlist');
    if (webFetchDomainAllowlistRaw !== null) {
      settings.webFetchDomainAllowlist = parseCsvList(
        webFetchDomainAllowlistRaw,
      );
    }

    const webFetchAllowInternalNetworkRaw = params.get(
      'webFetchAllowInternalNetwork',
    );
    if (webFetchAllowInternalNetworkRaw !== null) {
      const allow = toBoolean(webFetchAllowInternalNetworkRaw);
      if (allow === undefined) {
        errors.push('webFetchAllowInternalNetwork must be true or false');
      } else {
        settings.webFetchAllowInternalNetwork = allow;
      }
    }

    const webFetchLocalCrawlerEnabledRaw = params.get(
      'webFetchLocalCrawlerEnabled',
    );
    if (webFetchLocalCrawlerEnabledRaw !== null) {
      const enabled = toBoolean(webFetchLocalCrawlerEnabledRaw);
      if (enabled === undefined) {
        errors.push('webFetchLocalCrawlerEnabled must be true or false');
      } else {
        settings.webFetchLocalCrawlerEnabled = enabled;
      }
    }

    const webFetchLocalCrawlerAllowHttpRaw = params.get(
      'webFetchLocalCrawlerAllowHttp',
    );
    if (webFetchLocalCrawlerAllowHttpRaw !== null) {
      const allowHttp = toBoolean(webFetchLocalCrawlerAllowHttpRaw);
      if (allowHttp === undefined) {
        errors.push('webFetchLocalCrawlerAllowHttp must be true or false');
      } else {
        settings.webFetchLocalCrawlerAllowHttp = allowHttp;
      }
    }

    const webFetchLocalCrawlerHostAllowlistRaw = params.get(
      'webFetchLocalCrawlerHostAllowlist',
    );
    if (webFetchLocalCrawlerHostAllowlistRaw !== null) {
      settings.webFetchLocalCrawlerHostAllowlist = parseCsvList(
        webFetchLocalCrawlerHostAllowlistRaw,
      );
    }

    const webFetchLocalCrawlerDomainAllowlistRaw = params.get(
      'webFetchLocalCrawlerDomainAllowlist',
    );
    if (webFetchLocalCrawlerDomainAllowlistRaw !== null) {
      settings.webFetchLocalCrawlerDomainAllowlist = parseCsvList(
        webFetchLocalCrawlerDomainAllowlistRaw,
      );
    }

    const webFetchTlsCaCertPathsRaw = params.get('webFetchTlsCaCertPaths');
    if (webFetchTlsCaCertPathsRaw !== null) {
      settings.webFetchTlsCaCertPaths = parseCsvList(webFetchTlsCaCertPathsRaw);
    }
  };

  const parseGardenFields = (): void => {
    const chatApiBaseUrlRaw = params.get('chatApiBaseUrl');
    if (chatApiBaseUrlRaw !== null) {
      const endpointUrl = chatApiBaseUrlRaw.trim();
      settings.chatApiBaseUrl = endpointUrl;
      if (endpointUrl) {
        try {
          const parsed = new URL(endpointUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push('chatApiBaseUrl must use http or https');
          }
        } catch {
          errors.push('chatApiBaseUrl must be a valid URL');
        }
      }
    }

    const comfyUiBaseUrlRaw = params.get('comfyUiBaseUrl');
    if (comfyUiBaseUrlRaw !== null) {
      const endpointUrl = comfyUiBaseUrlRaw.trim();
      settings.comfyUiBaseUrl = endpointUrl;
      validateHttpUrl('comfyUiBaseUrl', endpointUrl);
    }

    const uiThemeIdRaw = params.get('uiThemeId');
    if (uiThemeIdRaw !== null) {
      settings.uiThemeId = uiThemeIdRaw.trim() || DEFAULT_UI_THEME_ID;
    }

    const capabilityTierRaw = params.get('capabilityTier');
    if (capabilityTierRaw !== null) {
      const tier = capabilityTierRaw.trim();
      if (!isCapabilityTier(tier)) {
        errors.push(
          'capabilityTier must be one of: nursery, apprentice, autonomous, custom',
        );
      } else {
        settings.capabilityTier = tier;
      }
    }

    const promotedExtendedToolsRaw = params.get('promotedExtendedTools');
    if (promotedExtendedToolsRaw !== null) {
      settings.promotedExtendedTools = parseCsvList(
        promotedExtendedToolsRaw,
      ).slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
    }

    const sessionRestartBehaviorRaw = params.get('sessionRestartBehavior');
    if (sessionRestartBehaviorRaw !== null) {
      const behavior = toSessionRestartBehavior(sessionRestartBehaviorRaw);
      if (!behavior) {
        errors.push(
          'sessionRestartBehavior must be one of: reuse_latest_session, new_session',
        );
      } else {
        settings.sessionRestartBehavior = behavior;
      }
    }

    // Voice / TTS
  };

  const parseVoiceFields = (): void => {
    const ttsProviderRaw = params.get('ttsProvider');
    if (ttsProviderRaw !== null) {
      const provider = toConfiguredTtsProvider(ttsProviderRaw);
      if (!provider) {
        errors.push(
          'ttsProvider must be "disabled" or a registered TTS provider id',
        );
      } else {
        settings.ttsProvider = provider;
      }
    }

    const voiceIdRaw = params.get('voiceId');
    if (voiceIdRaw !== null) {
      settings.voiceId = voiceIdRaw.trim();
    }

    const echoTtsUrlRaw = params.get('echoTtsUrl');
    if (echoTtsUrlRaw !== null) {
      settings.echoTtsUrl = echoTtsUrlRaw.trim();
    }

    const echoTtsVoiceRaw = params.get('echoTtsVoice');
    if (echoTtsVoiceRaw !== null) {
      settings.echoTtsVoice = echoTtsVoiceRaw.trim();
    }

    const echoTtsPresetRaw = params.get('echoTtsPreset');
    if (echoTtsPresetRaw !== null) {
      settings.echoTtsPreset = echoTtsPresetRaw.trim();
    }

    const sttProviderRaw = params.get('sttProvider');
    if (sttProviderRaw !== null) {
      const provider = toConfiguredSttProvider(sttProviderRaw);
      if (!provider) {
        errors.push(
          'sttProvider must be "disabled" or a registered STT provider id',
        );
      } else {
        settings.sttProvider = provider;
      }
    }

    const deepgramModelRaw = params.get('deepgramModel');
    if (deepgramModelRaw !== null) {
      settings.deepgramModel = deepgramModelRaw.trim();
    }

    const deepgramSttEndpointRaw = params.get('deepgramSttEndpoint');
    if (deepgramSttEndpointRaw !== null) {
      const endpointUrl = deepgramSttEndpointRaw.trim();
      settings.deepgramSttEndpoint = endpointUrl;
      validateWsUrl('deepgramSttEndpoint', endpointUrl);
    }

    const deepgramListenEndpointRaw = params.get('deepgramListenEndpoint');
    if (deepgramListenEndpointRaw !== null) {
      const endpointUrl = deepgramListenEndpointRaw.trim();
      settings.deepgramListenEndpoint = endpointUrl;
      validateHttpUrl('deepgramListenEndpoint', endpointUrl);
    }

    const elevenLabsModelIdRaw = params.get('elevenLabsModelId');
    if (elevenLabsModelIdRaw !== null) {
      settings.elevenLabsModelId = elevenLabsModelIdRaw.trim();
    }

    const elevenLabsEndpointBaseRaw = params.get('elevenLabsEndpointBase');
    if (elevenLabsEndpointBaseRaw !== null) {
      const endpointUrl = elevenLabsEndpointBaseRaw.trim();
      settings.elevenLabsEndpointBase = endpointUrl;
      validateHttpUrl('elevenLabsEndpointBase', endpointUrl);
    }
  };

  const parseChannelFields = (): void => {
    const discordTriggerWordsRaw = params.get('discordTriggerWords');
    if (discordTriggerWordsRaw !== null) {
      settings.discordTriggerWords = discordTriggerWordsRaw.trim();
    }

    const discordTriggerReactionsRaw = params.get('discordTriggerReactions');
    if (discordTriggerReactionsRaw !== null) {
      settings.discordTriggerReactions = discordTriggerReactionsRaw.trim();
    }

    const telegramEnabledRaw = params.get('telegramEnabled');
    if (telegramEnabledRaw !== null) {
      const enabled = toBoolean(telegramEnabledRaw);
      if (enabled === undefined) {
        errors.push('telegramEnabled must be true or false');
      } else {
        settings.telegramEnabled = enabled;
      }
    }

    const telegramAuthorizedUsersRaw = params.get('telegramAuthorizedUsers');
    if (telegramAuthorizedUsersRaw !== null) {
      settings.telegramAuthorizedUsers = telegramAuthorizedUsersRaw.trim();
    }
  };

  // Obsidian vault
  const parseObsidianFields = (): void => {
    const obsidianVaultNameRaw = params.get('obsidianVaultName');
    if (obsidianVaultNameRaw !== null) {
      settings.obsidianVaultName = obsidianVaultNameRaw.trim() || undefined;
    }

    const obsidianCliPathRaw = params.get('obsidianCliPath');
    if (obsidianCliPathRaw !== null) {
      settings.obsidianCliPath = obsidianCliPathRaw.trim() || 'obsidian';
    }

    const obsidianAutoPublishRaw = params.get('obsidianAutoPublish');
    if (obsidianAutoPublishRaw !== null) {
      const enabled = toBoolean(obsidianAutoPublishRaw);
      if (enabled === undefined) {
        errors.push('obsidianAutoPublish must be true or false');
      } else {
        settings.obsidianAutoPublish = enabled;
      }
    }

    // obsidianTimeoutMs is handled by SETTINGS_VALIDATION numeric loop
  };

  // MoA (Mixture of Agents)
  const parseMoaFields = (): void => {
    const moaEnabledRaw = params.get('moaEnabled');
    if (moaEnabledRaw !== null) {
      const enabled = toBoolean(moaEnabledRaw);
      if (enabled === undefined) {
        errors.push('moaEnabled must be true or false');
      } else {
        settings.moaEnabled = enabled;
      }
    }

    const moaReferenceModelsRaw = params.get('moaReferenceModels');
    if (moaReferenceModelsRaw !== null) {
      settings.moaReferenceModels = parseCsvList(moaReferenceModelsRaw);
    }

    const moaAggregatorModelRaw = params.get('moaAggregatorModel');
    if (moaAggregatorModelRaw !== null) {
      settings.moaAggregatorModel = moaAggregatorModelRaw.trim();
    }
  };

  // Numeric fields
  const parseNumericFields = (): void => {
    for (const [field, range] of Object.entries(SETTINGS_VALIDATION)) {
      const raw = params.get(field);
      if (raw === null || raw === '') continue;
      const val = Number.parseInt(raw, 10);
      if (Number.isNaN(val) || val < range.min || val > range.max) {
        errors.push(`${field} must be ${range.min}-${range.max}`);
      } else {
        (settings as Record<string, number>)[field] = val;
      }
    }
  };

  const parseRemovedContextControlFields = (): void => {
    for (const [field, message] of Object.entries(
      REMOVED_CONTEXT_CONTROL_FIELD_MESSAGES,
    )) {
      if (!params.has(field)) continue;
      errors.push(message);
    }
  };

  const parseModelRegistryJson = (): void => {
    const modelRegistryJson = params.get('modelRegistryJson')?.trim();
    if (modelRegistryJson) {
      try {
        settings.modelRegistry = normalizeCanonicalModelRegistry(
          JSON.parse(modelRegistryJson),
          'modelRegistryJson',
        );
      } catch {
        errors.push(
          'modelRegistryJson must be valid canonical model registry JSON',
        );
      }
    }
  };

  const validateCrossFieldRequirements = (): void => {
    if (settings.importProcessingRouteMode === 'local_endpoint') {
      if (!settings.importProcessingLocalEndpointUrl) {
        errors.push(
          'importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint',
        );
      }
      if (!settings.importProcessingLocalModel) {
        errors.push(
          'importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint',
        );
      }
    }

    if (settings.embeddingProvider === 'api') {
      if (!settings.embeddingApiUrl) {
        errors.push('embeddingApiUrl is required when embeddingProvider=api');
      }
      if (!settings.embeddingApiModel && !settings.embeddingModel) {
        errors.push(
          'embeddingApiModel or embeddingModel is required when embeddingProvider=api',
        );
      }
    }

    if (settings.embeddingProvider === 'ollama') {
      if (!settings.embeddingOllamaUrl) {
        errors.push(
          'embeddingOllamaUrl is required when embeddingProvider=ollama',
        );
      }
      if (!settings.embeddingModel) {
        errors.push('embeddingModel is required when embeddingProvider=ollama');
      }
    }

    if (settings.embeddingProvider === 'transformers') {
      if (!settings.transformersModel && !settings.embeddingModel) {
        errors.push(
          'transformersModel or embeddingModel is required when embeddingProvider=transformers',
        );
      }
    }

    if (settings.webFetchLocalCrawlerEnabled) {
      const hasHostAllowlist =
        (settings.webFetchLocalCrawlerHostAllowlist?.length ?? 0) > 0;
      const hasDomainAllowlist =
        (settings.webFetchLocalCrawlerDomainAllowlist?.length ?? 0) > 0;
      if (!hasHostAllowlist && !hasDomainAllowlist) {
        errors.push(
          'webFetchLocalCrawlerEnabled requires host/domain allowlist',
        );
      }
    }
  };

  parseRoutingFields();
  parseEmbeddingFields();
  parseWebFetchFields();
  parseGardenFields();
  parseVoiceFields();
  parseChannelFields();
  parseObsidianFields();
  parseMoaFields();
  parseNumericFields();
  parseRemovedContextControlFields();
  parseModelRegistryJson();
  validateCrossFieldRequirements();

  if (errors.length > 0) {
    return [settings, errors];
  }

  try {
    return [normalizeEditableSettings(settings), errors];
  } catch (error) {
    return [
      settings,
      [
        ...errors,
        error instanceof Error ? error.message : 'Invalid settings payload',
      ],
    ];
  }
}
