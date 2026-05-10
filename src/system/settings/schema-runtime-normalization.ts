import {
  DEFAULT_UI_THEME_ID,
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
} from '../config/runtime-config-contracts.js';
import { normalizeImageWorkflowSettings } from '../../primitives/images/types.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from '../../shared/context-budget.js';
import { normalizeCompositionalPolicyConfig } from '../capabilities/compositional-policy.js';
import { isRecord } from '../../shared/utils/types.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import {
  normalizeSttProvider,
  normalizeTtsProvider,
  toEmbeddingProvider,
  toBoolean,
  toImportProcessingRouteMode,
  toIntegerInRange,
  toNonEmptyString,
  toNumberInRange,
  toPositiveInteger,
  toSessionRestartBehavior,
  toStringList,
} from './coercion.js';
import {
  COMPACTION_THRESHOLD_PCT_RANGE,
  EXTRACTION_THRESHOLD_PCT_RANGE,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  type EditableSettings,
} from './contracts.js';

export function toPromotedToolList(value: unknown): string[] {
  return (toStringList(value) ?? []).slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
}

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

function normalizeTextEmotionDtype(value: unknown): EditableSettings['textEmotionDtype'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!TEXT_EMOTION_DTYPE_SET.has(normalized)) {
    return undefined;
  }
  return normalized as EditableSettings['textEmotionDtype'];
}

function normalizeBooleanMap(
  value: unknown,
  fieldPath: string,
): Record<string, boolean> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }

  const parsed: Record<string, boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    const normalized = toBoolean(rawValue);
    if (normalized === undefined) {
      throw new Error(`Invalid settings at ${fieldPath}.${rawKey}: expected boolean`);
    }
    parsed[key] = normalized;
  }

  return parsed;
}

function normalizeWyomingShardRoutingConfig(
  value: unknown,
  fieldPath: string,
): EditableSettings['wyomingShardRouting'] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }

  const enabled = value.enabled === undefined
    ? false
    : toBoolean(value.enabled);
  if (enabled === undefined) {
    throw new Error(`Invalid settings at ${fieldPath}.enabled: expected boolean`);
  }

  const parseAllowlist = (name: 'siteAllowlist' | 'satelliteAllowlist'): string[] | undefined => {
    const raw = value[name];
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      throw new Error(`Invalid settings at ${fieldPath}.${name}: expected array of strings`);
    }
    return toStringList(raw) ?? [];
  };

  const siteAllowlist = parseAllowlist('siteAllowlist');
  const satelliteAllowlist = parseAllowlist('satelliteAllowlist');

  return {
    enabled,
    ...(siteAllowlist ? { siteAllowlist } : {}),
    ...(satelliteAllowlist ? { satelliteAllowlist } : {}),
  };
}

function normalizeShardToolsetConfig(
  value: unknown,
  fieldPath: string,
): EditableSettings['shardToolsets'] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }

  const parsed: NonNullable<EditableSettings['shardToolsets']> = {};
  for (const tier of ['nursery', 'apprentice', 'autonomous', 'custom'] as const) {
    const raw = value[tier];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      throw new Error(`Invalid settings at ${fieldPath}.${tier}: expected array of strings`);
    }
    parsed[tier] = toStringList(raw) ?? [];
  }

  return parsed;
}

export function normalizeContextControlSettings(settings: EditableSettings): EditableSettings {
  const normalized: EditableSettings = { ...settings };
  for (const key of REMOVED_RUNTIME_SETTINGS_KEYS) {
    delete (normalized as Record<string, unknown>)[key];
  }

  const sessionBudgetPct = toIntegerInRange(
    settings.sessionHistoryBudgetPct,
    SESSION_HISTORY_BUDGET_PCT_RANGE.min,
    SESSION_HISTORY_BUDGET_PCT_RANGE.max,
  );
  if (sessionBudgetPct !== undefined) {
    normalized.sessionHistoryBudgetPct = sessionBudgetPct;
  } else {
    delete normalized.sessionHistoryBudgetPct;
  }

  const retrievalBudgetPct = toIntegerInRange(
    settings.memoryRetrievalBudgetPct,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
  );
  if (retrievalBudgetPct !== undefined) {
    normalized.memoryRetrievalBudgetPct = retrievalBudgetPct;
  } else {
    delete normalized.memoryRetrievalBudgetPct;
  }

  const extractionThresholdPct = toIntegerInRange(
    settings.extractionThresholdPct,
    EXTRACTION_THRESHOLD_PCT_RANGE.min,
    EXTRACTION_THRESHOLD_PCT_RANGE.max,
  );
  if (extractionThresholdPct !== undefined) {
    normalized.extractionThresholdPct = extractionThresholdPct;
  } else {
    delete normalized.extractionThresholdPct;
  }

  const compactionThresholdPct = toIntegerInRange(
    settings.compactionThresholdPct,
    COMPACTION_THRESHOLD_PCT_RANGE.min,
    COMPACTION_THRESHOLD_PCT_RANGE.max,
  );
  if (compactionThresholdPct !== undefined) {
    normalized.compactionThresholdPct = compactionThresholdPct;
  } else {
    delete normalized.compactionThresholdPct;
  }

  const moodCongruenceWeight = toNumberInRange(
    settings.moodCongruenceWeight,
    MOOD_CONGRUENCE_WEIGHT_RANGE.min,
    MOOD_CONGRUENCE_WEIGHT_RANGE.max,
  );
  if (moodCongruenceWeight !== undefined) {
    normalized.moodCongruenceWeight = moodCongruenceWeight;
  } else {
    delete normalized.moodCongruenceWeight;
  }

  if ('adaptiveContextBudgetsEnabled' in settings) {
    const adaptiveContextBudgetsEnabled = toBoolean(settings.adaptiveContextBudgetsEnabled);
    if (adaptiveContextBudgetsEnabled !== undefined) {
      normalized.adaptiveContextBudgetsEnabled = adaptiveContextBudgetsEnabled;
    } else {
      delete normalized.adaptiveContextBudgetsEnabled;
    }
  }

  const emotionalSalienceThresholdPct = toIntegerInRange(
    settings.compactionEmotionalSalienceThresholdPct,
    0,
    100,
  );
  if (emotionalSalienceThresholdPct !== undefined) {
    normalized.compactionEmotionalSalienceThresholdPct = emotionalSalienceThresholdPct;
  } else {
    delete normalized.compactionEmotionalSalienceThresholdPct;
  }

  const observationMaskingWindow = toIntegerInRange(
    settings.observationMaskingWindow,
    0,
    200,
  );
  if (observationMaskingWindow !== undefined) {
    normalized.observationMaskingWindow = observationMaskingWindow;
  } else {
    delete normalized.observationMaskingWindow;
  }

  if ('openRouterProviderOrder' in settings) {
    normalized.openRouterProviderOrder = toStringList(settings.openRouterProviderOrder) ?? [];
  }

  if ('openRouterModelsApiUrl' in settings) {
    normalized.openRouterModelsApiUrl = typeof settings.openRouterModelsApiUrl === 'string'
      ? settings.openRouterModelsApiUrl.trim()
      : '';
  }

  const profileSynthesisSourceMemoryLimit = toPositiveInteger(settings.profileSynthesisSourceMemoryLimit);
  const profileSynthesisMinSourceMemories = toPositiveInteger(settings.profileSynthesisMinSourceMemories);
  if (profileSynthesisMinSourceMemories !== undefined) {
    normalized.profileSynthesisMinSourceMemories = profileSynthesisMinSourceMemories;
  } else {
    delete normalized.profileSynthesisMinSourceMemories;
  }
  if (
    profileSynthesisSourceMemoryLimit !== undefined
    || profileSynthesisMinSourceMemories !== undefined
  ) {
    const effectiveSourceMemoryLimit = profileSynthesisSourceMemoryLimit !== undefined
      && profileSynthesisMinSourceMemories !== undefined
      ? Math.max(profileSynthesisSourceMemoryLimit, profileSynthesisMinSourceMemories)
      : profileSynthesisSourceMemoryLimit;
    if (effectiveSourceMemoryLimit !== undefined) {
      normalized.profileSynthesisSourceMemoryLimit = effectiveSourceMemoryLimit;
    } else {
      delete normalized.profileSynthesisSourceMemoryLimit;
    }
  }

  if ('importProcessingRouteMode' in settings) {
    normalized.importProcessingRouteMode = toImportProcessingRouteMode(settings.importProcessingRouteMode);
  }

  if ('importProcessingStrictPolicy' in settings) {
    normalized.importProcessingStrictPolicy = toBoolean(settings.importProcessingStrictPolicy) ?? false;
  }

  if ('importProcessingLocalEndpointUrl' in settings) {
    normalized.importProcessingLocalEndpointUrl =
      typeof settings.importProcessingLocalEndpointUrl === 'string'
        ? settings.importProcessingLocalEndpointUrl.trim()
        : '';
  }

  if ('importProcessingLocalModel' in settings) {
    normalized.importProcessingLocalModel =
      typeof settings.importProcessingLocalModel === 'string'
        ? settings.importProcessingLocalModel.trim()
        : '';
  }

  if ('embeddingProvider' in settings) {
    const provider = toEmbeddingProvider(settings.embeddingProvider);
    if (provider) {
      normalized.embeddingProvider = provider;
    } else {
      delete normalized.embeddingProvider;
    }
  }

  if ('embeddingModel' in settings) {
    normalized.embeddingModel = typeof settings.embeddingModel === 'string'
      ? settings.embeddingModel.trim()
      : '';
  }

  if ('embeddingDims' in settings) {
    normalized.embeddingDims = toPositiveInteger(settings.embeddingDims);
  }

  if ('embeddingOllamaUrl' in settings) {
    normalized.embeddingOllamaUrl = typeof settings.embeddingOllamaUrl === 'string'
      ? settings.embeddingOllamaUrl.trim()
      : '';
  }

  if ('transformersModel' in settings) {
    normalized.transformersModel = typeof settings.transformersModel === 'string'
      ? settings.transformersModel.trim()
      : '';
  }

  if ('transformersCacheDir' in settings) {
    normalized.transformersCacheDir = typeof settings.transformersCacheDir === 'string'
      ? settings.transformersCacheDir.trim()
      : '';
  }

  if ('textEmotionModel' in settings) {
    const textEmotionModel = toNonEmptyString(settings.textEmotionModel);
    if (textEmotionModel === undefined) {
      throw new Error('textEmotionModel must be a non-empty string');
    }
    normalized.textEmotionModel = textEmotionModel;
  }

  if ('textEmotionCacheDir' in settings) {
    normalized.textEmotionCacheDir = typeof settings.textEmotionCacheDir === 'string'
      ? settings.textEmotionCacheDir.trim()
      : '';
  }

  if ('textEmotionDtype' in settings) {
    const textEmotionDtype = normalizeTextEmotionDtype(settings.textEmotionDtype);
    if (textEmotionDtype === undefined) {
      throw new Error(
        `textEmotionDtype must be one of: ${TEXT_EMOTION_DTYPE_VALUES.join(', ')}`,
      );
    }
    normalized.textEmotionDtype = textEmotionDtype;
  }

  if ('embeddingApiUrl' in settings) {
    normalized.embeddingApiUrl = typeof settings.embeddingApiUrl === 'string'
      ? settings.embeddingApiUrl.trim()
      : '';
  }

  if ('embeddingApiModel' in settings) {
    normalized.embeddingApiModel = typeof settings.embeddingApiModel === 'string'
      ? settings.embeddingApiModel.trim()
      : '';
  }

  if ('embeddingApiDims' in settings) {
    normalized.embeddingApiDims = toPositiveInteger(settings.embeddingApiDims);
  }

  if ('compositionalPolicy' in settings) {
    normalized.compositionalPolicy = normalizeCompositionalPolicyConfig(settings.compositionalPolicy);
  }

  if ('webFetchAllowHttp' in settings) {
    normalized.webFetchAllowHttp = toBoolean(settings.webFetchAllowHttp) ?? false;
  }

  if ('webFetchDomainAllowlist' in settings) {
    normalized.webFetchDomainAllowlist = toStringList(settings.webFetchDomainAllowlist) ?? [];
  }

  if ('webFetchAllowInternalNetwork' in settings) {
    normalized.webFetchAllowInternalNetwork = toBoolean(settings.webFetchAllowInternalNetwork) ?? false;
  }

  if ('webFetchLocalCrawlerEnabled' in settings) {
    normalized.webFetchLocalCrawlerEnabled = toBoolean(settings.webFetchLocalCrawlerEnabled) ?? false;
  }

  if ('webFetchLocalCrawlerAllowHttp' in settings) {
    normalized.webFetchLocalCrawlerAllowHttp = toBoolean(settings.webFetchLocalCrawlerAllowHttp) ?? false;
  }

  if ('webFetchLocalCrawlerHostAllowlist' in settings) {
    normalized.webFetchLocalCrawlerHostAllowlist =
      toStringList(settings.webFetchLocalCrawlerHostAllowlist) ?? [];
  }

  if ('webFetchLocalCrawlerDomainAllowlist' in settings) {
    normalized.webFetchLocalCrawlerDomainAllowlist =
      toStringList(settings.webFetchLocalCrawlerDomainAllowlist) ?? [];
  }

  if ('webFetchTlsCaCertPaths' in settings) {
    normalized.webFetchTlsCaCertPaths = toStringList(settings.webFetchTlsCaCertPaths) ?? [];
  }

  if ('capabilityTier' in settings) {
    const tier = settings.capabilityTier;
    if (tier !== undefined && isCapabilityTier(tier)) {
      normalized.capabilityTier = tier;
    } else {
      delete normalized.capabilityTier;
    }
  }

  if ('promotedExtendedTools' in settings) {
    normalized.promotedExtendedTools = toPromotedToolList(settings.promotedExtendedTools);
  }

  if ('sessionRestartBehavior' in settings) {
    const behavior = toSessionRestartBehavior(settings.sessionRestartBehavior);
    if (behavior) {
      normalized.sessionRestartBehavior = behavior;
    } else {
      delete normalized.sessionRestartBehavior;
    }
  }

  if ('sessionMirrorEnabled' in settings) {
    normalized.sessionMirrorEnabled = toBoolean(settings.sessionMirrorEnabled) ?? false;
  }
  if ('sessionMirrorMaxChars' in settings) {
    normalized.sessionMirrorMaxChars = toIntegerInRange(settings.sessionMirrorMaxChars, 32, 1_000_000);
  }
  if ('sessionMirrorActiveWindowMs' in settings) {
    normalized.sessionMirrorActiveWindowMs = toIntegerInRange(
      settings.sessionMirrorActiveWindowMs,
      1_000,
      86_400_000,
    );
  }
  if ('sessionMirrorChannelOverrides' in settings) {
    normalized.sessionMirrorChannelOverrides = normalizeBooleanMap(
      settings.sessionMirrorChannelOverrides,
      'sessionMirrorChannelOverrides',
    );
  }
  if ('continuityMessageLimit' in settings) {
    normalized.continuityMessageLimit = toIntegerInRange(settings.continuityMessageLimit, 1, 1_000);
  }

  if ('chatApiBaseUrl' in settings) {
    normalized.chatApiBaseUrl = typeof settings.chatApiBaseUrl === 'string'
      ? settings.chatApiBaseUrl.trim()
      : '';
  }

  if ('comfyUiBaseUrl' in settings) {
    normalized.comfyUiBaseUrl = typeof settings.comfyUiBaseUrl === 'string'
      ? settings.comfyUiBaseUrl.trim()
      : '';
  }

  if ('imageWorkflows' in settings) {
    normalized.imageWorkflows = normalizeImageWorkflowSettings(settings.imageWorkflows);
  }

  if ('uiThemeId' in settings) {
    normalized.uiThemeId = toNonEmptyString(settings.uiThemeId) ?? DEFAULT_UI_THEME_ID;
  }

  // Voice / TTS
  if ('voiceEnabled' in settings) {
    normalized.voiceEnabled = toBoolean(settings.voiceEnabled) ?? false;
  }
  if ('ttsProvider' in settings) {
    const provider = normalizeTtsProvider(settings.ttsProvider);
    if (provider !== undefined) {
      normalized.ttsProvider = provider;
    } else {
      delete normalized.ttsProvider;
    }
  }
  if ('voiceId' in settings) {
    normalized.voiceId = typeof settings.voiceId === 'string' ? settings.voiceId.trim() : '';
  }
  if ('voiceTargetGuildId' in settings) {
    normalized.voiceTargetGuildId = typeof settings.voiceTargetGuildId === 'string'
      ? settings.voiceTargetGuildId.trim()
      : '';
  }
  if ('voiceTargetUserId' in settings) {
    normalized.voiceTargetUserId = typeof settings.voiceTargetUserId === 'string'
      ? settings.voiceTargetUserId.trim()
      : '';
  }
  if ('voiceReadyCueText' in settings) {
    normalized.voiceReadyCueText = typeof settings.voiceReadyCueText === 'string'
      ? settings.voiceReadyCueText.trim()
      : '';
  }
  if ('echoTtsUrl' in settings) {
    normalized.echoTtsUrl = typeof settings.echoTtsUrl === 'string' ? settings.echoTtsUrl.trim() : '';
  }
  if ('echoTtsVoice' in settings) {
    normalized.echoTtsVoice = typeof settings.echoTtsVoice === 'string' ? settings.echoTtsVoice.trim() : '';
  }
  if ('echoTtsPreset' in settings) {
    normalized.echoTtsPreset = typeof settings.echoTtsPreset === 'string' ? settings.echoTtsPreset.trim() : '';
  }
  if ('sttProvider' in settings) {
    const provider = normalizeSttProvider(settings.sttProvider);
    if (provider !== undefined) {
      normalized.sttProvider = provider;
    } else {
      delete normalized.sttProvider;
    }
  }
  if ('deepgramModel' in settings) {
    normalized.deepgramModel = typeof settings.deepgramModel === 'string' ? settings.deepgramModel.trim() : '';
  }
  if ('deepgramSttEndpoint' in settings) {
    normalized.deepgramSttEndpoint =
      typeof settings.deepgramSttEndpoint === 'string' ? settings.deepgramSttEndpoint.trim() : '';
  }
  if ('deepgramListenEndpoint' in settings) {
    normalized.deepgramListenEndpoint =
      typeof settings.deepgramListenEndpoint === 'string' ? settings.deepgramListenEndpoint.trim() : '';
  }
  if ('elevenLabsModelId' in settings) {
    normalized.elevenLabsModelId =
      typeof settings.elevenLabsModelId === 'string' ? settings.elevenLabsModelId.trim() : '';
  }
  if ('elevenLabsEndpointBase' in settings) {
    normalized.elevenLabsEndpointBase =
      typeof settings.elevenLabsEndpointBase === 'string' ? settings.elevenLabsEndpointBase.trim() : '';
  }

  if ('wyomingShardRouting' in settings) {
    normalized.wyomingShardRouting = normalizeWyomingShardRoutingConfig(
      settings.wyomingShardRouting,
      'wyomingShardRouting',
    );
  }
  if ('shardToolsets' in settings) {
    normalized.shardToolsets = normalizeShardToolsetConfig(settings.shardToolsets, 'shardToolsets');
  }

  // Channels
  if ('discordTriggerWords' in settings) {
    const trimmed = typeof settings.discordTriggerWords === 'string' ? settings.discordTriggerWords.trim() : '';
    normalized.discordTriggerWords = trimmed || undefined;
  }
  if ('discordTriggerReactions' in settings) {
    const trimmed = typeof settings.discordTriggerReactions === 'string' ? settings.discordTriggerReactions.trim() : '';
    normalized.discordTriggerReactions = trimmed || undefined;
  }
  if ('discordTriggerListenWindowMs' in settings) {
    normalized.discordTriggerListenWindowMs = toIntegerInRange(
      settings.discordTriggerListenWindowMs,
      10_000,
      600_000,
    );
  }
  if ('telegramEnabled' in settings) {
    normalized.telegramEnabled = toBoolean(settings.telegramEnabled) ?? false;
  }
  if ('telegramAuthorizedUsers' in settings) {
    const trimmed = typeof settings.telegramAuthorizedUsers === 'string' ? settings.telegramAuthorizedUsers.trim() : '';
    normalized.telegramAuthorizedUsers = trimmed || undefined;
  }

  // Obsidian vault
  if ('obsidianVaultName' in settings) {
    normalized.obsidianVaultName = toNonEmptyString(settings.obsidianVaultName);
  }
  if ('obsidianCliPath' in settings) {
    normalized.obsidianCliPath = toNonEmptyString(settings.obsidianCliPath) ?? 'obsidian';
  }
  if ('obsidianAutoPublish' in settings) {
    normalized.obsidianAutoPublish = toBoolean(settings.obsidianAutoPublish) ?? false;
  }
  if ('obsidianTimeoutMs' in settings) {
    normalized.obsidianTimeoutMs = toIntegerInRange(settings.obsidianTimeoutMs, 1000, 30000);
  }

  // MoA (Mixture of Agents)
  if ('moaEnabled' in settings) {
    normalized.moaEnabled = toBoolean(settings.moaEnabled) ?? false;
  }
  if ('moaReferenceModels' in settings) {
    normalized.moaReferenceModels = toStringList(settings.moaReferenceModels) ?? [];
  }
  if ('moaAggregatorModel' in settings) {
    const trimmed = typeof settings.moaAggregatorModel === 'string' ? settings.moaAggregatorModel.trim() : '';
    normalized.moaAggregatorModel = trimmed || undefined;
  }

  return normalized;
}
