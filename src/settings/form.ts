import {
  DEFAULT_UI_THEME_ID,
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
} from '../types.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from '../context-budget.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import {
  toBoolean,
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
  sessionMessageLimit: { min: 5, max: 200 },
  memoryRetrievalLimit: { min: 1, max: 50 },
  extractionInterval: { min: 1, max: 50 },
  observationMaskingWindow: { min: 0, max: 200 },
  compactionEmotionalSalienceThresholdPct: { min: 0, max: 100 },
  thinkMaxTokens: { min: 1000, max: 1000000 },
  thinkMaxWallTimeMs: { min: 5000, max: 600000 },
  thinkMaxSubQueries: { min: 1, max: 100 },
  retryMaxAttempts: { min: 0, max: 10 },
  retryBaseDelayMs: { min: 500, max: 30000 },
  discordTriggerListenWindowMs: { min: 10_000, max: 600_000 },
  obsidianTimeoutMs: { min: 1000, max: 30000 },
  moaMaxRounds: { min: 1, max: 10 },
  moaMaxTokensPerRound: { min: 256, max: 1_000_000 },
  moaTimeoutMs: { min: 5000, max: 600_000 },
} as const;

/** Validate and parse form data into EditableSettings. Returns [settings, errors]. */
export function parseSettingsForm(params: URLSearchParams): [EditableSettings, string[]] {
  const settings: EditableSettings = {};
  const errors: string[] = [];
  const parseCsvList = (value: string): string[] => [...new Set(
    value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )];

  const openRouterProviderOrderRaw = params.get('openRouterProviderOrder');
  if (openRouterProviderOrderRaw !== null) {
    settings.openRouterProviderOrder = parseCsvList(openRouterProviderOrderRaw);
  }

  const importProcessingRouteModeRaw = params.get('importProcessingRouteMode');
  if (importProcessingRouteModeRaw !== null) {
    const mode = toImportProcessingRouteMode(importProcessingRouteModeRaw);
    if (!mode) {
      errors.push('importProcessingRouteMode must be one of: background, openrouter_zdr, local_endpoint');
    } else {
      settings.importProcessingRouteMode = mode;
    }
  }

  const importProcessingStrictPolicyRaw = params.get('importProcessingStrictPolicy');
  if (importProcessingStrictPolicyRaw !== null) {
    const strictPolicy = toBoolean(importProcessingStrictPolicyRaw);
    if (strictPolicy === undefined) {
      errors.push('importProcessingStrictPolicy must be true or false');
    } else {
      settings.importProcessingStrictPolicy = strictPolicy;
    }
  }

  const adaptiveContextBudgetsEnabledRaw = params.get('adaptiveContextBudgetsEnabled');
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
      !Number.isFinite(parsed)
      || parsed < MOOD_CONGRUENCE_WEIGHT_RANGE.min
      || parsed > MOOD_CONGRUENCE_WEIGHT_RANGE.max
    ) {
      errors.push(
        `moodCongruenceWeight must be ${MOOD_CONGRUENCE_WEIGHT_RANGE.min}-${MOOD_CONGRUENCE_WEIGHT_RANGE.max}`,
      );
    } else {
      settings.moodCongruenceWeight = parsed;
    }
  }

  const importProcessingLocalEndpointUrlRaw = params.get('importProcessingLocalEndpointUrl');
  if (importProcessingLocalEndpointUrlRaw !== null) {
    const endpointUrl = importProcessingLocalEndpointUrlRaw.trim();
    settings.importProcessingLocalEndpointUrl = endpointUrl;
    if (endpointUrl) {
      try {
        const parsed = new URL(endpointUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('importProcessingLocalEndpointUrl must use http or https');
        }
      } catch {
        errors.push('importProcessingLocalEndpointUrl must be a valid URL');
      }
    }
  }

  const importProcessingLocalModelRaw = params.get('importProcessingLocalModel');
  if (importProcessingLocalModelRaw !== null) {
    settings.importProcessingLocalModel = importProcessingLocalModelRaw.trim();
  }

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
    settings.webFetchDomainAllowlist = parseCsvList(webFetchDomainAllowlistRaw);
  }

  const webFetchAllowInternalNetworkRaw = params.get('webFetchAllowInternalNetwork');
  if (webFetchAllowInternalNetworkRaw !== null) {
    const allow = toBoolean(webFetchAllowInternalNetworkRaw);
    if (allow === undefined) {
      errors.push('webFetchAllowInternalNetwork must be true or false');
    } else {
      settings.webFetchAllowInternalNetwork = allow;
    }
  }

  const webFetchLocalCrawlerEnabledRaw = params.get('webFetchLocalCrawlerEnabled');
  if (webFetchLocalCrawlerEnabledRaw !== null) {
    const enabled = toBoolean(webFetchLocalCrawlerEnabledRaw);
    if (enabled === undefined) {
      errors.push('webFetchLocalCrawlerEnabled must be true or false');
    } else {
      settings.webFetchLocalCrawlerEnabled = enabled;
    }
  }

  const webFetchLocalCrawlerAllowHttpRaw = params.get('webFetchLocalCrawlerAllowHttp');
  if (webFetchLocalCrawlerAllowHttpRaw !== null) {
    const allowHttp = toBoolean(webFetchLocalCrawlerAllowHttpRaw);
    if (allowHttp === undefined) {
      errors.push('webFetchLocalCrawlerAllowHttp must be true or false');
    } else {
      settings.webFetchLocalCrawlerAllowHttp = allowHttp;
    }
  }

  const webFetchLocalCrawlerHostAllowlistRaw = params.get('webFetchLocalCrawlerHostAllowlist');
  if (webFetchLocalCrawlerHostAllowlistRaw !== null) {
    settings.webFetchLocalCrawlerHostAllowlist = parseCsvList(webFetchLocalCrawlerHostAllowlistRaw);
  }

  const webFetchLocalCrawlerDomainAllowlistRaw = params.get('webFetchLocalCrawlerDomainAllowlist');
  if (webFetchLocalCrawlerDomainAllowlistRaw !== null) {
    settings.webFetchLocalCrawlerDomainAllowlist = parseCsvList(webFetchLocalCrawlerDomainAllowlistRaw);
  }

  const webFetchTlsCaCertPathsRaw = params.get('webFetchTlsCaCertPaths');
  if (webFetchTlsCaCertPathsRaw !== null) {
    settings.webFetchTlsCaCertPaths = parseCsvList(webFetchTlsCaCertPathsRaw);
  }

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

  const uiThemeIdRaw = params.get('uiThemeId');
  if (uiThemeIdRaw !== null) {
    settings.uiThemeId = uiThemeIdRaw.trim() || DEFAULT_UI_THEME_ID;
  }

  const capabilityTierRaw = params.get('capabilityTier');
  if (capabilityTierRaw !== null) {
    const tier = capabilityTierRaw.trim();
    if (!isCapabilityTier(tier)) {
      errors.push('capabilityTier must be one of: nursery, apprentice, autonomous, custom');
    } else {
      settings.capabilityTier = tier;
    }
  }

  const promotedExtendedToolsRaw = params.get('promotedExtendedTools');
  if (promotedExtendedToolsRaw !== null) {
    settings.promotedExtendedTools = parseCsvList(promotedExtendedToolsRaw)
      .slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
  }

  const sessionRestartBehaviorRaw = params.get('sessionRestartBehavior');
  if (sessionRestartBehaviorRaw !== null) {
    const behavior = toSessionRestartBehavior(sessionRestartBehaviorRaw);
    if (!behavior) {
      errors.push('sessionRestartBehavior must be one of: reuse_latest_session, new_session');
    } else {
      settings.sessionRestartBehavior = behavior;
    }
  }

  // Voice / TTS
  const ttsProviderRaw = params.get('ttsProvider');
  if (ttsProviderRaw !== null) {
    const provider = toConfiguredTtsProvider(ttsProviderRaw);
    if (!provider) {
      errors.push('ttsProvider must be "disabled" or a registered TTS provider id');
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
      errors.push('sttProvider must be "disabled" or a registered STT provider id');
    } else {
      settings.sttProvider = provider;
    }
  }

  const deepgramModelRaw = params.get('deepgramModel');
  if (deepgramModelRaw !== null) {
    settings.deepgramModel = deepgramModelRaw.trim();
  }

  // Channels
  const discordEnabledRaw = params.get('discordEnabled');
  if (discordEnabledRaw !== null) {
    const enabled = toBoolean(discordEnabledRaw);
    if (enabled === undefined) {
      errors.push('discordEnabled must be true or false');
    } else {
      settings.discordEnabled = enabled;
    }
  }

  const discordHeartbeatChannelRaw = params.get('discordHeartbeatChannel');
  if (discordHeartbeatChannelRaw !== null) {
    settings.discordHeartbeatChannel = discordHeartbeatChannelRaw.trim();
  }

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

  // Obsidian vault
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

  // MoA (Mixture of Agents)
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

  // Numeric fields
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

  const modelRegistryJson = params.get('modelRegistryJson')?.trim();
  if (modelRegistryJson) {
    try {
      settings.modelRegistry = normalizeCanonicalModelRegistry(
        JSON.parse(modelRegistryJson),
        'modelRegistryJson',
      );
    } catch {
      errors.push('modelRegistryJson must be valid canonical model registry JSON');
    }
  }

  if (settings.importProcessingRouteMode === 'local_endpoint') {
    if (!settings.importProcessingLocalEndpointUrl) {
      errors.push('importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint');
    }
    if (!settings.importProcessingLocalModel) {
      errors.push('importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint');
    }
  }

  if (settings.webFetchLocalCrawlerEnabled) {
    const hasHostAllowlist = (settings.webFetchLocalCrawlerHostAllowlist?.length ?? 0) > 0;
    const hasDomainAllowlist = (settings.webFetchLocalCrawlerDomainAllowlist?.length ?? 0) > 0;
    if (!hasHostAllowlist && !hasDomainAllowlist) {
      errors.push('webFetchLocalCrawlerEnabled requires host/domain allowlist');
    }
  }

  if (errors.length > 0) {
    return [settings, errors];
  }

  try {
    return [normalizeEditableSettings(settings), errors];
  } catch (error) {
    return [settings, [...errors, error instanceof Error ? error.message : 'Invalid settings payload']];
  }
}
