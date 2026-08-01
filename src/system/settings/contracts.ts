import type { CanonicalModelRegistry, ImportProcessingRouteMode, ModelCatalogEntry, ModelPurpose, ModelPurposeSelection, ModelRoleAssignments, ModelSlot, ObserverEvalSidecarSettings } from '../../shared/contracts/runtime.js';
import type { GroupMemorySettings } from '../config/group-memory-config.js';
import type { EmotionScopingSettings } from '../config/emotion-scoping-config.js';
import type { MemoryRetrievalPolicy } from '../config/memory-retrieval-policy.js';
import type { MemoryPresentationProfile } from '../config/memory-presentation-profile.js';
import type { MemoryDeletionPolicy } from '../config/memory-deletion-policy.js';
import type { CapabilityTier, CompositionalPolicyConfig, LifecycleKubernetesSettings, SessionRestartBehavior, SessionTailCacheSettings, SubstrateConfig, VoiceReplySegmenterSettings, WikiStartupHydrationSettings } from '../config/runtime-config-contracts.js';
import type { ShellExecSettings } from '../config/shell-exec-config.js';
import type {
  FalCreateModel,
  FalEditModel,
  ImageProvider,
  ImageWorkflowSettings,
} from '../../primitives/images/types.js';
import type { CogSecPersonaConformanceSettings } from '../../shared/contracts/cogsec-persona-conformance.js';

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

// Characters permitted in the Obsidian CLI executable path (bead lget / w3pj).
// Same rule the vault runtime enforces in
// src/boundary/integrations/vault/ops.ts (validateVaultCliPath): letters,
// digits, dot, underscore, hyphen and forward slash only — every shell
// metacharacter and whitespace is rejected. `obsidianCliPath` is admin-mutable
// through the settings form, and is later handed to a process spawn, so it must
// never be able to carry a shell-injection payload. This is defence-in-depth at
// the config-write boundary (the runtime spawn is also gated and uses
// shell:false / execFileSync).
const OBSIDIAN_CLI_PATH_ALLOWED = /^[A-Za-z0-9._/-]+$/;

/**
 * Validate an admin-supplied `obsidianCliPath` before it is persisted to
 * settings.json. Rejects shell metacharacters/whitespace and requires either a
 * bare command name or an absolute path. Returns the value unchanged when valid.
 *
 * NOTE(w3pj): the fully-correct fix is to relocate `obsidianCliPath` out of the
 * mutable settings.json into an admin-reviewed owner file. That relocation is
 * blocked from this change's allowed file set: the only writers of
 * `config.obsidianCliPath` live in out-of-scope assembly seams
 * (bootstrap-helpers.ts / runtime-config.ts / startup-context.ts), and the
 * settings contract guard requires this `surface: 'advanced'` field to remain
 * runtime-owned (would need settings-contract.ts / settings-garden-contract.ts).
 * Until then, this boundary validation prevents the settings form from ever
 * storing an injection payload. See bead w3pj.
 */
export function validateObsidianCliPathSetting(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('obsidianCliPath must be a non-empty string');
  }
  if (!OBSIDIAN_CLI_PATH_ALLOWED.test(value)) {
    throw new Error(
      `obsidianCliPath '${value}' contains characters outside [A-Za-z0-9._/-] `
      + '(shell metacharacters and whitespace are not allowed)',
    );
  }
  const isBareName = !value.includes('/');
  const isAbsolute = value.startsWith('/');
  if (!isBareName && !isAbsolute) {
    throw new Error(
      `obsidianCliPath '${value}' must be an absolute path or a bare command name`,
    );
  }
  return value;
}

export interface SettingsDomainSplit {
  runtime: EditableSettings;
  models: EditableSettings;
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
  /**
   * Per-companion model selection (23pp): canonical purpose → models.json slot
   * key. Runtime-owned (settings.json / settings.overlay.json); the catalog
   * itself stays models.json-owned and gateway-global. Selected slots lead the
   * lane's routing chain; unset purposes keep registry-primary routing.
   */
  modelPurposeSelection?: ModelPurposeSelection;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
  moodCongruenceWeight?: number;
  adaptiveContextBudgetsEnabled?: boolean;
  wikiRetrievalEnabled?: boolean;
  wikiRetrievalChatTokenCap?: number;
  wikiRetrievalGroupTokenCap?: number;
  wikiRetrievalFocusTokenCap?: number;
  wikiRetrievalSimilarityThreshold?: number;
  wikiRetrievalGroupSimilarityThreshold?: number;
  wikiStartupHydration?: WikiStartupHydrationSettings;
  lifecycleKubernetes?: LifecycleKubernetesSettings;
  cogSecPersonaConformance?: CogSecPersonaConformanceSettings;
  sessionMirrorEnabled?: boolean;
  sessionMirrorMaxChars?: number;
  sessionMirrorActiveWindowMs?: number;
  sessionMirrorChannelOverrides?: Record<string, boolean>;
  continuityMessageLimit?: number;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  memoryRetrievalLimit?: number;
  extractionInterval?: number;
  /** Retired owner key; accepted only so validation can reject it explicitly. */
  salienceDecayIntervalMs?: number;
  /** Garden projection owned by scheduler.json > backgroundMaintenance.intervalMs. */
  backgroundMaintenanceIntervalMs?: number;
  /** Removed runtime mirror; scheduler.json is canonical. */
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
  memoryDeletionPolicy?: MemoryDeletionPolicy;
  memoryRetrievalPolicy?: MemoryRetrievalPolicy;
  memoryPresentationProfile?: MemoryPresentationProfile;
  memoryRefreshFailureAlertThreshold?: number;
  groupMemory?: GroupMemorySettings;
  emotionScoping?: EmotionScopingSettings;
  profileSynthesisEnabled?: boolean;
  profileSynthesisRefreshIntervalMs?: number;
  profileSynthesisCooldownMs?: number;
  profileSynthesisMinWrites?: number;
  profileSynthesisMinImportance?: number;
  profileSynthesisMinConfidence?: number;
  profileSynthesisMinNovelty?: number;
  profileSynthesisSourceMemoryLimit?: number;
  profileSynthesisMinSourceMemories?: number;
  analysisWorkbenchMaxTokens?: number;
  analysisWorkbenchMaxWallTimeMs?: number;
  analysisWorkbenchDirectResponseTimeoutMs?: number;
  analysisWorkbenchMaxSubQueries?: number;
  analysisWorkbenchExecutionTimeoutMs?: number;
  analysisWorkbenchOutputTruncation?: number;
  fsReadMaxBytes?: number;
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
  observerEvalSidecar?: ObserverEvalSidecarSettings;
  sessionTailCache?: SessionTailCacheSettings;
  wyomingShardRouting?: SubstrateConfig['wyomingShardRouting'];
  shardToolsets?: SubstrateConfig['shardToolsets'];
  // Tier 2 tuning knobs (zet.7): compositional-cognition concurrency limits
  subagentMaxConcurrent?: number;
  shardMaxConcurrent?: number;
  shardHeartbeatStaleAfterMs?: number;
  shardHeartbeatDisconnectAfterMs?: number;
  // Tier 2 tuning knobs (zet.7): document attachment ingest caps
  documentIngestMaxBytes?: number;
  documentIngestTextMaxBytes?: number;
  documentIngestPromptChars?: number;
  documentIngestSidecarChars?: number;
  // Tier 2 tuning knobs (zet.7): image generation polling limits
  imageFalTimeoutMs?: number;
  imageFalPollIntervalMs?: number;
  imageComfyTimeoutMs?: number;
  imageComfyPollIntervalMs?: number;
  webFetchAllowHttp?: boolean;
  webFetchDomainAllowlist?: string[];
  webFetchAllowInternalNetwork?: boolean;
  homeAssistantEnabled?: boolean;
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
  shellExec?: ShellExecSettings;
  /** Override the base URL used by Garden Chat to reach the OpenAI-compatible API.
   *  When set, this takes priority over the `API_BASE_URL` env var and the
   *  auto-resolved URL derived from `API_HOST`/`API_PORT`. Useful when the
   *  API server is behind a reverse proxy or on a non-standard URL. */
  chatApiBaseUrl?: string;
  comfyUiBaseUrl?: string;
  imageProvider?: ImageProvider;
  imageFalCreateModel?: FalCreateModel;
  imageFalEditModel?: FalEditModel;
  imageSelfieEditModel?: FalEditModel;
  imageWorkflows?: ImageWorkflowSettings;
  /** Active IANA timezone. Precedence: settings.json > env TZ (bootstrap) > default. */
  activeTimezone?: string;
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
  voiceSessionTimeoutMs?: number;
  voiceMaxFrameBytes?: number;
  voiceMaxPendingFrames?: number;
  voiceReplySegmenter?: VoiceReplySegmenterSettings;

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
  'modelPurposeSelection',
  'sessionHistoryBudgetPct',
  'memoryRetrievalBudgetPct',
  'moodCongruenceWeight',
  'adaptiveContextBudgetsEnabled',
  'wikiRetrievalEnabled',
  'wikiRetrievalChatTokenCap',
  'wikiRetrievalGroupTokenCap',
  'wikiRetrievalFocusTokenCap',
  'wikiRetrievalSimilarityThreshold',
  'wikiRetrievalGroupSimilarityThreshold',
  'wikiStartupHydration',
  'lifecycleKubernetes',
  'cogSecPersonaConformance',
  'sessionMirrorEnabled',
  'sessionMirrorMaxChars',
  'sessionMirrorActiveWindowMs',
  'sessionMirrorChannelOverrides',
  'continuityMessageLimit',
  'sessionRestartBehavior',
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
  'memoryDeletionPolicy',
  'memoryRetrievalPolicy',
  'memoryPresentationProfile',
  'memoryRefreshFailureAlertThreshold',
  'groupMemory',
  'emotionScoping',
  'profileSynthesisEnabled',
  'profileSynthesisRefreshIntervalMs',
  'profileSynthesisCooldownMs',
  'profileSynthesisMinWrites',
  'profileSynthesisMinImportance',
  'profileSynthesisMinConfidence',
  'profileSynthesisMinNovelty',
  'profileSynthesisSourceMemoryLimit',
  'profileSynthesisMinSourceMemories',
  'analysisWorkbenchMaxTokens',
  'analysisWorkbenchMaxWallTimeMs',
  'analysisWorkbenchDirectResponseTimeoutMs',
  'analysisWorkbenchMaxSubQueries',
  'analysisWorkbenchExecutionTimeoutMs',
  'analysisWorkbenchOutputTruncation',
  'fsReadMaxBytes',
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
  'observerEvalSidecar',
  'sessionTailCache',
  'webFetchAllowHttp',
  'webFetchDomainAllowlist',
  'webFetchAllowInternalNetwork',
  'homeAssistantEnabled',
  'webFetchLocalCrawlerEnabled',
  'webFetchLocalCrawlerAllowHttp',
  'webFetchLocalCrawlerHostAllowlist',
  'webFetchLocalCrawlerDomainAllowlist',
  'webFetchTlsCaCertPaths',
  'capabilityTier',
  'promotedExtendedTools',
  'shellExec',
  'chatApiBaseUrl',
  'comfyUiBaseUrl',
  'imageProvider',
  'imageFalCreateModel',
  'imageFalEditModel',
  'imageSelfieEditModel',
  'imageWorkflows',
  'activeTimezone',
  'uiThemeId',
  // Voice / TTS
  'voiceEnabled',
  'ttsProvider',
  'voiceId',
  'voiceTargetGuildId',
  'voiceTargetUserId',
  'voiceReadyCueText',
  'echoTtsUrl',
  'echoTtsVoice',
  'echoTtsPreset',
  'sttProvider',
  'deepgramModel',
  'deepgramSttEndpoint',
  'deepgramListenEndpoint',
  'elevenLabsModelId',
  'elevenLabsEndpointBase',
  'voiceSessionTimeoutMs',
  'voiceMaxFrameBytes',
  'voiceMaxPendingFrames',
  'voiceReplySegmenter',
  // Channels
  'discordTriggerWords',
  'discordTriggerReactions',
  'discordTriggerListenWindowMs',
  'telegramEnabled',
  'telegramAuthorizedUsers',
  'wyomingShardRouting',
  'shardToolsets',
  // Tier 2 tuning knobs (zet.7)
  'subagentMaxConcurrent',
  'shardMaxConcurrent',
  'shardHeartbeatStaleAfterMs',
  'shardHeartbeatDisconnectAfterMs',
  'documentIngestMaxBytes',
  'documentIngestTextMaxBytes',
  'documentIngestPromptChars',
  'documentIngestSidecarChars',
  'imageFalTimeoutMs',
  'imageFalPollIntervalMs',
  'imageComfyTimeoutMs',
  'imageComfyPollIntervalMs',
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
  | GroupMemorySettings
  | EmotionScopingSettings
  | MemoryRetrievalPolicy
  | MemoryPresentationProfile
  | MemoryDeletionPolicy
  | ObserverEvalSidecarSettings
  | SessionTailCacheSettings
  | ShellExecSettings
  | WikiStartupHydrationSettings
  | LifecycleKubernetesSettings
  | CogSecPersonaConformanceSettings
  | VoiceReplySegmenterSettings
  | ImageWorkflowSettings
  | ModelPurposeSelection
  | Record<string, boolean>
  | Partial<Record<'nursery' | 'apprentice' | 'autonomous' | 'custom', string[]>>
  | { enabled: boolean; siteAllowlist?: string[]; satelliteAllowlist?: string[] };
export type RuntimeSettingsSnapshot = Record<RuntimeSettingKey, RuntimeSettingValue>;
