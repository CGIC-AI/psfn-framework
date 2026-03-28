import type {
  CanonicalModelRegistry,
  CapabilityTier,
  CompositionalPolicyConfig,
  ImportProcessingRouteMode,
  ModelCatalogEntry,
  ModelPurpose,
  ModelRoleAssignments,
  ModelSlot,
  SessionRestartBehavior,
  SubstrateConfig,
} from '../../types.js';
import type { ImageWorkflowSettings } from '../../images/types.js';

export const SETTINGS_FILE_NAME = 'settings.json';
export const PRIMARY_MODEL_SLOT_KEY = 'primary';
export const EXTRACTION_MODEL_SLOT_KEY = 'extraction';
export const KNOWN_MODEL_PURPOSES: ModelPurpose[] = [
  'chat',
  'background',
  'memory',
  'context',
  'reasoning',
  'longContext',
  'vision',
];
export const MOOD_CONGRUENCE_WEIGHT_RANGE = {
  min: 0,
  max: 1,
} as const;
export const EXTRACTION_THRESHOLD_PCT_RANGE = {
  min: 10,
  max: 80,
} as const;
export const COMPACTION_THRESHOLD_PCT_RANGE = {
  min: 30,
  max: 90,
} as const;
export const REMOVED_RUNTIME_SETTINGS_KEYS = [
  'memoryBudgetPct',
  'defaultContextWindow',
  'discordEnabled',
  'discordHeartbeatChannel',
  'sessionMessageLimit',
  'memoryRetrievalLimit',
] as const;

export const MODEL_SLOT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

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
  memory: EXTRACTION_MODEL_SLOT_KEY,
  context: EXTRACTION_MODEL_SLOT_KEY,
  extraction: EXTRACTION_MODEL_SLOT_KEY,
  summary: PRIMARY_MODEL_SLOT_KEY,
  reasoning: PRIMARY_MODEL_SLOT_KEY,
  longContext: PRIMARY_MODEL_SLOT_KEY,
  vision: PRIMARY_MODEL_SLOT_KEY,
  import_processing: EXTRACTION_MODEL_SLOT_KEY,
};

export interface EditableSettings {
  modelRegistry?: CanonicalModelRegistry;
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
  moodCongruenceWeight?: number;
  adaptiveContextBudgetsEnabled?: boolean;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  memoryRetrievalLimit?: number;
  extractionInterval?: number;
  maintenanceIntervalMs?: number;
  extractionThresholdPct?: number;
  compactionThresholdPct?: number;
  observationMaskingWindow?: number;
  compactionEmotionalSalienceThresholdPct?: number;
  memoryExtractionMinImportance?: number;
  memoryExtractionMinConfidence?: number;
  memoryExtractionMinNovelty?: number;
  memoryExtractionEmotionalIntensityWeight?: number;
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
  openRouterModelsApiUrl?: string;
  importProcessingRouteMode?: ImportProcessingRouteMode;
  importProcessingStrictPolicy?: boolean;
  importProcessingLocalEndpointUrl?: string;
  importProcessingLocalModel?: string;
  embeddingProvider?: SubstrateConfig['embeddingProvider'];
  embeddingModel?: string;
  embeddingDims?: number;
  embeddingOllamaUrl?: string;
  transformersModel?: string;
  transformersCacheDir?: string;
  textEmotionModel?: string;
  textEmotionCacheDir?: string;
  textEmotionDtype?: SubstrateConfig['textEmotionDtype'];
  embeddingApiUrl?: string;
  embeddingApiModel?: string;
  embeddingApiDims?: number;
  compositionalPolicy?: CompositionalPolicyConfig;
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
  comfyUiBaseUrl?: string;
  imageWorkflows?: ImageWorkflowSettings;
  uiThemeId?: string;

  // Voice / TTS (non-secret config only — API keys stay in .env)
  ttsProvider?: SubstrateConfig['ttsProvider'];
  voiceId?: string;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  sttProvider?: SubstrateConfig['sttProvider'];
  deepgramModel?: string;
  deepgramSttEndpoint?: string;
  deepgramListenEndpoint?: string;
  elevenLabsModelId?: string;
  elevenLabsEndpointBase?: string;

  // Channel configuration (non-secret — bot tokens stay in .env)
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
  'moodCongruenceWeight',
  'adaptiveContextBudgetsEnabled',
  'sessionRestartBehavior',
  'extractionInterval',
  'maintenanceIntervalMs',
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
  'openRouterProviderOrder',
  'openRouterModelsApiUrl',
  'importProcessingRouteMode',
  'importProcessingStrictPolicy',
  'importProcessingLocalEndpointUrl',
  'importProcessingLocalModel',
  'embeddingProvider',
  'embeddingModel',
  'embeddingDims',
  'embeddingOllamaUrl',
  'transformersModel',
  'transformersCacheDir',
  'textEmotionModel',
  'textEmotionCacheDir',
  'textEmotionDtype',
  'embeddingApiUrl',
  'embeddingApiModel',
  'embeddingApiDims',
  'compositionalPolicy',
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
  'comfyUiBaseUrl',
  'imageWorkflows',
  'uiThemeId',
  // Voice / TTS
  'ttsProvider',
  'voiceId',
  'echoTtsUrl',
  'echoTtsVoice',
  'echoTtsPreset',
  'sttProvider',
  'deepgramModel',
  'deepgramSttEndpoint',
  'deepgramListenEndpoint',
  'elevenLabsModelId',
  'elevenLabsEndpointBase',
  // Channels
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
export type RuntimeSettingValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | CompositionalPolicyConfig
  | ImageWorkflowSettings;
export type RuntimeSettingsSnapshot = Record<RuntimeSettingKey, RuntimeSettingValue>;
