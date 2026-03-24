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
  | 'think'
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

export const SETTINGS_GARDEN_FIELD_EXPOSURE = {
  modelCatalog: { sectionId: 'models', surface: 'custom', editorId: 'models' },
  sessionHistoryBudgetPct: { sectionId: 'budget', surface: 'advanced' },
  memoryRetrievalBudgetPct: { sectionId: 'budget', surface: 'advanced' },
  moodCongruenceWeight: { sectionId: 'budget', surface: 'advanced' },
  adaptiveContextBudgetsEnabled: { sectionId: 'budget', surface: 'advanced' },
  extractionThresholdPct: { sectionId: 'memory', surface: 'advanced' },
  extractionInterval: { sectionId: 'memory', surface: 'advanced' },
  compactionEmotionalSalienceThresholdPct: { sectionId: 'memory', surface: 'advanced' },
  compactionThresholdPct: { sectionId: 'sessions', surface: 'advanced' },
  observationMaskingWindow: { sectionId: 'sessions', surface: 'advanced' },
  maintenanceIntervalMs: { sectionId: 'sessions', surface: 'custom', editorId: 'scheduler' },
  sessionRestartBehavior: { sectionId: 'sessions', surface: 'advanced' },
  compositionalPolicy: { sectionId: 'compositional', surface: 'advanced' },
  memoryExtractionMinImportance: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionMinConfidence: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionMinNovelty: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionEmotionalIntensityWeight: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionMaxWrites: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryExtractionTelemetryEnabled: { sectionId: 'extraction-tuning', surface: 'advanced' },
  memoryRetrievalTelemetryEnabled: { sectionId: 'extraction-tuning', surface: 'advanced' },
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
  thinkMaxTokens: { sectionId: 'think', surface: 'advanced' },
  thinkMaxWallTimeMs: { sectionId: 'think', surface: 'advanced' },
  thinkMaxSubQueries: { sectionId: 'think', surface: 'advanced' },
  capabilityTier: { sectionId: 'trust', surface: 'custom', editorId: 'capabilities' },
  customTokens: { sectionId: 'trust', surface: 'custom', editorId: 'capabilities' },
  retryMaxAttempts: { sectionId: 'llm', surface: 'advanced' },
  retryBaseDelayMs: { sectionId: 'llm', surface: 'advanced' },
  importProcessingRouteMode: { sectionId: 'import', surface: 'advanced' },
  importProcessingStrictPolicy: { sectionId: 'import', surface: 'advanced' },
  importProcessingLocalEndpointUrl: { sectionId: 'import', surface: 'advanced' },
  importProcessingLocalModel: { sectionId: 'import', surface: 'advanced' },
  openRouterProviderOrder: { sectionId: 'import', surface: 'advanced' },
  openRouterModelsApiUrl: { sectionId: 'import', surface: 'advanced' },
  webFetchAllowHttp: { sectionId: 'fetch', surface: 'advanced' },
  webFetchDomainAllowlist: { sectionId: 'fetch', surface: 'advanced' },
  webFetchAllowInternalNetwork: { sectionId: 'fetch', surface: 'advanced' },
  webFetchTlsCaCertPaths: { sectionId: 'fetch', surface: 'advanced' },
  ttsProvider: { sectionId: 'voice', surface: 'advanced' },
  voiceId: { sectionId: 'voice', surface: 'advanced' },
  echoTtsUrl: { sectionId: 'voice', surface: 'advanced' },
  echoTtsVoice: { sectionId: 'voice', surface: 'advanced' },
  echoTtsPreset: { sectionId: 'voice', surface: 'advanced' },
  sttProvider: { sectionId: 'voice', surface: 'advanced' },
  deepgramModel: { sectionId: 'voice', surface: 'advanced' },
  deepgramSttEndpoint: { sectionId: 'voice', surface: 'advanced' },
  deepgramListenEndpoint: { sectionId: 'voice', surface: 'advanced' },
  elevenLabsModelId: { sectionId: 'voice', surface: 'advanced' },
  elevenLabsEndpointBase: { sectionId: 'voice', surface: 'advanced' },
  obsidianVaultName: { sectionId: 'obsidian', surface: 'advanced' },
  obsidianCliPath: { sectionId: 'obsidian', surface: 'advanced' },
  obsidianAutoPublish: { sectionId: 'obsidian', surface: 'advanced' },
  obsidianTimeoutMs: { sectionId: 'obsidian', surface: 'advanced' },
  discordTriggerWords: { sectionId: 'channels', surface: 'advanced' },
  discordTriggerReactions: { sectionId: 'channels', surface: 'advanced' },
  discordTriggerListenWindowMs: { sectionId: 'channels', surface: 'advanced' },
  telegramEnabled: { sectionId: 'channels', surface: 'advanced' },
  telegramAuthorizedUsers: { sectionId: 'channels', surface: 'advanced' },
  promotedExtendedTools: { sectionId: 'channels', surface: 'advanced' },
  chatApiBaseUrl: { sectionId: 'channels', surface: 'advanced' },
  comfyUiBaseUrl: { sectionId: 'channels', surface: 'advanced' },
  imageWorkflows: { sectionId: 'channels', surface: 'advanced' },
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

export const SETTINGS_GARDEN_SECTION_FIELDS: Record<GardenSettingsSectionId, string[]> = {
  models: collectSectionFields('models'),
  budget: collectSectionFields('budget'),
  memory: collectSectionFields('memory'),
  sessions: collectSectionFields('sessions'),
  compositional: collectSectionFields('compositional'),
  'extraction-tuning': collectSectionFields('extraction-tuning'),
  profile: collectSectionFields('profile'),
  think: collectSectionFields('think'),
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

export function listGardenSettingsFieldExposureKeys(): string[] {
  return Object.keys(SETTINGS_GARDEN_FIELD_EXPOSURE).sort();
}

export const SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY = {
  settings: 'runtime',
  models: 'models',
  skills: 'skills',
  scheduler: 'scheduler',
  'trust-policy': 'trustPolicy',
  capabilities: 'capabilities',
  backup: 'backup',
} as const;

export type GardenSettingsRawEditorKey = keyof typeof SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY;

export const SETTINGS_GARDEN_RAW_EDITOR_KEYS = Object.keys(
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
) as GardenSettingsRawEditorKey[];

export const SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY: Record<GardenSettingsRawEditorKey, string> = {
  settings: 'settings.json',
  models: 'models.json',
  skills: 'skills.json',
  scheduler: 'scheduler.json',
  'trust-policy': 'trust-policy.json',
  capabilities: 'capability-tier.json',
  backup: 'backup.json',
};

export const SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS = [
  'runtime',
  'models',
  'scheduler',
  'capabilities',
  'skills',
  'trustPolicy',
  'backup',
] as const;
