import type {
  FalCreateModel,
  FalEditModel,
  ImageProvider,
  ImageWorkflowSettings,
} from '../../primitives/images/types.js';
import type { CredentialReference, CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import type { StreamingSttProvider } from '../../primitives/voice/connectors/stt/index.js';
import type { StreamingTtsProvider } from '../../primitives/voice/connectors/tts/index.js';
import type { CapabilityTier } from '../capabilities/tier-types.js';
import type { ChargePolicyConfig } from './charge-policy-config.js';
import type { SubagentRoleRegistryConfig } from '../../faculties/subagents/role-registry.js';
import type {
  CompanionRuntimeIdentity,
  ResolvedCompanionsFleetConfig,
} from './companions-config.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { GroupMemorySettings } from './group-memory-config.js';
import type { EmotionScopingSettings } from './emotion-scoping-config.js';
import type { NarrativeEmotionAppraisalSettings } from './narrative-emotion-appraisal-config.js';
import type { MemoryRetrievalPolicy } from './memory-retrieval-policy.js';
import type { MemoryPresentationProfile } from './memory-presentation-profile.js';
import type { MemoryDeletionPolicy } from './memory-deletion-policy.js';
import type { BiographicalDepthPolicy } from './biographical-depth-policy.js';
import type { ShellExecSettings } from './shell-exec-config.js';
import type { RuntimeCompanionId } from '../../shared/routing/companion-id.js';
import type {
  FleetAuthConfig,
  FleetAuthVerifierConfig,
} from './fleet-auth-config.js';
import type {
  CanonicalModelRegistry,
  CanonicalProviderRegistry,
  ChannelType,
  CompositionalPurpose,
  ImportProcessingRouteMode,
  ModelCatalogEntry,
  ModelPurpose,
  ModelPurposeSelection,
  ModelRoleAssignments,
  ModelSlot,
  ObserverEvalSidecarSettings,
  ResponseStyleOverrides,
  RuntimeConfigHooks,
  TextEmotionDType,
} from '../../shared/contracts/runtime.js';
import type { CogSecPersonaConformanceSettings } from '../../shared/contracts/cogsec-persona-conformance.js';

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

export function createDefaultObserverEvalSidecarLeverSettings(): NonNullable<ObserverEvalSidecarSettings['levers']> {
  return {
    enabled: false,
    cooldownMs: 21_600_000,
    wouldMessage: {
      enabled: true,
      socialNeedThreshold: 0.7,
      attachmentIntensityThreshold: 0.5,
      sustainMs: 1_800_000,
    },
    wouldCheckIn: {
      enabled: true,
      valenceThreshold: -0.3,
      sustainMs: 1_200_000,
    },
    wouldRest: {
      enabled: true,
      arousalThreshold: 0.8,
      sustainMs: 1_800_000,
    },
    ruminationWatch: {
      enabled: true,
      intensityThreshold: 0.4,
      sustainMs: 2_700_000,
    },
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
      sessionLabel: 'psfn-observer-eval',
      agentName: 'psfn-companion',
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
    levers: createDefaultObserverEvalSidecarLeverSettings(),
  };
}

export interface WyomingShardRoutingConfig {
  enabled: boolean;
  siteAllowlist?: string[];
  satelliteAllowlist?: string[];
}

/**
 * Optional Redis-backed hot session tail (psfn-framework-hgw3.5). Owned by
 * settings.json. Enablement and the per-channel bound live here; the Redis
 * connection itself (URL, credentials, TLS) stays in `.env` (PSFN_REDIS_URL
 * and friends — see src/shared/cache/redis-cache.ts). Disabled by default:
 * deployments without Redis keep byte-identical file-only session reads.
 */
export interface SessionTailCacheSettings {
  enabled: boolean;
  maxEntriesPerChannel: number;
}

export const SESSION_TAIL_CACHE_MAX_ENTRIES_RANGE = {
  min: 16,
  max: 8_192,
} as const;

export function createDefaultSessionTailCacheSettings(): SessionTailCacheSettings {
  return {
    enabled: false,
    maxEntriesPerChannel: 512,
  };
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
  companionId?: RuntimeCompanionId;
  /**
   * True when the mandatory companions.json manifest enumerates more than one
   * companion (multi-companion tenancy). A one-entry manifest is the canonical
   * single-companion deployment and leaves this false.
   */
  multiCompanion?: boolean;
  /**
   * Resolved fleet manifest. Always present in the operator process and in
   * Fleet Auth/multi-companion gateway and agent processes.
   */
  companionFleet?: ResolvedCompanionsFleetConfig;
  /** Fleet-bound process identity for an agent/gateway using fleet routing. */
  companionRuntimeIdentity?: CompanionRuntimeIdentity;
  /** Per-companion proof used only during gateway connection authentication. */
  gatewayCompanionAuthToken?: string;
  /** Role-bound proof delegated only to the session-integrity worker. */
  gatewaySessionIntegrityAuthToken?: string;
  systemDataDir?: string;
  companionDataDir?: string;
  workspacePath?: string;
  /** Governed fleet-shared workspace. Never inherited from environment. */
  sharedWorkspacePath?: string;
  dataDir: string;
  databasePath: string;
  persistenceBackend?: PersistenceBackend;
  postgresDatabaseUrl?: string;
  /** Gateway-only full owner-file projection; never present in agent/operator config. */
  fleetAuth?: FleetAuthConfig;
  /** Public-key-only projection supplied to operator/agent verifier processes. */
  fleetAuthVerifier?: FleetAuthVerifierConfig;
  /**
   * Optional per-companion Postgres schema (sprint 10, W2 multi-companion
   * tenancy). When set, the agent's runtime persistence pools pin their
   * search_path to this schema so all queries run inside it unchanged; the
   * schema is created on startup if missing. When unset, runtime persistence
   * uses the default (`public`) schema — byte-identical to single-companion
   * behavior. Sourced from the `COMPANION_PG_SCHEMA` env var (see load-config).
   */
  postgresSchema?: string;
  /**
   * Topology-owned PostgreSQL role paired with `postgresSchema`. In a
   * multi-companion agent this is resolved from the matching companions.json
   * entry and must match the delivered database credential.
   */
  postgresRole?: string;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  continuityMessageLimit?: number;
  memoryRetrievalLimit?: number;
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
  /** settings.json-owned startup wiki cache hydration volume. */
  wikiStartupHydration?: WikiStartupHydrationSettings;
  /** settings.json-owned lifecycle and Kubernetes operational policy. */
  lifecycleKubernetes?: LifecycleKubernetesSettings;
  /** Per-companion JSON-owned baseline for CogSec persona drift detection. */
  cogSecPersonaConformance?: CogSecPersonaConformanceSettings;
  extractionInterval: number;
  maintenanceIntervalMs: number;
  defaultContextWindow: number;
  extractionThresholdPct: number;
  compactionThresholdPct: number;
  observationMaskingWindow?: number;
  compactionEmotionalSalienceThresholdPct?: number;
  /**
   * Consecutive unhandled rejections from one origin before runtime
   * diagnostics records an operator-visible escalation. Owned by settings.json.
   */
  backgroundFailureEscalationThreshold?: number;
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
  /** settings.json-owned categories and eligibility for companion-raised deletion proposals. */
  memoryDeletionPolicy?: MemoryDeletionPolicy;
  memoryRetrievalPolicy?: MemoryRetrievalPolicy;
  /** Owner-configured adaptive biographical collection economics. */
  biographicalDepthPolicy?: BiographicalDepthPolicy;
  /**
   * Versioned, schema-validated presentation profile for the retrieval
   * formatting layer (ordering, headings, valence markers, recency labels,
   * episode cap, display caps, withheld wording). Governs presentation only,
   * never selection. Owned by settings.json.
   */
  memoryPresentationProfile?: MemoryPresentationProfile;
  /**
   * Consecutive failed active-memory context refreshes (per context key)
   * before an operator alert is raised via the system-derived notification
   * path (E5.5). Owned by settings.json.
   */
  memoryRefreshFailureAlertThreshold?: number;
  /**
   * Fail-closed intake screening events per stage/source class before one
   * deduplicated operator alert is raised. Owned by settings.json.
   */
  intakeScreeningFailureAlertThreshold?: number;
  groupMemory?: GroupMemorySettings;
  emotionScoping?: EmotionScopingSettings;
  /** settings.json-owned gate for expensive narrative emotion appraisal. */
  narrativeEmotionAppraisal?: NarrativeEmotionAppraisalSettings;
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
  /**
   * Per-companion model selection (23pp): canonical purpose → models.json slot
   * key from the companion's effective runtime settings. Validated fail-closed
   * against the registry after models hydration; leads the lane's routing chain.
   */
  modelPurposeSelection?: ModelPurposeSelection;
  providerRegistry?: CanonicalProviderRegistry;
  credentialVault?: CredentialVaultPort;
  openRouterApiBaseUrl?: string;
  openRouterApiKeyRef?: CredentialReference;
  /**
   * OpenRouter server-tools web backend selection (bead htm9.10),
   * projected from providers.json `openrouter.metadata.webTools`. When enabled,
   * the gateway routes web search/fetch through OpenRouter's built-in server
   * tools instead of the self-hosted crawler lane.
   */
  openRouterWebTools?: { enabled: boolean; model: string };
  responseStyleOverrides?: ResponseStyleOverrides;
  runtimeHooks?: RuntimeConfigHooks;
  promotedExtendedTools?: string[];
  /** settings.json-owned gateway shell execution policy and hard limits. */
  shellExec?: ShellExecSettings;
  capabilityTier?: CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  observerEvalSidecar?: ObserverEvalSidecarSettings;
  sessionTailCache?: SessionTailCacheSettings;
  shardToolsets?: ShardToolsetConfig;
  /**
   * bead 7ym.2.1 — schema-owned subagent role registry (subagent-roles.json).
   * Named role profiles layered over inherited companion identity; each role may
   * only narrow the tools/limits the parent tier grants. Absent/empty ⇒ no roles
   * configured (unknown-role spawns fail closed).
   */
  subagentRoles?: SubagentRoleRegistryConfig;
  /** Concurrency cap on simultaneously active subagent tasks (zet.7). */
  subagentMaxConcurrent?: number;
  /** Concurrency cap on simultaneously active shards (zet.7). */
  shardMaxConcurrent?: number;
  /** Shard heartbeat silence (ms) before a shard is marked degraded/stale (zet.7). */
  shardHeartbeatStaleAfterMs?: number;
  /** Shard heartbeat silence (ms) before a shard is marked offline (zet.7). */
  shardHeartbeatDisconnectAfterMs?: number;
  /** Max document attachment size accepted by file ingest (bytes, zet.7). */
  documentIngestMaxBytes?: number;
  /** Max plain-text attachment size accepted by file ingest (bytes, zet.7). */
  documentIngestTextMaxBytes?: number;
  /** Char cap on parsed attachment text injected into the prompt (zet.7). */
  documentIngestPromptChars?: number;
  /** Char cap on parsed attachment text written to the sidecar file (zet.7). */
  documentIngestSidecarChars?: number;
  /** Overall wait cap (ms) for FAL image queue results (zet.7). */
  imageFalTimeoutMs?: number;
  /** Poll cadence (ms) for FAL image queue status (zet.7). */
  imageFalPollIntervalMs?: number;
  /** Overall wait cap (ms) for ComfyUI workflow completion (zet.7). */
  imageComfyTimeoutMs?: number;
  /** Poll cadence (ms) for ComfyUI workflow history (zet.7). */
  imageComfyPollIntervalMs?: number;
  voiceEnabled?: boolean;
  discordBackfillOnStartup?: boolean;
  discordTriggerWords?: string[];
  discordTriggerReactions?: string[];
  discordTriggerListenWindowMs?: number;
  characterName?: string;
  /**
   * Companion's active IANA timezone (settings.json-owned). Precedence, fail-closed:
   * settings.json activeTimezone (validated IANA) > env TZ (bootstrap only, validated)
   * > 'America/New_York' default. Installed into the shared active-timezone module at
   * settings load; consumed live by every formatter, the scheduler, and rest windows.
   */
  activeTimezone?: string;
  uiThemeId?: string;
  voiceTargetGuildId?: string;
  voiceTargetUserId?: string;
  voiceReadyCueText?: string;
  voiceDaveEncryption?: boolean;
  voiceDecryptionFailureTolerance?: number;
  /** Idle-connection timeout for the voice websocket session before force-close. */
  voiceSessionTimeoutMs?: number;
  /** Maximum inbound voice websocket frame size (bytes) before rejection. */
  voiceMaxFrameBytes?: number;
  /** Backpressure cap on queued inbound voice frames before overflow close. */
  voiceMaxPendingFrames?: number;
  /** settings.json-owned committed voice reply segmentation thresholds. */
  voiceReplySegmenter?: VoiceReplySegmenterSettings;
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
  imageProvider?: ImageProvider;
  imageFalCreateModel?: FalCreateModel;
  imageFalEditModel?: FalEditModel;
  imageSelfieEditModel?: FalEditModel;
  imageWorkflows?: ImageWorkflowSettings;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  echoTtsModel?: string;
  analysisWorkbenchMaxTokens?: number;
  analysisWorkbenchMaxWallTimeMs?: number;
  /** Shared response-wait window for direct-parent Workbench execution. */
  analysisWorkbenchDirectResponseTimeoutMs?: number;
  analysisWorkbenchMaxSubQueries?: number;
  /** Operator override for the analysis workbench iteration cap (turns). */
  analysisWorkbenchMaxIterations?: number;
  /** Per-code-block sandbox execution timeout (ms) for the analysis workbench. */
  analysisWorkbenchExecutionTimeoutMs?: number;
  /** Character cap on a single analysis-workbench code execution's output. */
  analysisWorkbenchOutputTruncation?: number;
  /** Default byte page size for the unified filesystem read tool. */
  fsReadMaxBytes?: number;
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

export interface WikiStartupHydrationSettings {
  recentSessionLimit: number;
  recentMessageLimit: number;
  maxContextChars: number;
}

export interface VoiceReplySegmenterSettings {
  minSegmentLength: number;
  maxBufferLength: number;
}

/**
 * Mutable operational limits for lifecycle commands and the Kubernetes
 * self-management surfaces. Network coordinates and credentials remain
 * environment-owned; immutable protocol and response-size guards remain code-owned.
 */
export interface LifecycleKubernetesSettings {
  lifecycleCommandTimeoutMs: number;
  operatorCommandTimeoutMs: number;
  operatorHttpTimeoutMs: number;
  operatorConfirmationRequestTimeoutMs: number;
  kubernetesReadRequestTimeoutMs: number;
  kubernetesRolloutRequestTimeoutMs: number;
  rolloutWaitTimeoutMs: number;
  rolloutPollIntervalMs: number;
  rollbackWaitTimeoutMs: number;
  rollbackPollIntervalMs: number;
  postRolloutMaxLogRecords: number;
  postRolloutValidationHistoryLimit: number;
  rollbackHistoryLimit: number;
}
export const DEFAULT_MOOD_CONGRUENCE_WEIGHT = 0.15;
export const DEFAULT_UI_THEME_ID = 'garden';

export const CORE_SECRET_BEARING_CONFIG_KEYS = [
  'credentialVault',
  'discordToken',
  'discordBotId',
  'gatewayCompanionAuthToken',
  'gatewaySessionIntegrityAuthToken',
  'postgresDatabaseUrl',
  'fleetAuth',
  'openRouterApiKeyRef',
  'deepgramApiKey',
  'elevenLabsApiKey',
  'falApiKey',
] as const;

export type CoreSecretBearingConfigKey = (typeof CORE_SECRET_BEARING_CONFIG_KEYS)[number];

export interface CoreSubstrateConfig extends SubstrateConfig {
  credentialVault?: never;
  discordToken?: never;
  discordBotId?: never;
  gatewayCompanionAuthToken?: never;
  gatewaySessionIntegrityAuthToken?: never;
  postgresDatabaseUrl?: never;
  fleetAuth?: never;
  openRouterApiKeyRef?: never;
  deepgramApiKey?: never;
  elevenLabsApiKey?: never;
  falApiKey?: never;
}

export function sanitizeCoreSubstrateConfig(config: SubstrateConfig): CoreSubstrateConfig {
  const {
    credentialVault: _credentialVault,
    discordToken: _discordToken,
    discordBotId: _discordBotId,
    gatewayCompanionAuthToken: _gatewayCompanionAuthToken,
    gatewaySessionIntegrityAuthToken: _gatewaySessionIntegrityAuthToken,
    postgresDatabaseUrl: _postgresDatabaseUrl,
    fleetAuth: _fleetAuth,
    openRouterApiKeyRef: _openRouterApiKeyRef,
    deepgramApiKey: _deepgramApiKey,
    elevenLabsApiKey: _elevenLabsApiKey,
    falApiKey: _falApiKey,
    ...coreConfig
  } = config;

  return coreConfig as CoreSubstrateConfig;
}
