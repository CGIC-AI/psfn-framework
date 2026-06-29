import type { ImageWorkflowSettings } from '../../primitives/images/types.js';
import type { CredentialReference, CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import type { StreamingSttProvider } from '../../primitives/voice/connectors/stt/index.js';
import type { StreamingTtsProvider } from '../../primitives/voice/connectors/tts/index.js';
import type { CapabilityTier } from '../capabilities/tier-types.js';
import type { ChargePolicyConfig } from './charge-policy-config.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { GroupMemorySettings } from './group-memory-config.js';
import type {
  CanonicalModelRegistry,
  CanonicalProviderRegistry,
  ChannelType,
  CompositionalPurpose,
  ImportProcessingRouteMode,
  ModelCatalogEntry,
  ModelPurpose,
  ModelRoleAssignments,
  ModelSlot,
  ObserverEvalSidecarSettings,
  ResponseStyleOverrides,
  RuntimeConfigHooks,
  TextEmotionDType,
} from '../../shared/contracts/runtime.js';

export type { CapabilityTier } from '../capabilities/tier-types.js';
export type ShardToolsetConfig = Partial<Record<CapabilityTier, string[]>>;
export type SessionRestartBehavior = 'reuse_latest_session' | 'new_session';
export type PersistenceBackend = 'postgres';
export const PROMOTED_EXTENDED_TOOL_SLOTS_MAX = 4;

export interface CompositionalPolicyConfig {
  enabled: boolean;
  allowedTiers: CapabilityTier[];
  allowedChannelTypes: ChannelType[];
  allowedPurposes: CompositionalPurpose[];
}

export function createDefaultCompositionalPolicyConfig(): CompositionalPolicyConfig {
  return {
    enabled: false,
    allowedTiers: [],
    allowedChannelTypes: [],
    allowedPurposes: [],
  };
}

export function createDefaultObserverEvalSidecarSettings(): ObserverEvalSidecarSettings {
  return {
    enabled: false,
    sidecarId: 'observer-eval-sidecar',
    deploymentTarget: 'test_persona',
    mode: 'observe_only',
    queue: {
      maxQueuedTurns: 32,
      overflowPolicy: 'drop_newest',
      observerTimeoutMs: 5_000,
      maxRetries: 0,
      retryDelayMs: 0,
      shutdownDrainTimeoutMs: 5_000,
    },
    adapter: {
      kind: 'disabled',
      includeWorldState: false,
    },
    persistence: {
      enabled: false,
      retentionDays: 14,
      maxStoredObservations: 10_000,
    },
    garden: {
      exposeHealth: true,
      exposeTelemetry: true,
    },
  };
}

export interface WyomingShardRoutingConfig {
  enabled: boolean;
  siteAllowlist?: string[];
  satelliteAllowlist?: string[];
}

export interface SubstrateConfig {
  [key: string]: unknown;
  primaryModel: string;
  primaryProvider: string;
  extractionModel: string;
  extractionProvider: string;
  primaryMaxTokens: number;
  extractionMaxTokens: number;
  discordToken?: string;
  discordBotId?: string;
  characterCardPath: string;
  companionId?: string;
  systemDataDir?: string;
  companionDataDir?: string;
  workspacePath?: string;
  dataDir: string;
  databasePath: string;
  persistenceBackend?: PersistenceBackend;
  postgresDatabaseUrl?: string;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  continuityMessageLimit?: number;
  memoryRetrievalLimit?: number;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
  moodCongruenceWeight?: number;
  adaptiveContextBudgetsEnabled?: boolean;
  extractionInterval: number;
  maintenanceIntervalMs: number;
  defaultContextWindow: number;
  extractionThresholdPct: number;
  compactionThresholdPct: number;
  observationMaskingWindow?: number;
  compactionEmotionalSalienceThresholdPct?: number;
  sessionMirrorEnabled?: boolean;
  sessionMirrorMaxChars?: number;
  sessionMirrorActiveWindowMs?: number;
  sessionMirrorChannelOverrides?: Record<string, boolean>;
  memoryExtractionMinImportance?: number;
  memoryExtractionMinConfidence?: number;
  memoryExtractionMinNovelty?: number;
  memoryExtractionEmotionalIntensityWeight?: number;
  memoryExtractionMaxWrites?: number;
  memoryExtractionTelemetryEnabled?: boolean;
  memoryRetrievalTelemetryEnabled?: boolean;
  groupMemory?: GroupMemorySettings;
  profileSynthesisEnabled?: boolean;
  profileSynthesisRefreshIntervalMs?: number;
  profileSynthesisCooldownMs?: number;
  profileSynthesisMinWrites?: number;
  profileSynthesisMinImportance?: number;
  profileSynthesisMinConfidence?: number;
  profileSynthesisMinNovelty?: number;
  profileSynthesisSourceMemoryLimit?: number;
  profileSynthesisMinSourceMemories?: number;
  modelRoster: Partial<Record<ModelPurpose, ModelSlot>>;
  modelCatalog?: Record<string, ModelCatalogEntry>;
  modelRoleAssignments?: ModelRoleAssignments;
  modelRegistry?: CanonicalModelRegistry;
  providerRegistry?: CanonicalProviderRegistry;
  credentialVault?: CredentialVaultPort;
  litellmBaseUrl?: string;
  litellmApiKeyRef?: CredentialReference;
  openRouterApiBaseUrl?: string;
  openRouterApiKeyRef?: CredentialReference;
  responseStyleOverrides?: ResponseStyleOverrides;
  runtimeHooks?: RuntimeConfigHooks;
  promotedExtendedTools?: string[];
  capabilityTier?: CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  observerEvalSidecar?: ObserverEvalSidecarSettings;
  shardToolsets?: ShardToolsetConfig;
  voiceEnabled?: boolean;
  discordBackfillOnStartup?: boolean;
  discordTriggerWords?: string[];
  discordTriggerReactions?: string[];
  discordTriggerListenWindowMs?: number;
  characterName?: string;
  uiThemeId?: string;
  voiceTargetGuildId?: string;
  voiceTargetUserId?: string;
  voiceReadyCueText?: string;
  voiceDaveEncryption?: boolean;
  voiceDecryptionFailureTolerance?: number;
  sttProvider?: StreamingSttProvider | 'disabled';
  ttsProvider?: StreamingTtsProvider | 'disabled';
  deepgramApiKey?: string;
  deepgramModel?: string;
  deepgramSttEndpoint?: string;
  deepgramListenEndpoint?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  elevenLabsEndpointBase?: string;
  falApiKey?: string;
  comfyUiBaseUrl?: string;
  imageWorkflows?: ImageWorkflowSettings;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  echoTtsModel?: string;
  analysisWorkbenchMaxTokens?: number;
  analysisWorkbenchMaxWallTimeMs?: number;
  analysisWorkbenchMaxSubQueries?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  openRouterProviderOrder?: string[];
  openRouterModelsApiUrl?: string;
  importProcessingRouteMode?: ImportProcessingRouteMode;
  importProcessingStrictPolicy?: boolean;
  importProcessingLocalEndpointUrl?: string;
  importProcessingLocalModel?: string;
  embeddingProvider?: 'ollama' | 'transformers' | 'api';
  embeddingModel?: string;
  embeddingDims?: number;
  embeddingOllamaUrl?: string;
  transformersModel?: string;
  transformersCacheDir?: string;
  textEmotionModel?: string;
  textEmotionCacheDir?: string;
  textEmotionDtype?: TextEmotionDType;
  embeddingApiUrl?: string;
  embeddingApiModel?: string;
  embeddingApiDims?: number;
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
  /** Path to a CA certificate file (PEM) to trust for all outbound TLS connections (LLM, embeddings, etc.). Sets NODE_EXTRA_CA_CERTS at startup. */
  gatewayTlsCaPath?: string;
  /** Dev/test-only request for endpoint-scoped TLS verification exceptions. Rejected in production; never maps to NODE_TLS_REJECT_UNAUTHORIZED. */
  gatewayTlsRejectUnauthorized?: boolean;
  wyomingShardRouting?: WyomingShardRoutingConfig;
  wyomingEnabled?: boolean;
  wyomingHost?: string;
  wyomingPort?: number;

  // ── Telegram ──
  telegramEnabled?: boolean;
  telegramAuthorizedUsers?: string[];

  // ── Obsidian vault ──
  obsidianVaultName?: string;
  obsidianCliPath?: string;
  obsidianAutoPublish?: boolean;
  obsidianTimeoutMs?: number;

  // ── Charge policy ──
  chargePolicy?: ChargePolicyConfig;

  // ── Satellite claim registry ──
  satelliteRegistry?: SatelliteRegistryConfig;

  // ── MoA (Mixture of Agents) ──
  moaEnabled?: boolean;
  moaReferenceModels?: string[];
  moaAggregatorModel?: string;
  moaMaxRounds?: number;
  moaMaxTokensPerRound?: number;
  moaTimeoutMs?: number;
}
export const DEFAULT_MOOD_CONGRUENCE_WEIGHT = 0.15;
export const DEFAULT_UI_THEME_ID = 'garden';

export const CORE_SECRET_BEARING_CONFIG_KEYS = [
  'credentialVault',
  'discordToken',
  'discordBotId',
  'litellmApiKeyRef',
  'openRouterApiKeyRef',
  'deepgramApiKey',
  'elevenLabsApiKey',
  'falApiKey',
] as const;

export type CoreSecretBearingConfigKey = (typeof CORE_SECRET_BEARING_CONFIG_KEYS)[number];

export type CoreSubstrateConfig = Omit<SubstrateConfig, CoreSecretBearingConfigKey>;

export function sanitizeCoreSubstrateConfig(config: SubstrateConfig): CoreSubstrateConfig {
  const {
    credentialVault: _credentialVault,
    discordToken: _discordToken,
    discordBotId: _discordBotId,
    litellmApiKeyRef: _litellmApiKeyRef,
    openRouterApiKeyRef: _openRouterApiKeyRef,
    deepgramApiKey: _deepgramApiKey,
    elevenLabsApiKey: _elevenLabsApiKey,
    falApiKey: _falApiKey,
    ...coreConfig
  } = config;

  return coreConfig;
}
