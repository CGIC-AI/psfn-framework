// ── Persistent Editable Settings ──
// Subset of SubstrateConfig that can be changed at runtime via admin GUI.
// Persisted to data/settings.json (runtime-owned domain fields only).
// Loaded at startup, merged over env defaults.

import { join } from 'node:path';
import {
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
  type CapabilityTier,
  type ImportProcessingRouteMode,
  type ModelCatalogEntry,
  type ModelContextBudgetConfig,
  type ModelPurpose,
  type ModelRoleAssignments,
  type SessionRestartBehavior,
  type ModelSlot,
  type ModelSlotDefaults,
  type ModelSlotOverrides,
  type SubstrateConfig,
} from './types.js';
import { createComponentLogger } from './logger.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudgetPct,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from './context-budget.js';
import { loadOrSeedJson, writeJsonAtomic } from './config/load-or-seed.js';
import { isRecord } from './utils/types.js';
import { isCapabilityTier } from './capabilities/tiers.js';

const log = createComponentLogger('Settings');

const SETTINGS_FILE = 'settings.json';
const SETTINGS_SEED_FILE = 'settings.seed.json';
const PRIMARY_MODEL_SLOT_KEY = 'primary';
const EXTRACTION_MODEL_SLOT_KEY = 'extraction';
const KNOWN_MODEL_PURPOSES: ModelPurpose[] = ['chat', 'background', 'reasoning', 'longContext', 'vision'];
const IMPORT_PROCESSING_ROUTE_MODE_VALUES = new Set<ImportProcessingRouteMode>([
  'background',
  'openrouter_zdr',
  'local_endpoint',
]);
const SESSION_RESTART_BEHAVIOR_VALUES = new Set<SessionRestartBehavior>([
  'reuse_latest_session',
  'new_session',
]);

export const MODEL_SLOT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

const MODEL_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'modelCatalog',
  'modelRoleAssignments',
  'modelRoster',
];

const NON_RUNTIME_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  ...MODEL_SETTINGS_KEYS,
  'maintenanceIntervalMs',
  'capabilityTier',
];

export interface SettingsDomainSplit {
  runtime: EditableSettings;
  models: EditableSettings;
  maintenanceIntervalMs?: number;
  capabilityTier?: CapabilityTier;
  legacyKeys: string[];
}

export const DEFAULT_MODEL_ROLE_ASSIGNMENTS: Readonly<ModelRoleAssignments> = {
  chat: PRIMARY_MODEL_SLOT_KEY,
  background: EXTRACTION_MODEL_SLOT_KEY,
  extraction: EXTRACTION_MODEL_SLOT_KEY,
  summary: PRIMARY_MODEL_SLOT_KEY,
  reasoning: PRIMARY_MODEL_SLOT_KEY,
  longContext: PRIMARY_MODEL_SLOT_KEY,
  vision: PRIMARY_MODEL_SLOT_KEY,
  import_processing: EXTRACTION_MODEL_SLOT_KEY,
};

export interface EditableSettings {
  primaryModel?: string;
  primaryProvider?: string;
  extractionModel?: string;
  extractionProvider?: string;
  primaryMaxTokens?: number;
  extractionMaxTokens?: number;
  modelCatalog?: Record<string, ModelCatalogEntry>;
  modelRoleAssignments?: ModelRoleAssignments;
  modelRoster?: Partial<Record<ModelPurpose, ModelSlot>>;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  memoryRetrievalLimit?: number;
  extractionInterval?: number;
  maintenanceIntervalMs?: number;
  defaultContextWindow?: number;
  memoryBudgetPct?: number;
  extractionThresholdPct?: number;
  compactionThresholdPct?: number;
  compactionEmotionalSalienceThresholdPct?: number;
  memoryExtractionMinImportance?: number;
  memoryExtractionMinConfidence?: number;
  memoryExtractionMinNovelty?: number;
  memoryExtractionMaxWrites?: number;
  memoryExtractionTelemetryEnabled?: boolean;
  memoryRetrievalTelemetryEnabled?: boolean;
  profileSynthesisEnabled?: boolean;
  profileSynthesisRefreshIntervalMs?: number;
  profileSynthesisCooldownMs?: number;
  profileSynthesisMinWrites?: number;
  profileSynthesisMinImportance?: number;
  profileSynthesisMinConfidence?: number;
  profileSynthesisMinNovelty?: number;
  profileSynthesisSourceMemoryLimit?: number;
  profileSynthesisMinSourceMemories?: number;
  thinkMaxTokens?: number;
  thinkMaxWallTimeMs?: number;
  thinkMaxSubQueries?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  openRouterProviderOrder?: string[];
  importProcessingRouteMode?: ImportProcessingRouteMode;
  importProcessingStrictPolicy?: boolean;
  importProcessingLocalEndpointUrl?: string;
  importProcessingLocalModel?: string;
  webFetchAllowHttp?: boolean;
  webFetchDomainAllowlist?: string[];
  webFetchAllowInternalNetwork?: boolean;
  /** @deprecated Use webFetchAllowInternalNetwork + webFetchDomainAllowlist instead */
  webFetchLocalCrawlerEnabled?: boolean;
  /** @deprecated Use webFetchAllowHttp instead */
  webFetchLocalCrawlerAllowHttp?: boolean;
  /** @deprecated Use webFetchDomainAllowlist instead */
  webFetchLocalCrawlerHostAllowlist?: string[];
  /** @deprecated Use webFetchDomainAllowlist instead */
  webFetchLocalCrawlerDomainAllowlist?: string[];
  webFetchTlsCaCertPaths?: string[];
  capabilityTier?: CapabilityTier;
  promotedExtendedTools?: string[];
  /** Override the base URL used by Garden Chat to reach the OpenAI-compatible API.
   *  When set, this takes priority over the `API_BASE_URL` env var and the
   *  auto-resolved URL derived from `API_HOST`/`API_PORT`. Useful when the
   *  API server is behind a reverse proxy or on a non-standard URL. */
  chatApiBaseUrl?: string;

  // Voice / TTS (non-secret config only — API keys stay in .env)
  ttsProvider?: 'elevenlabs' | 'echo' | 'disabled';
  voiceId?: string;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  sttProvider?: 'deepgram' | 'disabled';
  deepgramModel?: string;

  // Channel configuration (non-secret — bot tokens stay in .env)
  discordEnabled?: boolean;
  discordHeartbeatChannel?: string;
  discordTriggerWords?: string;
  discordTriggerReactions?: string;
  discordTriggerListenWindowMs?: number;
  telegramEnabled?: boolean;
  telegramAuthorizedUsers?: string;

  // Obsidian vault
  obsidianVaultName?: string;
  obsidianCliPath?: string;
  obsidianAutoPublish?: boolean;
  obsidianTimeoutMs?: number;

  // MoA (Mixture of Agents) configuration
  moaEnabled?: boolean;
  moaReferenceModels?: string[];
  moaAggregatorModel?: string;
  moaMaxRounds?: number;
  moaMaxTokensPerRound?: number;
  moaTimeoutMs?: number;
}

export const RUNTIME_SETTINGS_KEYS = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'sessionHistoryBudgetPct',
  'memoryRetrievalBudgetPct',
  'sessionMessageLimit',
  'sessionRestartBehavior',
  'memoryRetrievalLimit',
  'extractionInterval',
  'maintenanceIntervalMs',
  'defaultContextWindow',
  'memoryBudgetPct',
  'extractionThresholdPct',
  'compactionThresholdPct',
  'compactionEmotionalSalienceThresholdPct',
  'thinkMaxTokens',
  'thinkMaxWallTimeMs',
  'thinkMaxSubQueries',
  'retryMaxAttempts',
  'retryBaseDelayMs',
  'openRouterProviderOrder',
  'importProcessingRouteMode',
  'importProcessingStrictPolicy',
  'importProcessingLocalEndpointUrl',
  'importProcessingLocalModel',
  'webFetchAllowHttp',
  'webFetchDomainAllowlist',
  'webFetchAllowInternalNetwork',
  'webFetchLocalCrawlerEnabled',
  'webFetchLocalCrawlerAllowHttp',
  'webFetchLocalCrawlerHostAllowlist',
  'webFetchLocalCrawlerDomainAllowlist',
  'webFetchTlsCaCertPaths',
  'capabilityTier',
  'promotedExtendedTools',
  'chatApiBaseUrl',
  // Voice / TTS
  'ttsProvider',
  'voiceId',
  'echoTtsUrl',
  'echoTtsVoice',
  'echoTtsPreset',
  'sttProvider',
  'deepgramModel',
  // Channels
  'discordEnabled',
  'discordHeartbeatChannel',
  'discordTriggerWords',
  'discordTriggerReactions',
  'discordTriggerListenWindowMs',
  'telegramEnabled',
  'telegramAuthorizedUsers',
  // Obsidian vault
  'obsidianVaultName',
  'obsidianCliPath',
  'obsidianAutoPublish',
  'obsidianTimeoutMs',
  // MoA (Mixture of Agents)
  'moaEnabled',
  'moaReferenceModels',
  'moaAggregatorModel',
  'moaMaxRounds',
  'moaMaxTokensPerRound',
  'moaTimeoutMs',
] as const;

export type RuntimeSettingKey = typeof RUNTIME_SETTINGS_KEYS[number];
export type RuntimeSettingValue = string | number | boolean | null | string[];
export type RuntimeSettingsSnapshot = Record<RuntimeSettingKey, RuntimeSettingValue>;

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function toIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = Number.isInteger(value) ? value : undefined;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const candidate = Number.parseInt(trimmed, 10);
    parsed = Number.isInteger(candidate) ? candidate : undefined;
  }

  if (parsed === undefined) return undefined;
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = [...new Set(value
    .map(entry => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean))];
  return cleaned;
}

function toPromotedToolList(value: unknown): string[] {
  return (toStringList(value) ?? []).slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

const TTS_PROVIDER_VALUES = new Set(['elevenlabs', 'echo', 'disabled']);
const STT_PROVIDER_VALUES = new Set(['deepgram', 'disabled']);
type RuntimeVoiceTtsProvider = 'elevenlabs' | 'echo' | 'disabled';
type RuntimeVoiceSttProvider = 'deepgram' | 'disabled';

function toTtsProvider(value: unknown): 'elevenlabs' | 'echo' | 'disabled' | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!TTS_PROVIDER_VALUES.has(trimmed)) return undefined;
  return trimmed as 'elevenlabs' | 'echo' | 'disabled';
}

function toSttProvider(value: unknown): 'deepgram' | 'disabled' | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!STT_PROVIDER_VALUES.has(trimmed)) return undefined;
  return trimmed as 'deepgram' | 'disabled';
}

function resolveRuntimeTtsProvider(config: SubstrateConfig): RuntimeVoiceTtsProvider {
  const provider = (config as SubstrateConfig & { ttsProvider?: RuntimeVoiceTtsProvider }).ttsProvider;
  if (provider === 'elevenlabs' || provider === 'echo') return provider;
  return 'disabled';
}

function resolveRuntimeSttProvider(config: SubstrateConfig): RuntimeVoiceSttProvider {
  const configured = (config as SubstrateConfig & { sttProvider?: RuntimeVoiceSttProvider }).sttProvider;
  if (configured === 'deepgram' || configured === 'disabled') return configured;
  return config.deepgramApiKey ? 'deepgram' : 'disabled';
}

function toImportProcessingRouteMode(value: unknown): ImportProcessingRouteMode | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!IMPORT_PROCESSING_ROUTE_MODE_VALUES.has(trimmed as ImportProcessingRouteMode)) return undefined;
  return trimmed as ImportProcessingRouteMode;
}

function toSessionRestartBehavior(value: unknown): SessionRestartBehavior | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!SESSION_RESTART_BEHAVIOR_VALUES.has(trimmed as SessionRestartBehavior)) return undefined;
  return trimmed as SessionRestartBehavior;
}

function sanitizeModelContextBudget(value: unknown): ModelContextBudgetConfig | undefined {
  if (!isRecord(value)) return undefined;
  const sessionHistoryMinTokens = toPositiveInteger(value.sessionHistoryMinTokens);
  const memoryRetrievalMinTokens = toPositiveInteger(value.memoryRetrievalMinTokens);
  if (sessionHistoryMinTokens === undefined && memoryRetrievalMinTokens === undefined) {
    return undefined;
  }
  return {
    ...(sessionHistoryMinTokens !== undefined ? { sessionHistoryMinTokens } : {}),
    ...(memoryRetrievalMinTokens !== undefined ? { memoryRetrievalMinTokens } : {}),
  };
}

function sanitizeModelSlotDefaults(value: unknown): ModelSlotDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const maxTokens = toPositiveInteger(value.maxTokens);
  const contextWindow = toPositiveInteger(value.contextWindow);
  const contextBudget = sanitizeModelContextBudget(value.contextBudget);
  const description = toNonEmptyString(value.description);
  if (maxTokens === undefined && contextWindow === undefined && contextBudget === undefined && description === undefined) {
    return undefined;
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function sanitizeModelSlotOverrides(value: unknown): ModelSlotOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const maxTokens = toPositiveInteger(value.maxTokens);
  const contextWindow = toPositiveInteger(value.contextWindow);
  const contextBudget = sanitizeModelContextBudget(value.contextBudget);
  if (maxTokens === undefined && contextWindow === undefined && contextBudget === undefined) {
    return undefined;
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  };
}

function sanitizeModelCatalog(value: unknown): Record<string, ModelCatalogEntry> {
  if (!isRecord(value)) return {};
  const catalog: Record<string, ModelCatalogEntry> = {};
  for (const [rawSlotKey, rawEntry] of Object.entries(value)) {
    const slotKey = rawSlotKey.trim();
    if (!slotKey || !MODEL_SLOT_KEY_PATTERN.test(slotKey) || !isRecord(rawEntry)) continue;

    let model = toNonEmptyString(rawEntry.model);
    let provider = toNonEmptyString(rawEntry.provider);

    // Accept "openrouter/<model-id>" shorthand and normalize to canonical
    // provider + model fields so settings PATCH round-trips do not drift.
    if (model && (!provider || provider.length === 0) && model.toLowerCase().startsWith('openrouter/')) {
      const normalizedModel = model.slice('openrouter/'.length).trim();
      if (normalizedModel) {
        model = normalizedModel;
        provider = 'openrouter';
      }
    } else if (model && provider?.toLowerCase() === 'openrouter' && model.toLowerCase().startsWith('openrouter/')) {
      const normalizedModel = model.slice('openrouter/'.length).trim();
      if (normalizedModel) {
        model = normalizedModel;
      }
    }

    if (!model || !provider) continue;

    const defaults = sanitizeModelSlotDefaults(rawEntry.defaults);
    const overrides = sanitizeModelSlotOverrides(rawEntry.overrides);

    catalog[slotKey] = {
      model,
      provider,
      ...(defaults ? { defaults } : {}),
      ...(overrides ? { overrides } : {}),
    };
  }
  return catalog;
}

function sanitizeModelRoleAssignments(value: unknown): ModelRoleAssignments {
  if (!isRecord(value)) return {};
  const assignments: ModelRoleAssignments = {};
  for (const [rawPurpose, rawSlotKey] of Object.entries(value)) {
    const purpose = rawPurpose.trim();
    const slotKey = toNonEmptyString(rawSlotKey);
    if (!purpose || !slotKey || !MODEL_SLOT_KEY_PATTERN.test(slotKey)) continue;
    assignments[purpose] = slotKey;
  }
  return assignments;
}

function sanitizeModelRoster(value: unknown): Partial<Record<ModelPurpose, ModelSlot>> {
  if (!isRecord(value)) return {};
  const roster: Partial<Record<ModelPurpose, ModelSlot>> = {};

  for (const purpose of KNOWN_MODEL_PURPOSES) {
    const candidate = value[purpose];
    if (!isRecord(candidate)) continue;

    const model = toNonEmptyString(candidate.model);
    const provider = toNonEmptyString(candidate.provider);
    const maxTokens = toPositiveInteger(candidate.maxTokens);
    const contextWindow = toPositiveInteger(candidate.contextWindow);
    const contextBudget = sanitizeModelContextBudget(candidate.contextBudget);
    if (!model || !provider || maxTokens === undefined) continue;

    roster[purpose] = {
      model,
      provider,
      maxTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(contextBudget !== undefined ? { contextBudget } : {}),
    };
  }

  return roster;
}

function mergeCatalogSlot(
  catalog: Record<string, ModelCatalogEntry>,
  slotKey: string,
  slot: {
    model?: string;
    provider?: string;
    maxTokens?: number;
    contextWindow?: number;
    contextBudget?: ModelContextBudgetConfig;
  },
): void {
  const model = toNonEmptyString(slot.model);
  const provider = toNonEmptyString(slot.provider);
  if (!model || !provider || !MODEL_SLOT_KEY_PATTERN.test(slotKey)) return;

  const existing = catalog[slotKey];
  const merged: ModelCatalogEntry = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    ...(existing ?? {}),
    model,
    provider,
  };

  const overrides: ModelSlotOverrides = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    ...(existing?.overrides ?? {}),
  };
  if (slot.maxTokens !== undefined) overrides.maxTokens = slot.maxTokens;
  if (slot.contextWindow !== undefined) overrides.contextWindow = slot.contextWindow;
  if (slot.contextBudget !== undefined) overrides.contextBudget = slot.contextBudget;
  merged.overrides = Object.keys(overrides).length > 0 ? overrides : undefined;

  catalog[slotKey] = merged;
}

function defaultSlotKeyForPurpose(purpose: string): string {
  if (purpose === 'background' || purpose === 'extraction') {
    return EXTRACTION_MODEL_SLOT_KEY;
  }
  if (purpose === 'chat' || purpose === 'summary' || purpose === 'reasoning' || purpose === 'longContext') {
    return PRIMARY_MODEL_SLOT_KEY;
  }
  return purpose;
}

function resolveCatalogSlotKey(
  catalog: Record<string, ModelCatalogEntry>,
  assignments: ModelRoleAssignments,
  purpose: string,
  fallbackSlotKey?: string,
): string | undefined {
  const candidates = [
    assignments[purpose],
    purpose === 'background' ? assignments.extraction : undefined,
    purpose === 'extraction' ? assignments.background : undefined,
    fallbackSlotKey,
    defaultSlotKeyForPurpose(purpose),
    assignments.chat,
    PRIMARY_MODEL_SLOT_KEY,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    if (catalog[candidate]) return candidate;
  }

  const firstCatalogSlot = Object.keys(catalog)[0];
  return firstCatalogSlot;
}

function modelSlotFromCatalogEntry(
  entry: ModelCatalogEntry,
  fallback: { maxTokens?: number; contextWindow?: number; contextBudget?: ModelContextBudgetConfig },
): ModelSlot | undefined {
  const maxTokens = entry.overrides?.maxTokens
    ?? entry.defaults?.maxTokens
    ?? fallback.maxTokens;
  if (maxTokens === undefined) return undefined;

  const contextWindow = entry.overrides?.contextWindow
    ?? entry.defaults?.contextWindow
    ?? fallback.contextWindow;
  const contextBudget = entry.overrides?.contextBudget
    ?? entry.defaults?.contextBudget
    ?? fallback.contextBudget;

  return {
    model: entry.model,
    provider: entry.provider,
    maxTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  };
}

function resolvePurposeSlot(
  catalog: Record<string, ModelCatalogEntry>,
  assignments: ModelRoleAssignments,
  purpose: string,
  fallback: { maxTokens?: number; contextWindow?: number; contextBudget?: ModelContextBudgetConfig },
  fallbackSlotKey?: string,
): ModelSlot | undefined {
  const slotKey = resolveCatalogSlotKey(catalog, assignments, purpose, fallbackSlotKey);
  if (!slotKey) return undefined;
  const entry = catalog[slotKey];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record<string,T> hides runtime undefined
  if (!entry) return undefined;
  return modelSlotFromCatalogEntry(entry, fallback);
}

function normalizeContextControlSettings(settings: EditableSettings): EditableSettings {
  const normalized: EditableSettings = { ...settings };

  const sessionLimit = toIntegerInRange(settings.sessionMessageLimit, 5, 200);
  if (sessionLimit !== undefined) {
    normalized.sessionMessageLimit = sessionLimit;
  } else {
    delete normalized.sessionMessageLimit;
  }

  const retrievalLimit = toIntegerInRange(settings.memoryRetrievalLimit, 1, 50);
  if (retrievalLimit !== undefined) {
    normalized.memoryRetrievalLimit = retrievalLimit;
  } else {
    delete normalized.memoryRetrievalLimit;
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

  if ('openRouterProviderOrder' in settings) {
    normalized.openRouterProviderOrder = toStringList(settings.openRouterProviderOrder) ?? [];
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

  if ('chatApiBaseUrl' in settings) {
    normalized.chatApiBaseUrl = typeof settings.chatApiBaseUrl === 'string'
      ? settings.chatApiBaseUrl.trim()
      : '';
  }

  // Voice / TTS
  if ('ttsProvider' in settings) {
    normalized.ttsProvider = toTtsProvider(settings.ttsProvider) ?? 'disabled';
  }
  if ('voiceId' in settings) {
    normalized.voiceId = typeof settings.voiceId === 'string' ? settings.voiceId.trim() : '';
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
    normalized.sttProvider = toSttProvider(settings.sttProvider) ?? 'disabled';
  }
  if ('deepgramModel' in settings) {
    normalized.deepgramModel = typeof settings.deepgramModel === 'string' ? settings.deepgramModel.trim() : '';
  }

  // Channels
  if ('discordEnabled' in settings) {
    normalized.discordEnabled = toBoolean(settings.discordEnabled) ?? false;
  }
  if ('discordHeartbeatChannel' in settings) {
    const trimmed = typeof settings.discordHeartbeatChannel === 'string' ? settings.discordHeartbeatChannel.trim() : '';
    normalized.discordHeartbeatChannel = trimmed || undefined;
  }
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

export function hasModelSettings(settings: EditableSettings): boolean {
  return MODEL_SETTINGS_KEYS.some((key) => settings[key] !== undefined);
}

export function extractModelSettings(settings: EditableSettings): EditableSettings {
  const modelSettings: EditableSettings = {};
  for (const key of MODEL_SETTINGS_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    (modelSettings as Record<string, unknown>)[key] = value;
  }
  return modelSettings;
}

export function splitSettingsByDomain(settings: EditableSettings): SettingsDomainSplit {
  const runtime: EditableSettings = { ...settings };
  for (const key of NON_RUNTIME_SETTINGS_KEYS) {
    delete runtime[key];
  }

  const legacyKeys: string[] = [];
  for (const key of NON_RUNTIME_SETTINGS_KEYS) {
    if (settings[key] !== undefined) {
      legacyKeys.push(key);
    }
  }

  return {
    runtime,
    models: extractModelSettings(settings),
    ...(settings.maintenanceIntervalMs !== undefined
      ? { maintenanceIntervalMs: settings.maintenanceIntervalMs }
      : {}),
    ...(settings.capabilityTier !== undefined
      ? { capabilityTier: settings.capabilityTier }
      : {}),
    legacyKeys,
  };
}

export function toRuntimeOwnedSettings(settings: EditableSettings): EditableSettings {
  return splitSettingsByDomain(settings).runtime;
}

export function normalizeEditableSettings(
  settings: EditableSettings,
  options?: { defaultContextWindow?: number },
): EditableSettings {
  const normalizedInput = normalizeContextControlSettings(settings);

  if (!hasModelSettings(normalizedInput)) {
    return { ...normalizedInput };
  }

  const normalized: EditableSettings = { ...normalizedInput };
  const explicitCatalog = sanitizeModelCatalog(normalizedInput.modelCatalog);
  const catalog: Record<string, ModelCatalogEntry> = { ...explicitCatalog };
  const assignments = sanitizeModelRoleAssignments(normalizedInput.modelRoleAssignments);
  const roster = sanitizeModelRoster(normalizedInput.modelRoster);

  for (const [purpose, slot] of Object.entries(roster) as Array<[ModelPurpose, ModelSlot]>) {
    const slotKey = assignments[purpose] ?? defaultSlotKeyForPurpose(purpose);
    assignments[purpose] = slotKey;
    mergeCatalogSlot(catalog, slotKey, {
      model: slot.model,
      provider: slot.provider,
      maxTokens: slot.maxTokens,
      contextWindow: slot.contextWindow,
      contextBudget: slot.contextBudget,
    });
  }

  mergeCatalogSlot(catalog, PRIMARY_MODEL_SLOT_KEY, {
    model: normalizedInput.primaryModel,
    provider: normalizedInput.primaryProvider,
    maxTokens: normalizedInput.primaryMaxTokens,
    contextWindow: roster.chat?.contextWindow ?? options?.defaultContextWindow,
    contextBudget: roster.chat?.contextBudget,
  });
  mergeCatalogSlot(catalog, EXTRACTION_MODEL_SLOT_KEY, {
    model: normalizedInput.extractionModel,
    provider: normalizedInput.extractionProvider,
    maxTokens: normalizedInput.extractionMaxTokens,
  });

  // Explicit modelCatalog payload must win over inferred/legacy/roster merges.
  // This prevents stale modelRoster entries from rewriting operator-selected slots.
  const hasPrimaryLegacyOverride = normalizedInput.primaryModel !== undefined
    || normalizedInput.primaryProvider !== undefined
    || normalizedInput.primaryMaxTokens !== undefined;
  const hasExtractionLegacyOverride = normalizedInput.extractionModel !== undefined
    || normalizedInput.extractionProvider !== undefined
    || normalizedInput.extractionMaxTokens !== undefined;
  for (const [slotKey, explicitEntry] of Object.entries(explicitCatalog)) {
    if (slotKey === PRIMARY_MODEL_SLOT_KEY && hasPrimaryLegacyOverride) continue;
    if (slotKey === EXTRACTION_MODEL_SLOT_KEY && hasExtractionLegacyOverride) continue;

    const existing = catalog[slotKey];
    catalog[slotKey] = {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
      ...(existing ?? {}),
      model: explicitEntry.model,
      provider: explicitEntry.provider,
      ...(explicitEntry.defaults ? { defaults: explicitEntry.defaults } : {}),
      ...(explicitEntry.overrides ? { overrides: explicitEntry.overrides } : {}),
    };
  }

  assignments.chat ||= PRIMARY_MODEL_SLOT_KEY;
  assignments.summary ||= assignments.chat;
  assignments.reasoning ||= assignments.chat;
  assignments.longContext ||= assignments.chat;
  assignments.background ||= EXTRACTION_MODEL_SLOT_KEY;
  assignments.extraction ||= assignments.background;
  assignments.import_processing ||= assignments.background;
  if (!assignments.vision) {
    assignments.vision = 'vision';
  }

  for (const [purpose, slotKey] of Object.entries(assignments)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    if (!catalog[slotKey]) {
      delete assignments[purpose];
    }
  }

  const chatSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'chat',
    {
      maxTokens: normalizedInput.primaryMaxTokens,
      contextWindow: roster.chat?.contextWindow ?? options?.defaultContextWindow,
      contextBudget: roster.chat?.contextBudget,
    },
    PRIMARY_MODEL_SLOT_KEY,
  );

  const extractionSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'extraction',
    {
      maxTokens: normalizedInput.extractionMaxTokens ?? normalizedInput.primaryMaxTokens,
    },
    assignments.background,
  );

  const backgroundSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'background',
    {
      maxTokens: extractionSlot?.maxTokens ?? normalizedInput.extractionMaxTokens ?? normalizedInput.primaryMaxTokens,
    },
    assignments.extraction,
  );

  const reasoningSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'reasoning',
    {
      maxTokens: chatSlot?.maxTokens ?? normalizedInput.primaryMaxTokens,
      contextWindow: chatSlot?.contextWindow ?? options?.defaultContextWindow,
      contextBudget: chatSlot?.contextBudget,
    },
    assignments.chat,
  );

  const longContextSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'longContext',
    {
      maxTokens: chatSlot?.maxTokens ?? normalizedInput.primaryMaxTokens,
      contextWindow: chatSlot?.contextWindow ?? options?.defaultContextWindow,
      contextBudget: chatSlot?.contextBudget,
    },
    assignments.chat,
  );

  const visionSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'vision',
    {
      maxTokens: chatSlot?.maxTokens ?? normalizedInput.primaryMaxTokens,
      contextWindow: chatSlot?.contextWindow ?? options?.defaultContextWindow,
      contextBudget: chatSlot?.contextBudget,
    },
    assignments.vision,
  );

  const nextRoster: Partial<Record<ModelPurpose, ModelSlot>> = {
    ...roster,
  };
  if (chatSlot) nextRoster.chat = chatSlot;
  if (backgroundSlot) nextRoster.background = backgroundSlot;
  if (reasoningSlot) nextRoster.reasoning = reasoningSlot;
  if (longContextSlot) nextRoster.longContext = longContextSlot;
  if (visionSlot) nextRoster.vision = visionSlot;

  if (chatSlot) {
    normalized.primaryModel = chatSlot.model;
    normalized.primaryProvider = chatSlot.provider;
    normalized.primaryMaxTokens = chatSlot.maxTokens;
  }
  if (extractionSlot) {
    normalized.extractionModel = extractionSlot.model;
    normalized.extractionProvider = extractionSlot.provider;
    normalized.extractionMaxTokens = extractionSlot.maxTokens;
  }

  if (Object.keys(catalog).length > 0) {
    normalized.modelCatalog = catalog;
  }
  if (Object.keys(assignments).length > 0) {
    normalized.modelRoleAssignments = assignments;
  }
  if (Object.keys(nextRoster).length > 0) {
    normalized.modelRoster = nextRoster;
  }

  return normalized;
}

function mergeModelSettingsWithConfig(config: SubstrateConfig, settings: EditableSettings): EditableSettings {
  const hasStructuredModelInputs = settings.modelCatalog !== undefined
    || settings.modelRoleAssignments !== undefined
    || settings.modelRoster !== undefined;

  return {
    primaryModel: hasStructuredModelInputs ? settings.primaryModel : (settings.primaryModel ?? config.primaryModel),
    primaryProvider: hasStructuredModelInputs ? settings.primaryProvider : (settings.primaryProvider ?? config.primaryProvider),
    extractionModel: hasStructuredModelInputs ? settings.extractionModel : (settings.extractionModel ?? config.extractionModel),
    extractionProvider: hasStructuredModelInputs ? settings.extractionProvider : (settings.extractionProvider ?? config.extractionProvider),
    primaryMaxTokens: hasStructuredModelInputs ? settings.primaryMaxTokens : (settings.primaryMaxTokens ?? config.primaryMaxTokens),
    extractionMaxTokens: hasStructuredModelInputs ? settings.extractionMaxTokens : (settings.extractionMaxTokens ?? config.extractionMaxTokens),
    modelCatalog: settings.modelCatalog ?? config.modelCatalog,
    modelRoleAssignments: settings.modelRoleAssignments ?? config.modelRoleAssignments,
    modelRoster: settings.modelRoster,
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
    sessionMessageLimit: config.sessionMessageLimit ?? null,
    sessionRestartBehavior: config.sessionRestartBehavior ?? 'reuse_latest_session',
    memoryRetrievalLimit: config.memoryRetrievalLimit ?? null,
    extractionInterval: config.extractionInterval,
    maintenanceIntervalMs: config.maintenanceIntervalMs,
    defaultContextWindow: config.defaultContextWindow,
    memoryBudgetPct: config.memoryBudgetPct,
    extractionThresholdPct: config.extractionThresholdPct,
    compactionThresholdPct: config.compactionThresholdPct,
    compactionEmotionalSalienceThresholdPct: config.compactionEmotionalSalienceThresholdPct ?? 75,
    thinkMaxTokens: config.thinkMaxTokens ?? null,
    thinkMaxWallTimeMs: config.thinkMaxWallTimeMs ?? null,
    thinkMaxSubQueries: config.thinkMaxSubQueries ?? null,
    retryMaxAttempts: config.retryMaxAttempts ?? null,
    retryBaseDelayMs: config.retryBaseDelayMs ?? null,
    openRouterProviderOrder: config.openRouterProviderOrder ?? [],
    importProcessingRouteMode: config.importProcessingRouteMode ?? 'background',
    importProcessingStrictPolicy: config.importProcessingStrictPolicy ?? false,
    importProcessingLocalEndpointUrl: config.importProcessingLocalEndpointUrl ?? null,
    importProcessingLocalModel: config.importProcessingLocalModel ?? null,
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
    // Voice / TTS
    ttsProvider: resolveRuntimeTtsProvider(config),
    voiceId: config.elevenLabsVoiceId ?? '',
    echoTtsUrl: config.echoTtsUrl ?? '',
    echoTtsVoice: config.echoTtsVoice ?? '',
    echoTtsPreset: config.echoTtsPreset ?? '',
    sttProvider: resolveRuntimeSttProvider(config),
    deepgramModel: config.deepgramModel ?? 'nova-3',
    // Channels
    discordEnabled: Boolean(config.discordToken),
    discordHeartbeatChannel: null,
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

/** Load saved settings from data/settings.json, seeding from config/settings.seed.json when missing/corrupt. */
export function loadSettings(
  dataDir: string,
  options?: { seedDir?: string },
): EditableSettings {
  const path = join(dataDir, SETTINGS_FILE);
  const seedDir = options?.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const seedPath = join(seedDir, SETTINGS_SEED_FILE);

  const loaded = loadOrSeedJson({
    dataPath: path,
    seedPath,
    validate: (raw, sourcePath) => {
      if (!isRecord(raw)) {
        throw new Error(`Invalid settings file format at ${sourcePath}`);
      }
      return normalizeEditableSettings(raw as EditableSettings);
    },
  });

  log.info('Loaded saved settings');
  return loaded;
}

/** Atomic write: write to .tmp then rename. */
export function saveSettings(dataDir: string, settings: EditableSettings): void {
  const path = join(dataDir, SETTINGS_FILE);
  const normalized = normalizeEditableSettings(settings);
  const split = splitSettingsByDomain(normalized);
  writeJsonAtomic(path, split.runtime);
  if (split.legacyKeys.length > 0) {
    log.warn('Dropped non-runtime keys while saving settings.json', {
      keys: split.legacyKeys,
    });
  }
  log.info('Saved settings');
}

/** Mutate config in place with defined settings values. */
export function applySettings(config: SubstrateConfig, settings: EditableSettings): void {
  if (settings.sessionHistoryBudgetPct !== undefined) {
    config.sessionHistoryBudgetPct = settings.sessionHistoryBudgetPct;
  }
  if (settings.memoryRetrievalBudgetPct !== undefined) {
    config.memoryRetrievalBudgetPct = settings.memoryRetrievalBudgetPct;
  }
  if (settings.sessionMessageLimit !== undefined) config.sessionMessageLimit = settings.sessionMessageLimit;
  if ('sessionRestartBehavior' in settings) {
    const behavior = settings.sessionRestartBehavior;
    config.sessionRestartBehavior = behavior === 'new_session' ? 'new_session' : 'reuse_latest_session';
  }
  if (settings.memoryRetrievalLimit !== undefined) config.memoryRetrievalLimit = settings.memoryRetrievalLimit;
  if (settings.extractionInterval !== undefined) config.extractionInterval = settings.extractionInterval;
  if (settings.compactionEmotionalSalienceThresholdPct !== undefined) {
    config.compactionEmotionalSalienceThresholdPct = settings.compactionEmotionalSalienceThresholdPct;
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

  // Voice / TTS
  if ('ttsProvider' in settings) {
    const provider = settings.ttsProvider;
    const voiceConfig = config as SubstrateConfig & { ttsProvider?: RuntimeVoiceTtsProvider };
    if (provider === 'elevenlabs' || provider === 'echo' || provider === 'disabled') {
      voiceConfig.ttsProvider = provider;
    } else {
      voiceConfig.ttsProvider = undefined;
    }
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
    const provider = settings.sttProvider;
    const voiceConfig = config as SubstrateConfig & { sttProvider?: RuntimeVoiceSttProvider };
    if (provider === 'deepgram' || provider === 'disabled') {
      voiceConfig.sttProvider = provider;
    } else {
      voiceConfig.sttProvider = undefined;
    }
  }
  if ('deepgramModel' in settings) {
    const trimmed = settings.deepgramModel?.trim() ?? '';
    config.deepgramModel = trimmed || undefined;
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

  const shouldSyncModels = hasModelSettings(settings)
    || config.modelCatalog !== undefined
    || config.modelRoleAssignments !== undefined;

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

  if (normalized.modelRoster !== undefined) config.modelRoster = normalized.modelRoster;
  if (normalized.modelCatalog !== undefined) config.modelCatalog = normalized.modelCatalog;
  if (normalized.modelRoleAssignments !== undefined) {
    config.modelRoleAssignments = normalized.modelRoleAssignments;
  }
}

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

  // String fields
  const primaryModel = params.get('primaryModel')?.trim();
  if (primaryModel) settings.primaryModel = primaryModel;

  const primaryProvider = params.get('primaryProvider')?.trim();
  if (primaryProvider) settings.primaryProvider = primaryProvider;

  const extractionModel = params.get('extractionModel')?.trim();
  if (extractionModel) settings.extractionModel = extractionModel;

  const extractionProvider = params.get('extractionProvider')?.trim();
  if (extractionProvider) settings.extractionProvider = extractionProvider;

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
    const provider = toTtsProvider(ttsProviderRaw);
    if (!provider) {
      errors.push('ttsProvider must be one of: elevenlabs, echo, disabled');
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
    const provider = toSttProvider(sttProviderRaw);
    if (!provider) {
      errors.push('sttProvider must be one of: deepgram, disabled');
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

  const modelCatalogJson = params.get('modelCatalogJson')?.trim();
  if (modelCatalogJson) {
    try {
      const parsed = JSON.parse(modelCatalogJson);
      if (!isRecord(parsed)) {
        errors.push('modelCatalogJson must be a JSON object');
      } else {
        const catalog = sanitizeModelCatalog(parsed);
        if (Object.keys(catalog).length === 0) {
          errors.push('modelCatalogJson must include at least one valid slot');
        } else {
          settings.modelCatalog = catalog;
        }
      }
    } catch {
      errors.push('modelCatalogJson must be valid JSON');
    }
  }

  const modelRoleAssignmentsJson = params.get('modelRoleAssignmentsJson')?.trim();
  if (modelRoleAssignmentsJson) {
    try {
      const parsed = JSON.parse(modelRoleAssignmentsJson);
      if (!isRecord(parsed)) {
        errors.push('modelRoleAssignmentsJson must be a JSON object');
      } else {
        const assignments = sanitizeModelRoleAssignments(parsed);
        if (Object.keys(assignments).length === 0) {
          errors.push('modelRoleAssignmentsJson must include at least one valid purpose mapping');
        } else {
          settings.modelRoleAssignments = assignments;
        }
      }
    } catch {
      errors.push('modelRoleAssignmentsJson must be valid JSON');
    }
  }

  if (settings.modelCatalog && settings.modelRoleAssignments) {
    for (const [purpose, slotKey] of Object.entries(settings.modelRoleAssignments)) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
      if (!settings.modelCatalog[slotKey]) {
        errors.push(`purpose "${purpose}" references unknown model slot "${slotKey}"`);
      }
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

  return [normalizeEditableSettings(settings), errors];
}
