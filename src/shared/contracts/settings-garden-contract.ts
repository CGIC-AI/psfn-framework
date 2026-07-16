export const SETTINGS_GARDEN_GENERIC_FIELD_TYPES = [
  'string',
  'boolean',
  'integer',
  'number',
  'string_array',
  'enum',
  'object',
] as const;

export type GardenSettingsSectionId =
  | 'models'
  | 'budget'
  | 'memory'
  | 'sessions'
  | 'compositional'
  | 'extraction-tuning'
  | 'profile'
  | 'analysis-workbench'
  | 'trust'
  | 'llm'
  | 'import'
  | 'fetch'
  | 'voice'
  | 'obsidian'
  | 'channels';

export type GardenSettingsFieldSurface = 'advanced' | 'custom';
export type GardenSettingsCustomEditorId = 'models' | 'scheduler' | 'capabilities';

export interface GardenSettingsFieldExposure {
  sectionId: GardenSettingsSectionId;
  surface: GardenSettingsFieldSurface;
  editorId?: GardenSettingsCustomEditorId;
}

export interface GardenSettingsTunableFieldCoverage {
  fieldKey: string;
  sectionId: GardenSettingsSectionId;
  surface: GardenSettingsFieldSurface;
  editorId?: GardenSettingsCustomEditorId;
}

export const SETTINGS_GARDEN_FIELD_EXPOSURE = {
  modelCatalog: { sectionId: 'models', surface: 'custom', editorId: 'models' },
  sessionHistoryBudgetPct: { sectionId: 'budget', surface: 'advanced' },
  memoryRetrievalBudgetPct: { sectionId: 'budget', surface: 'advanced' },
  moodCongruenceWeight: { sectionId: 'budget', surface: 'advanced' },
  adaptiveContextBudgetsEnabled: { sectionId: 'budget', surface: 'advanced' },
  wikiRetrievalEnabled: { sectionId: 'budget', surface: 'advanced' },
  wikiRetrievalChatTokenCap: { sectionId: 'budget', surface: 'advanced' },
  wikiRetrievalGroupTokenCap: { sectionId: 'budget', surface: 'advanced' },
  wikiRetrievalFocusTokenCap: { sectionId: 'budget', surface: 'advanced' },
  wikiRetrievalSimilarityThreshold: { sectionId: 'budget', surface: 'advanced' },
  wikiRetrievalGroupSimilarityThreshold: { sectionId: 'budget', surface: 'advanced' },
  wikiStartupHydration: { sectionId: 'memory', surface: 'advanced' },
  sessionMirrorEnabled: { sectionId: 'sessions', surface: 'advanced' },
  sessionMirrorMaxChars: { sectionId: 'sessions', surface: 'advanced' },
  sessionMirrorActiveWindowMs: { sectionId: 'sessions', surface: 'advanced' },
  sessionMirrorChannelOverrides: { sectionId: 'sessions', surface: 'advanced' },
  continuityMessageLimit: { sectionId: 'sessions', surface: 'advanced' },
  extractionThresholdPct: { sectionId: 'memory', surface: 'advanced' },
  extractionInterval: { sectionId: 'memory', surface: 'advanced' },
  compactionEmotionalSalienceThresholdPct: { sectionId: 'memory', surface: 'advanced' },
  compactionThresholdPct: { sectionId: 'sessions', surface: 'advanced' },
  observationMaskingWindow: { sectionId: 'sessions', surface: 'advanced' },
  backgroundMaintenanceIntervalMs: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  episodicProcessingEnabled: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  episodicProcessingRestWindowStartLocalTime: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  episodicProcessingRestWindowEndLocalTime: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  episodicProcessingRestWindowTimeZone: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  episodicProcessingInactivityThresholdMinutes: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  sessionRestartBehavior: { sectionId: 'sessions', surface: 'advanced' },
  sessionTailCache: { sectionId: 'sessions', surface: 'advanced' },
  activeTimezone: { sectionId: 'sessions', surface: 'advanced' },
  compositionalPolicy: { sectionId: 'compositional', surface: 'advanced' },
  subagentMaxConcurrent: { sectionId: 'compositional', surface: 'advanced' },
  shardMaxConcurrent: { sectionId: 'compositional', surface: 'advanced' },
  shardHeartbeatStaleAfterMs: { sectionId: 'compositional', surface: 'advanced' },
  shardHeartbeatDisconnectAfterMs: { sectionId: 'compositional', surface: 'advanced' },
  memoryExtractionMinImportance: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionMinConfidence: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionMinNovelty: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionEmotionalIntensityWeight: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionMaxWrites: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionTelemetryEnabled: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryRetrievalTelemetryEnabled: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryRetrievalPolicy: { sectionId: 'memory', surface: 'advanced' },
  memoryRefreshFailureAlertThreshold: { sectionId: 'memory', surface: 'advanced' },
  groupMemory: { sectionId: 'extraction-tuning', surface: 'advanced' },
  emotionScoping: { sectionId: 'memory', surface: 'advanced' },
  embeddingProvider: { sectionId: 'memory', surface: 'advanced' },
  embeddingModel: { sectionId: 'memory', surface: 'advanced' },
  embeddingDims: { sectionId: 'memory', surface: 'advanced' },
  embeddingOllamaUrl: { sectionId: 'memory', surface: 'advanced' },
  transformersModel: { sectionId: 'memory', surface: 'advanced' },
  transformersCacheDir: { sectionId: 'memory', surface: 'advanced' },
  textEmotionModel: { sectionId: 'memory', surface: 'advanced' },
  textEmotionCacheDir: { sectionId: 'memory', surface: 'advanced' },
  textEmotionDtype: { sectionId: 'memory', surface: 'advanced' },
  embeddingApiUrl: { sectionId: 'memory', surface: 'advanced' },
  embeddingApiModel: { sectionId: 'memory', surface: 'advanced' },
  embeddingApiDims: { sectionId: 'memory', surface: 'advanced' },
  profileSynthesisEnabled: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisRefreshIntervalMs: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisCooldownMs: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisMinWrites: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisMinImportance: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisMinConfidence: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisMinNovelty: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisSourceMemoryLimit: { sectionId: 'profile', surface: 'advanced' },
  profileSynthesisMinSourceMemories: { sectionId: 'profile', surface: 'advanced' },
  uiThemeId: { sectionId: 'profile', surface: 'advanced' },
  analysisWorkbenchMaxTokens: { sectionId: 'analysis-workbench', surface: 'advanced' },
  analysisWorkbenchMaxWallTimeMs: { sectionId: 'analysis-workbench', surface: 'advanced' },
  analysisWorkbenchMaxSubQueries: { sectionId: 'analysis-workbench', surface: 'advanced' },
  analysisWorkbenchExecutionTimeoutMs: { sectionId: 'analysis-workbench', surface: 'advanced' },
  analysisWorkbenchOutputTruncation: { sectionId: 'analysis-workbench', surface: 'advanced' },
  observerEvalSidecar: { sectionId: 'analysis-workbench', surface: 'advanced' },
  capabilityTier: { sectionId: 'trust', surface: 'custom', editorId: 'capabilities' },
  customTokens: { sectionId: 'trust', surface: 'custom', editorId: 'capabilities' },
  retryMaxAttempts: { sectionId: 'llm', surface: 'advanced' },
  retryBaseDelayMs: { sectionId: 'llm', surface: 'advanced' },
  documentIngestMaxBytes: { sectionId: 'import', surface: 'advanced' },
  documentIngestTextMaxBytes: { sectionId: 'import', surface: 'advanced' },
  documentIngestPromptChars: { sectionId: 'import', surface: 'advanced' },
  documentIngestSidecarChars: { sectionId: 'import', surface: 'advanced' },
  importProcessingRouteMode: { sectionId: 'import', surface: 'advanced' },
  importProcessingStrictPolicy: { sectionId: 'import', surface: 'advanced' },
  importProcessingLocalEndpointUrl: { sectionId: 'import', surface: 'advanced' },
  importProcessingLocalModel: { sectionId: 'import', surface: 'advanced' },
  openRouterProviderOrder: { sectionId: 'import', surface: 'advanced' },
  openRouterModelsApiUrl: { sectionId: 'import', surface: 'advanced' },
  webFetchAllowHttp: { sectionId: 'fetch', surface: 'advanced' },
  webFetchDomainAllowlist: { sectionId: 'fetch', surface: 'advanced' },
  webFetchAllowInternalNetwork: { sectionId: 'fetch', surface: 'advanced' },
  homeAssistantEnabled: { sectionId: 'fetch', surface: 'advanced' },
  webFetchTlsCaCertPaths: { sectionId: 'fetch', surface: 'advanced' },
  voiceEnabled: { sectionId: 'voice', surface: 'advanced' },
  ttsProvider: { sectionId: 'voice', surface: 'advanced' },
  voiceId: { sectionId: 'voice', surface: 'advanced' },
  voiceTargetGuildId: { sectionId: 'voice', surface: 'advanced' },
  voiceTargetUserId: { sectionId: 'voice', surface: 'advanced' },
  voiceReadyCueText: { sectionId: 'voice', surface: 'advanced' },
  echoTtsUrl: { sectionId: 'voice', surface: 'advanced' },
  echoTtsVoice: { sectionId: 'voice', surface: 'advanced' },
  echoTtsPreset: { sectionId: 'voice', surface: 'advanced' },
  sttProvider: { sectionId: 'voice', surface: 'advanced' },
  deepgramModel: { sectionId: 'voice', surface: 'advanced' },
  deepgramSttEndpoint: { sectionId: 'voice', surface: 'advanced' },
  deepgramListenEndpoint: { sectionId: 'voice', surface: 'advanced' },
  elevenLabsModelId: { sectionId: 'voice', surface: 'advanced' },
  elevenLabsEndpointBase: { sectionId: 'voice', surface: 'advanced' },
  voiceSessionTimeoutMs: { sectionId: 'voice', surface: 'advanced' },
  voiceMaxFrameBytes: { sectionId: 'voice', surface: 'advanced' },
  voiceMaxPendingFrames: { sectionId: 'voice', surface: 'advanced' },
  obsidianVaultName: { sectionId: 'obsidian', surface: 'advanced' },
  obsidianCliPath: { sectionId: 'obsidian', surface: 'advanced' },
  obsidianAutoPublish: { sectionId: 'obsidian', surface: 'advanced' },
  obsidianTimeoutMs: { sectionId: 'obsidian', surface: 'advanced' },
  discordTriggerWords: { sectionId: 'channels', surface: 'advanced' },
  discordTriggerReactions: { sectionId: 'channels', surface: 'advanced' },
  discordTriggerListenWindowMs: { sectionId: 'channels', surface: 'advanced' },
  telegramEnabled: { sectionId: 'channels', surface: 'advanced' },
  telegramAuthorizedUsers: { sectionId: 'channels', surface: 'advanced' },
  wyomingShardRouting: { sectionId: 'channels', surface: 'advanced' },
  shardToolsets: { sectionId: 'channels', surface: 'advanced' },
  promotedExtendedTools: { sectionId: 'channels', surface: 'advanced' },
  chatApiBaseUrl: { sectionId: 'channels', surface: 'advanced' },
  comfyUiBaseUrl: { sectionId: 'channels', surface: 'advanced' },
  imageWorkflows: { sectionId: 'channels', surface: 'advanced' },
  imageFalTimeoutMs: { sectionId: 'channels', surface: 'advanced' },
  imageFalPollIntervalMs: { sectionId: 'channels', surface: 'advanced' },
  imageComfyTimeoutMs: { sectionId: 'channels', surface: 'advanced' },
  imageComfyPollIntervalMs: { sectionId: 'channels', surface: 'advanced' },
  moaEnabled: { sectionId: 'channels', surface: 'advanced' },
  moaReferenceModels: { sectionId: 'channels', surface: 'advanced' },
  moaAggregatorModel: { sectionId: 'channels', surface: 'advanced' },
  moaMaxRounds: { sectionId: 'channels', surface: 'advanced' },
  moaMaxTokensPerRound: { sectionId: 'channels', surface: 'advanced' },
  moaTimeoutMs: { sectionId: 'channels', surface: 'advanced' },
} as const satisfies Record<string, GardenSettingsFieldExposure>;

function collectSectionFields(sectionId: GardenSettingsSectionId): string[] {
  return Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)
    .filter(([, exposure]) => exposure.sectionId === sectionId)
    .map(([fieldKey]) => fieldKey);
}

function collectCustomEditorFields(editorId: GardenSettingsCustomEditorId): string[] {
  return Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)
    .filter(([, exposure]) => 'editorId' in exposure && exposure.editorId === editorId)
    .map(([fieldKey]) => fieldKey);
}

function collectAdvancedSectionFields(sectionId: GardenSettingsSectionId): string[] {
  return Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)
    .filter(([, exposure]) => exposure.sectionId === sectionId && exposure.surface === 'advanced')
    .map(([fieldKey]) => fieldKey);
}

export const SETTINGS_GARDEN_SECTION_FIELDS: Record<GardenSettingsSectionId, string[]> = {
  models: collectSectionFields('models'),
  budget: collectSectionFields('budget'),
  memory: collectSectionFields('memory'),
  sessions: collectSectionFields('sessions'),
  compositional: collectSectionFields('compositional'),
  'extraction-tuning': collectSectionFields('extraction-tuning'),
  profile: collectSectionFields('profile'),
  'analysis-workbench': collectSectionFields('analysis-workbench'),
  trust: collectSectionFields('trust'),
  llm: collectSectionFields('llm'),
  import: collectSectionFields('import'),
  fetch: collectSectionFields('fetch'),
  voice: collectSectionFields('voice'),
  obsidian: collectSectionFields('obsidian'),
  channels: collectSectionFields('channels'),
};

export const SETTINGS_GARDEN_CUSTOM_EDITOR_FIELDS: Record<GardenSettingsCustomEditorId, string[]> = {
  models: collectCustomEditorFields('models'),
  scheduler: collectCustomEditorFields('scheduler'),
  capabilities: collectCustomEditorFields('capabilities'),
};

/**
 * Per-section field keys that the generic Garden "All Fields" advanced editor is
 * responsible for rendering: only fields whose `surface` is `'advanced'`.
 *
 * This deliberately excludes `surface: 'custom'` fields (e.g. `modelCatalog`,
 * `capabilityTier`, `salienceDecayIntervalMs`, the `episodicProcessing*` slots),
 * which are owned by dedicated custom editors / owner files and must not be
 * offered as generic runtime-settings inputs — the runtime settings write path
 * rejects them with a `wrong_owner` validation error.
 *
 * Unlike {@link SETTINGS_GARDEN_SECTION_FIELDS} (which lists every field mapped
 * to a section regardless of surface), this projection is what lets the advanced
 * editor surface every advanced field a section owns even when that field is not
 * yet present in the persisted runtime settings, so admins can discover and edit
 * settings that are still on their built-in defaults.
 */
export const SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS: Record<GardenSettingsSectionId, string[]> = {
  models: collectAdvancedSectionFields('models'),
  budget: collectAdvancedSectionFields('budget'),
  memory: collectAdvancedSectionFields('memory'),
  sessions: collectAdvancedSectionFields('sessions'),
  compositional: collectAdvancedSectionFields('compositional'),
  'extraction-tuning': collectAdvancedSectionFields('extraction-tuning'),
  profile: collectAdvancedSectionFields('profile'),
  'analysis-workbench': collectAdvancedSectionFields('analysis-workbench'),
  trust: collectAdvancedSectionFields('trust'),
  llm: collectAdvancedSectionFields('llm'),
  import: collectAdvancedSectionFields('import'),
  fetch: collectAdvancedSectionFields('fetch'),
  voice: collectAdvancedSectionFields('voice'),
  obsidian: collectAdvancedSectionFields('obsidian'),
  channels: collectAdvancedSectionFields('channels'),
};

export function listGardenSettingsFieldExposureKeys(): string[] {
  return Object.keys(SETTINGS_GARDEN_FIELD_EXPOSURE).sort();
}

export const SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY = {
  settings: 'runtime',
  models: 'models',
  providers: 'providers',
  channels: 'channels',
  skills: 'skills',
  scheduler: 'scheduler',
  'trust-policy': 'trustPolicy',
  'intake-policy': 'intakePolicy',
  capabilities: 'capabilities',
  'charge-policy': 'chargePolicy',
  backup: 'backup',
} as const;

export type GardenSettingsRawEditorKey = keyof typeof SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY;

export const SETTINGS_GARDEN_RAW_EDITOR_KEYS = Object.keys(
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
) as GardenSettingsRawEditorKey[];

export interface GardenSettingsOwnerFileCoverage {
  rawEditorKey: GardenSettingsRawEditorKey;
  subsystemId: (typeof SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY)[GardenSettingsRawEditorKey];
  ownerFile: string;
}

export const SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY: Record<GardenSettingsRawEditorKey, string> = {
  settings: 'settings.json',
  models: 'models.json',
  providers: 'providers.json',
  channels: 'channels.json',
  skills: 'skills.json',
  scheduler: 'scheduler.json',
  'trust-policy': 'trust-policy.json',
  'intake-policy': 'intake-policy.json',
  capabilities: 'capability-tier.json',
  'charge-policy': 'charge-policy.json',
  backup: 'backup.json',
};

export const SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS = [
  'runtime',
  'models',
  'providers',
  'channels',
  'scheduler',
  'capabilities',
  'chargePolicy',
  'skills',
  'trustPolicy',
  'intakePolicy',
  'backup',
] as const;

export function listGardenSettingsTunableFieldCoverage(): GardenSettingsTunableFieldCoverage[] {
  return Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)
    .map(([fieldKey, exposure]) => ({
      fieldKey,
      sectionId: exposure.sectionId,
      surface: exposure.surface,
      ...('editorId' in exposure ? { editorId: exposure.editorId } : {}),
    }))
    .sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

export function listGardenSettingsOwnerFileCoverage(): GardenSettingsOwnerFileCoverage[] {
  return SETTINGS_GARDEN_RAW_EDITOR_KEYS.map((rawEditorKey) => ({
    rawEditorKey,
    subsystemId: SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY[rawEditorKey],
    ownerFile: SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY[rawEditorKey],
  }));
}
