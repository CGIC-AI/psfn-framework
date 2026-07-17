import {
  SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
  SETTINGS_GARDEN_RAW_EDITOR_KEYS,
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
  type GardenSettingsRawEditorKey,
} from '../../../../src/shared/contracts/settings-garden-contract.js';
import type {
  AdminSettingsData,
  CanonicalProviderRegistry,
} from '$lib/types';
import { SETTINGS_ADVANCED_SECTIONS } from './settings-section-definitions';
import { resolveVoiceProviderSelection } from './voice-provider-selection';

export const DISABLED_PROVIDER_ID = 'disabled';
export const COMPOSITIONAL_TIER_OPTIONS = ['nursery', 'apprentice', 'autonomous', 'custom'] as const;
export const COMPOSITIONAL_CHANNEL_TYPE_OPTIONS = ['discord', 'terminal', 'api', 'telegram'] as const;
export const COMPOSITIONAL_PURPOSE_OPTIONS = [
  'extraction',
  'retrieval',
  'appraisal',
  'analysis_workbench',
  'shard_context',
] as const;

export type CompositionalListKey = 'allowedTiers' | 'allowedChannelTypes' | 'allowedPurposes';

export interface CompositionalPolicyFormValue {
  enabled: boolean;
  allowedTiers: string[];
  allowedChannelTypes: string[];
  allowedPurposes: string[];
}

const ENUM_LABELS_BY_FIELD: Record<string, Record<string, string>> = {
  importProcessingRouteMode: {
    background: 'Background Routing (default)',
    openrouter_zdr: 'OpenRouter ZDR-only',
    local_endpoint: 'Local Endpoint Only',
  },
  sessionRestartBehavior: {
    reuse_latest_session: 'Reuse latest session',
    new_session: 'Always start a new session',
  },
};

export type RawEditorKey = GardenSettingsRawEditorKey;
type RawSettingsEditorKey = Exclude<RawEditorKey, 'settings' | 'models'>;
export type RawEditorSubsystemId =
  (typeof SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY)[RawEditorKey];

export const RAW_EDITORS = SETTINGS_GARDEN_RAW_EDITOR_KEYS
  .filter(
    (key): key is RawSettingsEditorKey => (
      key !== 'settings' && key !== 'models'
    ),
  )
  .map((key) => ({ key }));

export function buildRawEditorJsonMap(
  resolveValue: (key: RawEditorKey) => string,
): Record<RawEditorKey, string> {
  return Object.fromEntries(
    SETTINGS_GARDEN_RAW_EDITOR_KEYS.map((key) => [key, resolveValue(key)]),
  ) as Record<RawEditorKey, string>;
}

export function listDirtyRawEditorKeys(
  current: Record<RawEditorKey, string>,
  initial: Record<RawEditorKey, string>,
): RawEditorKey[] {
  return SETTINGS_GARDEN_RAW_EDITOR_KEYS.filter(
    key => current[key] !== initial[key],
  );
}

// Owner files the unified save writes from structured form state. A dirty raw
// editor for any of these keys excludes that file from the unified save so
// form-derived JSON never stomps staged hand edits.
export const UNIFIED_SAVE_OWNER_FILE_KEYS = [
  'providers',
  'scheduler',
  'capabilities',
  'backup',
] as const satisfies readonly RawEditorKey[];

export type UnifiedSaveOwnerFileKey = (typeof UNIFIED_SAVE_OWNER_FILE_KEYS)[number];

export function listUnifiedSaveSkippedOwnerFiles(
  dirtyKeys: readonly RawEditorKey[],
): UnifiedSaveOwnerFileKey[] {
  const dirty = new Set<RawEditorKey>(dirtyKeys);
  return UNIFIED_SAVE_OWNER_FILE_KEYS.filter(key => dirty.has(key));
}

// Post-reload editor contents: dirty raw editors keep the user's staged text
// across a server-state reload; clean editors refresh from the server.
export function resolveReloadedRawJsonByKey(input: {
  serverJsonByKey: Record<RawEditorKey, string>;
  stagedJsonByKey: Record<RawEditorKey, string>;
  dirtyKeys: readonly RawEditorKey[];
}): Record<RawEditorKey, string> {
  const dirty = new Set<RawEditorKey>(input.dirtyKeys);
  return Object.fromEntries(
    SETTINGS_GARDEN_RAW_EDITOR_KEYS.map((key) => [
      key,
      dirty.has(key) ? input.stagedJsonByKey[key] : input.serverJsonByKey[key],
    ]),
  ) as Record<RawEditorKey, string>;
}

// Rebasing after a save/reload must NOT mark preserved dirty editors clean:
// their baseline stays at the pre-edit value so they keep comparing dirty.
export function rebaselineRawJsonByKey(input: {
  currentJsonByKey: Record<RawEditorKey, string>;
  initialJsonByKey: Record<RawEditorKey, string>;
  preservedKeys: readonly RawEditorKey[];
}): Record<RawEditorKey, string> {
  const preserved = new Set<RawEditorKey>(input.preservedKeys);
  return Object.fromEntries(
    SETTINGS_GARDEN_RAW_EDITOR_KEYS.map((key) => [
      key,
      preserved.has(key) ? input.initialJsonByKey[key] : input.currentJsonByKey[key],
    ]),
  ) as Record<RawEditorKey, string>;
}

export function resolveRawEditorOwnerFile(
  key: RawEditorKey,
  resolveSubsystemOwnerFile: (subsystemId: RawEditorSubsystemId) => string | undefined,
): string {
  const subsystemId = SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY[key];
  return resolveSubsystemOwnerFile(subsystemId) ?? SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY[key];
}

export function humanizeSettingValue(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatSettingOptionLabel(field: string, value: string): string {
  return ENUM_LABELS_BY_FIELD[field]?.[value] ?? humanizeSettingValue(value);
}

export function settingControlId(key: string, suffix = 'input'): string {
  return `settings-${key.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}-${suffix}`;
}

export function settingLabelId(key: string): string {
  return settingControlId(key, 'label');
}

export function summarizeCompositionalPolicy(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Disabled';
  }

  const policy = value as {
    enabled?: unknown;
    allowedTiers?: unknown;
    allowedChannelTypes?: unknown;
    allowedPurposes?: unknown;
  };
  if (policy.enabled !== true) {
    return 'Disabled';
  }

  const tierCount = Array.isArray(policy.allowedTiers) ? policy.allowedTiers.length : 0;
  const channelCount = Array.isArray(policy.allowedChannelTypes) ? policy.allowedChannelTypes.length : 0;
  const purposeCount = Array.isArray(policy.allowedPurposes) ? policy.allowedPurposes.length : 0;

  return `Enabled, ${tierCount} tier${tierCount === 1 ? '' : 's'}, `
    + `${channelCount} channel${channelCount === 1 ? '' : 's'}, `
    + `${purposeCount} purpose${purposeCount === 1 ? '' : 's'}`;
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
  )];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function tryPrettyPrint(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function stringFromConfigValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join(', ');
  }
  return typeof value === 'string' ? value : String(value ?? '');
}

function numberFromConfigValue(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

export function fmtMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function splitCsv(str: string): string[] {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

export function normalizeDiscordListenWindowSeconds(value: number): number {
  if (!Number.isFinite(value)) return 120;
  return clamp(Math.round(value), 10, 600);
}

export interface AdvancedSettingsSectionDef {
  id: string;
  title: string;
  keys: string[];
  summary: () => string;
}

export type SchedulerEditorConfig = {
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  backgroundMaintenance?: {
    intervalMs?: number;
  };
};

export type CapabilitiesEditorConfig = {
  tier?: string;
  customTokens?: string[];
};

export interface SettingsSimpleFormState {
  sessionRestartBehavior: 'reuse_latest_session' | 'new_session';
  sessionHistoryBudgetPct: number;
  memoryRetrievalBudgetPct: number;
  extractionThresholdPct: number;
  compactionThresholdPct: number;
  maxResponseTokens: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  importRouteMode: string;
  importStrictPolicy: boolean;
  importLocalEndpointUrl: string;
  importLocalModel: string;
  openRouterProviderOrder: string;
  webFetchAllowHttp: boolean;
  webFetchDomainAllowlist: string;
  webFetchAllowInternalNetwork: boolean;
  webFetchTlsCaCertPaths: string;
  capabilityTier: string;
  capabilityCustomTokens: string;
  extractionInterval: number;
  compactionEmotionalSalienceThresholdPct: number;
  backgroundMaintenanceIntervalMs: number;
  memoryExtractionMinImportance: number;
  memoryExtractionMinConfidence: number;
  memoryExtractionMinNovelty: number;
  memoryExtractionMaxWrites: number;
  memoryExtractionTelemetryEnabled: boolean;
  memoryRetrievalTelemetryEnabled: boolean;
  profileSynthesisEnabled: boolean;
  profileSynthesisRefreshIntervalMs: number;
  profileSynthesisCooldownMs: number;
  profileSynthesisMinWrites: number;
  profileSynthesisMinImportance: number;
  profileSynthesisMinConfidence: number;
  profileSynthesisMinNovelty: number;
  profileSynthesisSourceMemoryLimit: number;
  profileSynthesisMinSourceMemories: number;
  analysisWorkbenchMaxTokens: number;
  analysisWorkbenchMaxWallTimeMs: number;
  analysisWorkbenchMaxSubQueries: number;
  ttsProvider: string;
  voiceId: string;
  echoTtsUrl: string;
  echoTtsVoice: string;
  echoTtsPreset: string;
  sttProvider: string;
  deepgramModel: string;
  obsidianVaultName: string;
  obsidianCliPath: string;
  obsidianAutoPublish: boolean;
  obsidianTimeoutMs: number;
  discordTriggerWords: string;
  discordTriggerReactions: string;
  discordTriggerListenWindowSeconds: number;
  telegramEnabled: boolean;
  telegramAuthorizedUsers: string;
  backupIntervalHours: number;
  backupMaxRotating: number;
  backupMaxWeekly: number;
  backupMaxMonthly: number;
  backupMirrorDir: string;
  backupVerifyRestore: boolean;
}

export function buildAdvancedSettingsSections(input: {
  state: SettingsSimpleFormState;
  compositionalPolicySummary: string;
}): AdvancedSettingsSectionDef[] {
  const { state } = input;
  const summaryBySectionId: Record<string, () => string> = {
    budget: () => `Session ${state.sessionHistoryBudgetPct}%, Memory ${state.memoryRetrievalBudgetPct}%`,
    memory: () => `Extract at ${state.extractionThresholdPct}% every ${state.extractionInterval} turn${state.extractionInterval === 1 ? '' : 's'}`,
    sessions: () => (
      `Compaction at ${state.compactionThresholdPct}%, `
      + `Background maintenance ${fmtMs(state.backgroundMaintenanceIntervalMs)}, `
      + `Restart ${state.sessionRestartBehavior === 'new_session' ? 'new session' : 'reuse latest'}`
    ),
    'extraction-tuning': () => `Min importance: ${state.memoryExtractionMinImportance}, Max writes: ${state.memoryExtractionMaxWrites}`,
    profile: () => state.profileSynthesisEnabled ? `Enabled, refresh ${Math.round(state.profileSynthesisRefreshIntervalMs / 60000)}min` : 'Disabled',
    'analysis-workbench': () => `Max tokens: ${state.analysisWorkbenchMaxTokens.toLocaleString()}, Wall time: ${Math.round(state.analysisWorkbenchMaxWallTimeMs / 1000)}s`,
    compositional: () => input.compositionalPolicySummary,
    trust: () => `Tier: ${state.capabilityTier}`,
    llm: () => `Max retries: ${state.retryMaxAttempts}, Base delay: ${state.retryBaseDelayMs}ms`,
    import: () => `Route: ${state.importRouteMode}${state.importStrictPolicy ? ' (strict)' : ''}`,
    fetch: () => {
      const parts: string[] = [];
      parts.push(state.webFetchAllowHttp ? 'HTTP allowed' : 'HTTPS only');
      if (state.webFetchAllowInternalNetwork) parts.push('internal LAN');
      return parts.join(', ');
    },
    voice: () => `TTS: ${state.ttsProvider}, STT: ${state.sttProvider}`,
    obsidian: () => state.obsidianVaultName ? `External vault: ${state.obsidianVaultName}${state.obsidianAutoPublish ? ', auto-publish' : ''}` : 'Disabled',
    channels: () => {
      const wordsCount = splitCsv(state.discordTriggerWords).length;
      const reactionsCount = splitCsv(state.discordTriggerReactions).length;
      const windowSeconds = normalizeDiscordListenWindowSeconds(state.discordTriggerListenWindowSeconds);
      return [
        state.telegramEnabled ? 'Telegram on' : 'Telegram off',
        `${wordsCount} word trigger${wordsCount === 1 ? '' : 's'}`,
        `${reactionsCount} reaction trigger${reactionsCount === 1 ? '' : 's'}`,
        `${windowSeconds}s listen window`,
      ].join(', ');
    },
  };
  return SETTINGS_ADVANCED_SECTIONS.map((section) => {
    const summary = summaryBySectionId[section.id];
    if (!summary) {
      throw new Error(`Missing advanced settings summary for section '${section.id}'`);
    }
    return { ...section, summary };
  });
}

export function populateSimpleSettingsForm(settingsData: AdminSettingsData): SettingsSimpleFormState {
  const config = settingsData.config as Record<string, unknown>;
  const scheduler = settingsData.editors?.scheduler as SchedulerEditorConfig | undefined;
  const capabilities = settingsData.editors?.capabilities as CapabilitiesEditorConfig | undefined;
  const maxOutputTokensFromConfig = Number(config.primaryMaxTokens ?? config.extractionMaxTokens ?? 4096);
  const providerSelection = resolveVoiceProviderSelection(config);
  return {
    sessionRestartBehavior: config.sessionRestartBehavior === 'new_session' ? 'new_session' : 'reuse_latest_session',
    sessionHistoryBudgetPct: Number(config.sessionHistoryBudgetPct ?? 6),
    memoryRetrievalBudgetPct: Number(config.memoryRetrievalBudgetPct ?? 2),
    extractionThresholdPct: Number(config.extractionThresholdPct ?? 30),
    compactionThresholdPct: Number(config.compactionThresholdPct ?? 70),
    maxResponseTokens: Number.isFinite(maxOutputTokensFromConfig) && maxOutputTokensFromConfig > 0 ? maxOutputTokensFromConfig : 4096,
    retryMaxAttempts: Number(config.retryMaxAttempts ?? 3),
    retryBaseDelayMs: Number(config.retryBaseDelayMs ?? 2000),
    importRouteMode: String(config.importProcessingRouteMode ?? 'background'),
    importStrictPolicy: Boolean(config.importProcessingStrictPolicy),
    importLocalEndpointUrl: String(config.importProcessingLocalEndpointUrl ?? ''),
    importLocalModel: String(config.importProcessingLocalModel ?? ''),
    openRouterProviderOrder: Array.isArray(config.openRouterProviderOrder) ? config.openRouterProviderOrder.join(', ') : '',
    webFetchAllowHttp: Boolean(config.webFetchAllowHttp),
    webFetchDomainAllowlist: Array.isArray(config.webFetchDomainAllowlist) ? config.webFetchDomainAllowlist.join(', ') : '',
    webFetchAllowInternalNetwork: Boolean(config.webFetchAllowInternalNetwork),
    webFetchTlsCaCertPaths: Array.isArray(config.webFetchTlsCaCertPaths) ? config.webFetchTlsCaCertPaths.join(', ') : '',
    capabilityTier: String(capabilities?.tier ?? 'apprentice'),
    capabilityCustomTokens: Array.isArray(capabilities?.customTokens) ? capabilities.customTokens.join(', ') : '',
    extractionInterval: Number(config.extractionInterval ?? 5),
    compactionEmotionalSalienceThresholdPct: Number(config.compactionEmotionalSalienceThresholdPct ?? 75),
    backgroundMaintenanceIntervalMs: Number(
      scheduler?.backgroundMaintenance?.intervalMs ?? 3600000,
    ),
    memoryExtractionMinImportance: Number(config.memoryExtractionMinImportance ?? 0.3),
    memoryExtractionMinConfidence: Number(config.memoryExtractionMinConfidence ?? 0.4),
    memoryExtractionMinNovelty: Number(config.memoryExtractionMinNovelty ?? 0.1),
    memoryExtractionMaxWrites: Number(config.memoryExtractionMaxWrites ?? 20),
    memoryExtractionTelemetryEnabled: config.memoryExtractionTelemetryEnabled !== false,
    memoryRetrievalTelemetryEnabled: config.memoryRetrievalTelemetryEnabled !== false,
    profileSynthesisEnabled: config.profileSynthesisEnabled !== false,
    profileSynthesisRefreshIntervalMs: Number(config.profileSynthesisRefreshIntervalMs ?? 3600000),
    profileSynthesisCooldownMs: Number(config.profileSynthesisCooldownMs ?? 300000),
    profileSynthesisMinWrites: Number(config.profileSynthesisMinWrites ?? 1),
    profileSynthesisMinImportance: Number(config.profileSynthesisMinImportance ?? 0.65),
    profileSynthesisMinConfidence: Number(config.profileSynthesisMinConfidence ?? 0.7),
    profileSynthesisMinNovelty: Number(config.profileSynthesisMinNovelty ?? 0.12),
    profileSynthesisSourceMemoryLimit: Number(config.profileSynthesisSourceMemoryLimit ?? 16),
    profileSynthesisMinSourceMemories: Number(config.profileSynthesisMinSourceMemories ?? 2),
    analysisWorkbenchMaxTokens: Number(config.analysisWorkbenchMaxTokens ?? 76000),
    analysisWorkbenchMaxWallTimeMs: Number(config.analysisWorkbenchMaxWallTimeMs ?? 300000),
    analysisWorkbenchMaxSubQueries: Number(config.analysisWorkbenchMaxSubQueries ?? 12),
    ttsProvider: providerSelection.ttsProvider,
    voiceId: String(config.voiceId ?? config.elevenLabsVoiceId ?? ''),
    echoTtsUrl: String(config.echoTtsUrl ?? ''),
    echoTtsVoice: String(config.echoTtsVoice ?? ''),
    echoTtsPreset: String(config.echoTtsPreset ?? ''),
    sttProvider: providerSelection.sttProvider,
    deepgramModel: String(config.deepgramModel ?? ''),
    obsidianVaultName: String(config.obsidianVaultName ?? ''),
    obsidianCliPath: String(config.obsidianCliPath ?? 'obsidian'),
    obsidianAutoPublish: Boolean(config.obsidianAutoPublish),
    obsidianTimeoutMs: Number(config.obsidianTimeoutMs ?? 10000),
    discordTriggerWords: String(config.discordTriggerWords ?? ''),
    discordTriggerReactions: String(config.discordTriggerReactions ?? '👆'),
    discordTriggerListenWindowSeconds: normalizeDiscordListenWindowSeconds(Number(config.discordTriggerListenWindowMs ?? 120000) / 1000),
    telegramEnabled: Boolean(config.telegramEnabled),
    telegramAuthorizedUsers: String(config.telegramAuthorizedUsers ?? ''),
    backupIntervalHours: 12,
    backupMaxRotating: 9,
    backupMaxWeekly: 2,
    backupMaxMonthly: 1,
    backupMirrorDir: '',
    backupVerifyRestore: true,
  };
}

export function syncCuratedSettingsField(
  key: string,
  value: unknown,
  current: SettingsSimpleFormState,
): Partial<SettingsSimpleFormState> {
  switch (key) {
    case 'sessionRestartBehavior': return { sessionRestartBehavior: value === 'new_session' ? 'new_session' : 'reuse_latest_session' };
    case 'sessionHistoryBudgetPct': return { sessionHistoryBudgetPct: numberFromConfigValue(value, current.sessionHistoryBudgetPct) };
    case 'memoryRetrievalBudgetPct': return { memoryRetrievalBudgetPct: numberFromConfigValue(value, current.memoryRetrievalBudgetPct) };
    case 'extractionThresholdPct': return { extractionThresholdPct: numberFromConfigValue(value, current.extractionThresholdPct) };
    case 'compactionThresholdPct': return { compactionThresholdPct: numberFromConfigValue(value, current.compactionThresholdPct) };
    case 'primaryMaxTokens':
    case 'extractionMaxTokens': return { maxResponseTokens: numberFromConfigValue(value, current.maxResponseTokens) };
    case 'retryMaxAttempts': return { retryMaxAttempts: numberFromConfigValue(value, current.retryMaxAttempts) };
    case 'retryBaseDelayMs': return { retryBaseDelayMs: numberFromConfigValue(value, current.retryBaseDelayMs) };
    case 'importProcessingRouteMode': return { importRouteMode: stringFromConfigValue(value) };
    case 'importProcessingStrictPolicy': return { importStrictPolicy: value === true };
    case 'importProcessingLocalEndpointUrl': return { importLocalEndpointUrl: stringFromConfigValue(value) };
    case 'importProcessingLocalModel': return { importLocalModel: stringFromConfigValue(value) };
    case 'openRouterProviderOrder': return { openRouterProviderOrder: stringFromConfigValue(value) };
    case 'webFetchAllowHttp': return { webFetchAllowHttp: value === true };
    case 'webFetchDomainAllowlist': return { webFetchDomainAllowlist: stringFromConfigValue(value) };
    case 'webFetchAllowInternalNetwork': return { webFetchAllowInternalNetwork: value === true };
    case 'webFetchTlsCaCertPaths': return { webFetchTlsCaCertPaths: stringFromConfigValue(value) };
    case 'capabilityTier': return { capabilityTier: stringFromConfigValue(value) };
    case 'customTokens': return { capabilityCustomTokens: stringFromConfigValue(value) };
    case 'extractionInterval': return { extractionInterval: numberFromConfigValue(value, current.extractionInterval) };
    case 'compactionEmotionalSalienceThresholdPct': return { compactionEmotionalSalienceThresholdPct: numberFromConfigValue(value, current.compactionEmotionalSalienceThresholdPct) };
    case 'backgroundMaintenanceIntervalMs': return {
      backgroundMaintenanceIntervalMs: numberFromConfigValue(
        value,
        current.backgroundMaintenanceIntervalMs,
      ),
    };
    case 'memoryExtractionMinImportance': return { memoryExtractionMinImportance: numberFromConfigValue(value, current.memoryExtractionMinImportance) };
    case 'memoryExtractionMinConfidence': return { memoryExtractionMinConfidence: numberFromConfigValue(value, current.memoryExtractionMinConfidence) };
    case 'memoryExtractionMinNovelty': return { memoryExtractionMinNovelty: numberFromConfigValue(value, current.memoryExtractionMinNovelty) };
    case 'memoryExtractionMaxWrites': return { memoryExtractionMaxWrites: numberFromConfigValue(value, current.memoryExtractionMaxWrites) };
    case 'memoryExtractionTelemetryEnabled': return { memoryExtractionTelemetryEnabled: value === true };
    case 'memoryRetrievalTelemetryEnabled': return { memoryRetrievalTelemetryEnabled: value === true };
    case 'profileSynthesisEnabled': return { profileSynthesisEnabled: value === true };
    case 'profileSynthesisRefreshIntervalMs': return { profileSynthesisRefreshIntervalMs: numberFromConfigValue(value, current.profileSynthesisRefreshIntervalMs) };
    case 'profileSynthesisCooldownMs': return { profileSynthesisCooldownMs: numberFromConfigValue(value, current.profileSynthesisCooldownMs) };
    case 'profileSynthesisMinWrites': return { profileSynthesisMinWrites: numberFromConfigValue(value, current.profileSynthesisMinWrites) };
    case 'profileSynthesisMinImportance': return { profileSynthesisMinImportance: numberFromConfigValue(value, current.profileSynthesisMinImportance) };
    case 'profileSynthesisMinConfidence': return { profileSynthesisMinConfidence: numberFromConfigValue(value, current.profileSynthesisMinConfidence) };
    case 'profileSynthesisMinNovelty': return { profileSynthesisMinNovelty: numberFromConfigValue(value, current.profileSynthesisMinNovelty) };
    case 'profileSynthesisSourceMemoryLimit': return { profileSynthesisSourceMemoryLimit: numberFromConfigValue(value, current.profileSynthesisSourceMemoryLimit) };
    case 'profileSynthesisMinSourceMemories': return { profileSynthesisMinSourceMemories: numberFromConfigValue(value, current.profileSynthesisMinSourceMemories) };
    case 'analysisWorkbenchMaxTokens': return { analysisWorkbenchMaxTokens: numberFromConfigValue(value, current.analysisWorkbenchMaxTokens) };
    case 'analysisWorkbenchMaxWallTimeMs': return { analysisWorkbenchMaxWallTimeMs: numberFromConfigValue(value, current.analysisWorkbenchMaxWallTimeMs) };
    case 'analysisWorkbenchMaxSubQueries': return { analysisWorkbenchMaxSubQueries: numberFromConfigValue(value, current.analysisWorkbenchMaxSubQueries) };
    case 'ttsProvider': return { ttsProvider: stringFromConfigValue(value) };
    case 'voiceId': return { voiceId: stringFromConfigValue(value) };
    case 'echoTtsUrl': return { echoTtsUrl: stringFromConfigValue(value) };
    case 'echoTtsVoice': return { echoTtsVoice: stringFromConfigValue(value) };
    case 'echoTtsPreset': return { echoTtsPreset: stringFromConfigValue(value) };
    case 'sttProvider': return { sttProvider: stringFromConfigValue(value) };
    case 'deepgramModel': return { deepgramModel: stringFromConfigValue(value) };
    case 'obsidianVaultName': return { obsidianVaultName: stringFromConfigValue(value) };
    case 'obsidianCliPath': return { obsidianCliPath: stringFromConfigValue(value) };
    case 'obsidianAutoPublish': return { obsidianAutoPublish: value === true };
    case 'obsidianTimeoutMs': return { obsidianTimeoutMs: numberFromConfigValue(value, current.obsidianTimeoutMs) };
    case 'discordTriggerWords': return { discordTriggerWords: stringFromConfigValue(value) };
    case 'discordTriggerReactions': return { discordTriggerReactions: stringFromConfigValue(value) };
    case 'discordTriggerListenWindowMs': return {
      discordTriggerListenWindowSeconds: normalizeDiscordListenWindowSeconds(
        numberFromConfigValue(value, current.discordTriggerListenWindowSeconds * 1000) / 1000,
      ),
    };
    case 'telegramEnabled': return { telegramEnabled: value === true };
    case 'telegramAuthorizedUsers': return { telegramAuthorizedUsers: stringFromConfigValue(value) };
    default: return {};
  }
}

export function collectSimpleSettingsPayload(
  state: SettingsSimpleFormState,
  compositionalPolicy: CompositionalPolicyFormValue,
): Record<string, unknown> {
  return {
    sessionRestartBehavior: state.sessionRestartBehavior,
    sessionHistoryBudgetPct: state.sessionHistoryBudgetPct,
    memoryRetrievalBudgetPct: state.memoryRetrievalBudgetPct,
    extractionThresholdPct: state.extractionThresholdPct,
    compactionThresholdPct: state.compactionThresholdPct,
    retryMaxAttempts: state.retryMaxAttempts,
    retryBaseDelayMs: state.retryBaseDelayMs,
    importProcessingRouteMode: state.importRouteMode,
    importProcessingStrictPolicy: state.importStrictPolicy,
    importProcessingLocalEndpointUrl: state.importLocalEndpointUrl,
    importProcessingLocalModel: state.importLocalModel,
    openRouterProviderOrder: splitCsv(state.openRouterProviderOrder),
    compositionalPolicy,
    webFetchAllowHttp: state.webFetchAllowHttp,
    webFetchDomainAllowlist: splitCsv(state.webFetchDomainAllowlist),
    webFetchAllowInternalNetwork: state.webFetchAllowInternalNetwork,
    webFetchTlsCaCertPaths: splitCsv(state.webFetchTlsCaCertPaths),
    extractionInterval: state.extractionInterval,
    compactionEmotionalSalienceThresholdPct: state.compactionEmotionalSalienceThresholdPct,
    memoryExtractionMinImportance: state.memoryExtractionMinImportance,
    memoryExtractionMinConfidence: state.memoryExtractionMinConfidence,
    memoryExtractionMinNovelty: state.memoryExtractionMinNovelty,
    memoryExtractionMaxWrites: state.memoryExtractionMaxWrites,
    memoryExtractionTelemetryEnabled: state.memoryExtractionTelemetryEnabled,
    memoryRetrievalTelemetryEnabled: state.memoryRetrievalTelemetryEnabled,
    profileSynthesisEnabled: state.profileSynthesisEnabled,
    profileSynthesisRefreshIntervalMs: state.profileSynthesisRefreshIntervalMs,
    profileSynthesisCooldownMs: state.profileSynthesisCooldownMs,
    profileSynthesisMinWrites: state.profileSynthesisMinWrites,
    profileSynthesisMinImportance: state.profileSynthesisMinImportance,
    profileSynthesisMinConfidence: state.profileSynthesisMinConfidence,
    profileSynthesisMinNovelty: state.profileSynthesisMinNovelty,
    profileSynthesisSourceMemoryLimit: state.profileSynthesisSourceMemoryLimit,
    profileSynthesisMinSourceMemories: state.profileSynthesisMinSourceMemories,
    analysisWorkbenchMaxTokens: state.analysisWorkbenchMaxTokens,
    analysisWorkbenchMaxWallTimeMs: state.analysisWorkbenchMaxWallTimeMs,
    analysisWorkbenchMaxSubQueries: state.analysisWorkbenchMaxSubQueries,
    ttsProvider: state.ttsProvider,
    voiceId: state.voiceId,
    echoTtsUrl: state.echoTtsUrl,
    echoTtsVoice: state.echoTtsVoice,
    echoTtsPreset: state.echoTtsPreset,
    sttProvider: state.sttProvider,
    deepgramModel: state.deepgramModel,
    obsidianVaultName: state.obsidianVaultName || undefined,
    obsidianCliPath: state.obsidianCliPath || 'obsidian',
    obsidianAutoPublish: state.obsidianAutoPublish,
    obsidianTimeoutMs: state.obsidianTimeoutMs,
    discordTriggerWords: state.discordTriggerWords,
    discordTriggerReactions: state.discordTriggerReactions,
    discordTriggerListenWindowMs: normalizeDiscordListenWindowSeconds(state.discordTriggerListenWindowSeconds) * 1000,
    telegramEnabled: state.telegramEnabled,
    telegramAuthorizedUsers: state.telegramAuthorizedUsers,
  };
}

export function parseBackupSettings(json: string): Pick<
  SettingsSimpleFormState,
  'backupIntervalHours' | 'backupMaxRotating' | 'backupMaxWeekly' | 'backupMaxMonthly' | 'backupMirrorDir' | 'backupVerifyRestore'
> {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      backupIntervalHours: Number(parsed.intervalHours ?? 12),
      backupMaxRotating: Number(parsed.maxRotatingBackups ?? 9),
      backupMaxWeekly: Number(parsed.maxWeeklyBackups ?? 2),
      backupMaxMonthly: Number(parsed.maxMonthlyBackups ?? 1),
      backupMirrorDir: String(parsed.mirrorDir ?? ''),
      backupVerifyRestore: parsed.verifyRestore !== false,
    };
  } catch {
    return {
      backupIntervalHours: 12,
      backupMaxRotating: 9,
      backupMaxWeekly: 2,
      backupMaxMonthly: 1,
      backupMirrorDir: '',
      backupVerifyRestore: true,
    };
  }
}

export function buildBackupSettingsPayload(state: SettingsSimpleFormState): Record<string, unknown> {
  return {
    intervalHours: state.backupIntervalHours,
    maxRotatingBackups: state.backupMaxRotating,
    maxWeeklyBackups: state.backupMaxWeekly,
    maxMonthlyBackups: state.backupMaxMonthly,
    mirrorDir: state.backupMirrorDir,
    verifyRestore: state.backupVerifyRestore,
  };
}

export function buildCapabilitiesSettingsPayload(
  current: CapabilitiesEditorConfig,
  state: Pick<SettingsSimpleFormState, 'capabilityTier' | 'capabilityCustomTokens'>,
): Record<string, unknown> {
  const customTokens = state.capabilityTier === 'custom'
    ? splitCsv(state.capabilityCustomTokens)
    : (Array.isArray(current.customTokens) ? current.customTokens : []);
  return {
    ...current,
    tier: state.capabilityTier,
    customTokens,
  };
}

export function buildSettingsSnapshot(input: {
  state: SettingsSimpleFormState;
  compositionalPolicy: unknown;
  providerRegistry: CanonicalProviderRegistry;
}): string {
  return JSON.stringify({
    ...input.state,
    compositionalPolicy: input.compositionalPolicy ?? null,
    providerRegistry: input.providerRegistry,
  });
}
