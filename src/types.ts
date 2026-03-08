import {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
} from './context-budget.js';
import type { ModelContextBudgetConfig } from './context-budget-contracts.js';
import type { ContextManifest } from './session/context-manifest.js';
import type { StreamingSttProvider } from './voice/connectors/stt/index.js';
import type { StreamingTtsProvider } from './voice/connectors/tts/index.js';
import { resolveRuntimePathLayout } from './persistence/layout.js';
import { parseOptionalStringEnv } from './utils/env.js';

// ── Channel-agnostic message types ──

export const CHANNEL_TYPES = ['discord', 'terminal', 'api', 'telegram'] as const;
export type ChannelType = typeof CHANNEL_TYPES[number];

declare const turnIdBrand: unique symbol;
export type TurnID = string & { readonly [turnIdBrand]: true };

export interface TurnRecordMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  sessionEntryId?: number;
  sourceMessageId?: string;
  authorId?: string;
  authorName?: string;
}

export interface TurnRecordToolCall {
  toolName: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface TurnRecordVersionPointers {
  model: string;
  promptMode?: MessagePromptOverrideMode;
  promptHash?: string;
  promptStack?: string;
  memoryState?: string;
  sessionState?: string;
}

export interface TurnRecord {
  schemaVersion: 1;
  turnId: TurnID;
  requestId: string;
  channelId: string;
  channelType: ChannelType;
  startedAt: number;
  completedAt: number;
  status: 'completed' | 'failed';
  userMessage: TurnRecordMessage;
  assistantMessage?: TurnRecordMessage;
  toolCalls: TurnRecordToolCall[];
  contextManifestRef?: string;
  internalStateSnapshotRef?: string;
  extractedMemoryIds: string[];
  concernDeltaRefs: string[];
  contactDeltaRefs: string[];
  versionPointers: TurnRecordVersionPointers;
  provenanceRefs: string[];
}

export interface WyomingShardDelegationHint {
  eligible: boolean;
  reason: string;
}

export interface WyomingRoutingMetadata {
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
  shardDelegation?: WyomingShardDelegationHint;
}

export interface BroadcastRoutingMetadata {
  approvalToken?: string;
  visibilityScope?: 'public_only' | 'approved_private_context';
}

export type ModelThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelControlKnobs {
  maxTokens?: number;
  contextWindow?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: ModelThinkingEffort;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

export interface LLMModelHint extends ModelControlKnobs {
  model?: string;
  provider?: string;
}

export interface MessageModelOverride extends ModelControlKnobs {
  provider: string;
  model: string;
  slotKey?: string;
  purpose?: ModelPurpose;
}

export type MessagePromptOverrideMode = 'default' | 'none' | 'custom';

export interface MessagePromptOverride {
  mode: MessagePromptOverrideMode;
  systemPrompt?: string;
}

export type ResponseStyle = 'concise' | 'expressive';

export interface ResponseStyleOverrides {
  exact?: Record<string, ResponseStyle>;
  prefix?: Record<string, ResponseStyle>;
  channelType?: Record<string, ResponseStyle>;
  defaultStyle?: ResponseStyle;
}

export type ObservabilityCallType =
  | 'chat'
  | 'tool'
  | 'memory'
  | 'summary'
  | 'background'
  | 'scheduled';

export interface LLMRequestMetadata {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
  originType?: ObservabilityCallType;
  originStage?: string;
}

export interface CorrelationMetadata extends LLMRequestMetadata {
  callType: ObservabilityCallType;
  purpose: string;
}

export interface MessageRoutingMetadata {
  source?: 'wyoming' | 'discord' | 'api' | 'unknown';
  wyoming?: WyomingRoutingMetadata;
  broadcast?: BroadcastRoutingMetadata;
  modelOverride?: MessageModelOverride;
  promptOverride?: MessagePromptOverride;
  responseStyle?: ResponseStyle;
}

export interface SubstrateMessage {
  id: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  content: string;
  attachments?: Attachment[];
  timestamp: Date;
  /** True for direct/private messages (e.g. Discord DMs). Adapters set this explicitly. */
  isDirectMessage?: boolean;
  /** Optional transport/runtime routing hints (e.g. Wyoming session policy decisions). */
  routing?: MessageRoutingMetadata;
}

export interface Attachment {
  url: string;
  contentType: string;
  name: string;
}

export interface AgentResponse {
  content: string;
  channelId: string;
  metadata: ResponseMetadata;
}

export interface PostTurnActionCandidate {
  kind: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  maxRetries?: number;
}

export interface InferredPostTurnAction {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  channelId: string;
  sourceMessageId: string;
  inferredAt: number;
  maxRetries?: number;
}

export interface ResponseMetadata {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  internalState?: import('./self-model/state.js').InternalState;
  internalStateSnapshotRef?: string;
  metacognitiveFlags?: import('./self-model/metacognition.js').MetacognitiveFlag[];
  diagnostics?: {
    fallback?: {
      code: 'vision_empty_response';
      strategy: 'replay_transport_content';
      attempts: number;
      finalContentEmpty: boolean;
      previousStopReason?: string;
      previousErrorMessage?: string;
    };
  };
  broadcastSafety?: {
    visibilityScope: 'public_only' | 'approved_private_context';
    operatorApproval: boolean;
    risky: boolean;
    signals: Array<'sensitive' | 'private' | 'off_brand'>;
    approvalRequired: boolean;
    provenanceRefs: string[];
  };
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmCalls: number;
  toolCalls: number;
  contextUtilization: number;
  estimatedCostUsd?: number;
}

// ── Tool system ──

/** Serializable tool schema — no execute function, safe for wire protocol */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── LLM types ──

export type Role = 'user' | 'assistant';

export interface ContextMessage {
  role: Role;
  content: string;
}

export interface LLMContext {
  systemPrompt: string;
  messages: ContextMessage[];
  tools?: ToolSchema[];
  modelHint?: LLMModelHint;
  correlation?: CorrelationMetadata;
  manifest?: ContextManifest;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onDone?: (response: LLMResponse) => void;
  onError?: (error: Error) => void;
}

export interface LLMResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ── Model roster ──

export type { ModelContextBudgetConfig } from './context-budget-contracts.js';

export interface ModelRouteConfig {
  providerOrder?: string[];
}

export interface ModelSlot {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
  routing?: ModelRouteConfig;
}

export interface ModelSlotDefaults {
  maxTokens?: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
  description?: string;
}

export interface ModelSlotOverrides {
  maxTokens?: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
}

export interface ModelCatalogEntry {
  model: string;
  provider: string;
  defaults?: ModelSlotDefaults;
  overrides?: ModelSlotOverrides;
  routing?: ModelRouteConfig;
}

export type ModelRoleAssignments = Record<string, string>;

export const CANONICAL_MODEL_PURPOSES = [
  'chat',
  'background',
  'extraction',
  'summary',
  'reasoning',
  'import_processing',
  'longContext',
  'vision',
  'moa',
] as const;

export type CanonicalModelPurpose = typeof CANONICAL_MODEL_PURPOSES[number];

export interface ModelRegistryPurposeTag {
  purpose: CanonicalModelPurpose;
  primary: boolean;
}

export interface ModelRegistrySourceMetadata {
  type: string;
  label?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelRegistryIdentityMetadata {
  provider: string;
  model: string;
  source: ModelRegistrySourceMetadata;
  family?: string;
}

export interface ModelRegistryCapabilityMetadata {
  maxOutputTokens?: number;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  [key: string]: unknown;
}

export interface ModelRegistryTuningMetadata extends ModelControlKnobs {
  maxOutputTokens?: number;
  [key: string]: unknown;
}

export interface ModelRegistryCostMetadata {
  inputPer1MUsd?: number;
  outputPer1MUsd?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface ModelRegistryBudgetPolicy {
  enabled: boolean;
  dailyUsdLimit: number;
  monthlyUsdLimit: number;
  currency?: 'USD';
}

export interface ModelRegistryEntry {
  id: string;
  rank: number;
  identity: ModelRegistryIdentityMetadata;
  purposes: ModelRegistryPurposeTag[];
  capabilities?: ModelRegistryCapabilityMetadata;
  tuning?: ModelRegistryTuningMetadata;
  cost?: ModelRegistryCostMetadata;
  metadata?: Record<string, unknown>;
}

export interface CanonicalModelRegistry {
  schemaVersion: 1;
  models: ModelRegistryEntry[];
  budgetPolicy?: ModelRegistryBudgetPolicy;
}

export interface ModelUsageLedgerRecord {
  id: string;
  timestampMs: number;
  dayKey: string;
  monthKey: string;
  provider: string;
  model: string;
  slotKey?: string;
  purpose: string;
  service: string;
  process: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ModelBudgetWindowSnapshot {
  dayKey: string;
  monthKey: string;
  dailySpentUsd: number;
  dailyLimitUsd: number;
  monthlySpentUsd: number;
  monthlyLimitUsd: number;
}

export type ModelBudgetBlockReason =
  | 'daily_budget_exceeded'
  | 'monthly_budget_exceeded'
  | 'missing_cost_metadata';

export interface ModelBudgetBlockedEvent extends Partial<CorrelationMetadata> {
  timestampMs: number;
  reason: ModelBudgetBlockReason;
  purpose: string;
  provider: string;
  model: string;
  slotKey?: string;
  service: string;
  process: string;
  estimatedRequestCostUsd: number;
  budget: ModelBudgetWindowSnapshot;
}

export type ModelPurpose = 'chat' | 'background' | 'context' | 'reasoning' | 'longContext' | 'vision';
export type CompletionPurpose = 'background' | 'context' | 'extraction' | 'summary' | 'reasoning' | 'import_processing';
export type ImportProcessingRouteMode = 'background' | 'openrouter_zdr' | 'local_endpoint';
export const COMPOSITIONAL_PURPOSES = [
  'extraction',
  'retrieval',
  'appraisal',
  'think',
  'shard_context',
] as const;
export type CompositionalPurpose = typeof COMPOSITIONAL_PURPOSES[number];

export const IMPORT_PROCESSING_ROUTE_MODES: readonly ImportProcessingRouteMode[] = [
  'background',
  'openrouter_zdr',
  'local_endpoint',
];

export interface RuntimeConfigHooks {
  refreshModels?: () => void;
  refreshCapabilities?: () => void;
  invalidatePromptPrefixCache?: () => void;
  persistPromotedExtendedTools?: (toolNames: readonly string[]) => void;
}

// ── Configuration ──

export type CapabilityTier = 'nursery' | 'apprentice' | 'autonomous' | 'custom';
export type ShardToolsetConfig = Partial<Record<CapabilityTier, string[]>>;
export type SessionRestartBehavior = 'reuse_latest_session' | 'new_session';
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
  discordToken: string;
  discordBotId: string;
  characterCardPath: string;
  systemDataDir?: string;
  companionDataDir?: string;
  dataDir: string;
  databasePath: string;
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
  memoryBudgetPct: number;
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
  responseStyleOverrides?: ResponseStyleOverrides;
  runtimeHooks?: RuntimeConfigHooks;
  promotedExtendedTools?: string[];
  capabilityTier?: CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
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
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  echoTtsModel?: string;
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
  /** Path to a CA certificate file (PEM) to trust for all outbound TLS connections (LLM, embeddings, etc.). Sets NODE_EXTRA_CA_CERTS at startup. */
  gatewayTlsCaPath?: string;
  /** When explicitly set to false, disables TLS certificate verification (NODE_TLS_REJECT_UNAUTHORIZED=0). DANGEROUS — dev only. */
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

  // ── MoA (Mixture of Agents) ──
  moaEnabled?: boolean;
  moaReferenceModels?: string[];
  moaAggregatorModel?: string;
  moaMaxRounds?: number;
  moaMaxTokensPerRound?: number;
  moaTimeoutMs?: number;
}

const DEFAULT_PRIMARY_MODEL = 'z-ai/glm-5';
const DEFAULT_PRIMARY_PROVIDER = 'openrouter';
const DEFAULT_PRIMARY_MAX_TOKENS = 16_384;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_EXTRACTION_MODEL = 'deepseek/deepseek-v3.2';
const DEFAULT_EXTRACTION_PROVIDER = 'openrouter';
const DEFAULT_EXTRACTION_MAX_TOKENS = 8_192;
const DEFAULT_MODEL_ROLE_ASSIGNMENTS: ModelRoleAssignments = {
  chat: 'primary',
  background: 'extraction',
  context: 'extraction',
  extraction: 'extraction',
  summary: 'primary',
  reasoning: 'primary',
  longContext: 'primary',
  vision: 'primary',
  import_processing: 'extraction',
};
const DEFAULT_SESSION_MESSAGE_LIMIT = 30;
const DEFAULT_MEMORY_RETRIEVAL_LIMIT = 15;
export const DEFAULT_MOOD_CONGRUENCE_WEIGHT = 0.15;
const DEFAULT_EXTRACTION_INTERVAL = 5;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 300_000;
const DEFAULT_MEMORY_BUDGET_PCT = 20;
const DEFAULT_EXTRACTION_THRESHOLD_PCT = 30;
const DEFAULT_COMPACTION_THRESHOLD_PCT = 70;
const DEFAULT_OBSERVATION_MASKING_WINDOW = 10;
const DEFAULT_COMPACTION_EMOTIONAL_SALIENCE_THRESHOLD_PCT = 75;
const DEFAULT_MEMORY_EXTRACTION_MIN_IMPORTANCE = 0.45;
const DEFAULT_MEMORY_EXTRACTION_MIN_CONFIDENCE = 0.6;
const DEFAULT_MEMORY_EXTRACTION_MIN_NOVELTY = 0.35;
const DEFAULT_MEMORY_EXTRACTION_EMOTIONAL_INTENSITY_WEIGHT = 0.2;
const DEFAULT_MEMORY_EXTRACTION_MAX_WRITES = 2;
const DEFAULT_PROFILE_SYNTHESIS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROFILE_SYNTHESIS_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_SYNTHESIS_MIN_WRITES = 1;
const DEFAULT_PROFILE_SYNTHESIS_MIN_IMPORTANCE = 0.65;
const DEFAULT_PROFILE_SYNTHESIS_MIN_CONFIDENCE = 0.7;
const DEFAULT_PROFILE_SYNTHESIS_MIN_NOVELTY = 0.12;
const DEFAULT_PROFILE_SYNTHESIS_SOURCE_MEMORY_LIMIT = 16;
const DEFAULT_PROFILE_SYNTHESIS_MIN_SOURCE_MEMORIES = 2;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_IMPORT_PROCESSING_ROUTE_MODE: ImportProcessingRouteMode = 'background';
const DEFAULT_DISCORD_TRIGGER_REACTIONS = ['👆'] as const;
const DEFAULT_DISCORD_TRIGGER_LISTEN_WINDOW_MS = 120_000;
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
const DEFAULT_CAPABILITY_TIER: CapabilityTier = 'nursery';
const DEFAULT_OBSIDIAN_TIMEOUT_MS = 10_000;
export const DEFAULT_UI_THEME_ID = 'garden';

export function loadConfig(): SubstrateConfig {
  const primaryModel = DEFAULT_PRIMARY_MODEL;
  const primaryProvider = DEFAULT_PRIMARY_PROVIDER;
  const primaryMaxTokens = DEFAULT_PRIMARY_MAX_TOKENS;
  const defaultContextWindow = DEFAULT_CONTEXT_WINDOW;
  const extractionModel = DEFAULT_EXTRACTION_MODEL;
  const extractionProvider = DEFAULT_EXTRACTION_PROVIDER;
  const extractionMaxTokens = DEFAULT_EXTRACTION_MAX_TOKENS;
  const modelCatalog = {
    primary: {
      model: primaryModel,
      provider: primaryProvider,
      defaults: {
        maxTokens: primaryMaxTokens,
        contextWindow: defaultContextWindow,
      },
      overrides: {
        maxTokens: primaryMaxTokens,
      },
    },
    extraction: {
      model: extractionModel,
      provider: extractionProvider,
      defaults: {
        maxTokens: extractionMaxTokens,
      },
      overrides: {
        maxTokens: extractionMaxTokens,
      },
    },
  } satisfies Record<string, ModelCatalogEntry>;
  const modelRoleAssignments: ModelRoleAssignments = {
    ...DEFAULT_MODEL_ROLE_ASSIGNMENTS,
  };
  const modelRegistry: CanonicalModelRegistry = {
    schemaVersion: 1,
    models: [
      {
        id: 'primary',
        rank: 100,
        identity: {
          provider: primaryProvider,
          model: primaryModel,
          source: { type: 'openrouter' },
        },
        purposes: [
          { purpose: 'chat', primary: true },
          { purpose: 'summary', primary: true },
          { purpose: 'reasoning', primary: true },
          { purpose: 'longContext', primary: true },
          { purpose: 'vision', primary: true },
          { purpose: 'moa', primary: true },
        ],
        capabilities: {
          maxOutputTokens: primaryMaxTokens,
          contextWindow: defaultContextWindow,
        },
        tuning: {
          maxOutputTokens: primaryMaxTokens,
        },
      },
      {
        id: 'extraction',
        rank: 80,
        identity: {
          provider: extractionProvider,
          model: extractionModel,
          source: { type: 'openrouter' },
        },
        purposes: [
          { purpose: 'background', primary: true },
          { purpose: 'extraction', primary: true },
          { purpose: 'import_processing', primary: true },
        ],
        capabilities: {
          maxOutputTokens: extractionMaxTokens,
          contextWindow: defaultContextWindow,
        },
        tuning: {
          maxOutputTokens: extractionMaxTokens,
        },
      },
    ],
  };
  const responseStyleOverrides = parseResponseStyleOverridesEnv(process.env.RESPONSE_STYLE_OVERRIDES);
  const gatewayTlsCaPath = parseOptionalStringEnv(process.env.GATEWAY_TLS_CA_PATH);
  const gatewayTlsRejectUnauthorized = parseOptionalBooleanEnv(process.env.GATEWAY_TLS_REJECT_UNAUTHORIZED);
  const discordToken = parseOptionalStringEnv(process.env.DISCORD_TOKEN);
  const discordBotId = parseOptionalStringEnv(process.env.DISCORD_BOT_ID);
  assertMutuallyRequiredEnvPair('DISCORD_TOKEN', discordToken, 'DISCORD_BOT_ID', discordBotId);
  const wyomingShardRouting = parseWyomingShardRoutingConfigEnv(process.env);
  const wyomingEnabled = parseOptionalBooleanEnv(process.env.WYOMING_ENABLED) ?? false;
  const wyomingHost = parseOptionalStringEnv(process.env.WYOMING_HOST) ?? '127.0.0.1';
  const wyomingPort = parseOptionalIntegerEnv(process.env.WYOMING_PORT, 1);
  const shardToolsets = parseShardToolsetEnv(process.env);
  const sessionMirrorEnabled = parseOptionalBooleanEnv(process.env.SESSION_MIRROR_ENABLED);
  const sessionMirrorMaxChars = parseOptionalIntegerEnv(process.env.SESSION_MIRROR_MAX_CHARS, 32);
  const sessionMirrorActiveWindowMs = parseOptionalIntegerEnv(process.env.SESSION_MIRROR_ACTIVE_WINDOW_MS, 1_000);
  const sessionMirrorChannelOverrides = parseBooleanMapEnv(process.env.SESSION_MIRROR_CHANNEL_OVERRIDES);
  const continuityMessageLimit = parseOptionalIntegerEnv(process.env.CONTINUITY_MESSAGE_LIMIT, 1);
  const voiceDaveEncryption = parseOptionalBooleanEnv(process.env.DISCORD_VOICE_DAVE_ENCRYPTION) ?? true;
  const voiceDecryptionFailureTolerance = parseIntegerEnv(
    process.env.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE,
    24,
    0,
  );
  const echoTtsModel = parseOptionalStringEnv(process.env.ECHO_TTS_MODEL);
  const runtimePathLayout = resolveRuntimePathLayout({
    mode: process.env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: process.env.NODE_ENV,
    runtimeRootDir: process.env.PSFN_RUNTIME_ROOT,
    systemDataDir: process.env.SYSTEM_DATA_DIR,
    companionDataDir: process.env.COMPANION_DATA_DIR,
    legacyDataDir: process.env.DATA_DIR,
    workspacePath: process.env.WORKSPACE_PATH,
    logsDir: process.env.PSFN_LOGS_DIR,
    tempDir: process.env.PSFN_TEMP_DIR,
    backupsDir: process.env.BACKUP_ROOT_DIR,
  });
  const dataDir = runtimePathLayout.systemDataDir;
  const companionDataDir = runtimePathLayout.companionDataDir;
  const characterCardPath = process.env.CHARACTER_CARD_PATH ?? `${companionDataDir}/character.json`;
  const databaseBasename = sanitizeDatabaseBasename(process.env.DATABASE_BASENAME);
  const databasePath = process.env.DATABASE_PATH ?? `${companionDataDir}/${databaseBasename}.db`;

  return {
    primaryModel,
    primaryProvider,
    extractionModel,
    extractionProvider,
    primaryMaxTokens,
    extractionMaxTokens,
    discordToken: discordToken ?? '',
    discordBotId: discordBotId ?? '',
    characterCardPath,
    systemDataDir: runtimePathLayout.systemDataDir,
    companionDataDir,
    dataDir,
    databasePath,
    sessionMessageLimit: DEFAULT_SESSION_MESSAGE_LIMIT,
    sessionRestartBehavior: 'reuse_latest_session',
    ...(continuityMessageLimit !== undefined ? { continuityMessageLimit } : {}),
    memoryRetrievalLimit: DEFAULT_MEMORY_RETRIEVAL_LIMIT,
    sessionHistoryBudgetPct: SESSION_HISTORY_BUDGET_PCT_DEFAULT,
    memoryRetrievalBudgetPct: MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
    moodCongruenceWeight: DEFAULT_MOOD_CONGRUENCE_WEIGHT,
    adaptiveContextBudgetsEnabled: false,
    extractionInterval: DEFAULT_EXTRACTION_INTERVAL,
    maintenanceIntervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS,
    defaultContextWindow,
    memoryBudgetPct: DEFAULT_MEMORY_BUDGET_PCT,
    extractionThresholdPct: DEFAULT_EXTRACTION_THRESHOLD_PCT,
    compactionThresholdPct: DEFAULT_COMPACTION_THRESHOLD_PCT,
    observationMaskingWindow: DEFAULT_OBSERVATION_MASKING_WINDOW,
    compactionEmotionalSalienceThresholdPct: DEFAULT_COMPACTION_EMOTIONAL_SALIENCE_THRESHOLD_PCT,
    ...(sessionMirrorEnabled !== undefined ? { sessionMirrorEnabled } : {}),
    ...(sessionMirrorMaxChars !== undefined ? { sessionMirrorMaxChars } : {}),
    ...(sessionMirrorActiveWindowMs !== undefined ? { sessionMirrorActiveWindowMs } : {}),
    ...(sessionMirrorChannelOverrides ? { sessionMirrorChannelOverrides } : {}),
    memoryExtractionMinImportance: DEFAULT_MEMORY_EXTRACTION_MIN_IMPORTANCE,
    memoryExtractionMinConfidence: DEFAULT_MEMORY_EXTRACTION_MIN_CONFIDENCE,
    memoryExtractionMinNovelty: DEFAULT_MEMORY_EXTRACTION_MIN_NOVELTY,
    memoryExtractionEmotionalIntensityWeight: DEFAULT_MEMORY_EXTRACTION_EMOTIONAL_INTENSITY_WEIGHT,
    memoryExtractionMaxWrites: DEFAULT_MEMORY_EXTRACTION_MAX_WRITES,
    memoryExtractionTelemetryEnabled: true,
    memoryRetrievalTelemetryEnabled: true,
    profileSynthesisEnabled: true,
    profileSynthesisRefreshIntervalMs: DEFAULT_PROFILE_SYNTHESIS_REFRESH_INTERVAL_MS,
    profileSynthesisCooldownMs: DEFAULT_PROFILE_SYNTHESIS_COOLDOWN_MS,
    profileSynthesisMinWrites: DEFAULT_PROFILE_SYNTHESIS_MIN_WRITES,
    profileSynthesisMinImportance: DEFAULT_PROFILE_SYNTHESIS_MIN_IMPORTANCE,
    profileSynthesisMinConfidence: DEFAULT_PROFILE_SYNTHESIS_MIN_CONFIDENCE,
    profileSynthesisMinNovelty: DEFAULT_PROFILE_SYNTHESIS_MIN_NOVELTY,
    profileSynthesisSourceMemoryLimit: DEFAULT_PROFILE_SYNTHESIS_SOURCE_MEMORY_LIMIT,
    profileSynthesisMinSourceMemories: DEFAULT_PROFILE_SYNTHESIS_MIN_SOURCE_MEMORIES,
    modelCatalog,
    modelRoleAssignments,
    modelRegistry,
    modelRoster: {
      chat: { model: primaryModel, provider: primaryProvider, maxTokens: primaryMaxTokens, contextWindow: defaultContextWindow },
      background: { model: extractionModel, provider: extractionProvider, maxTokens: extractionMaxTokens },
      context: { model: extractionModel, provider: extractionProvider, maxTokens: extractionMaxTokens },
    },
    voiceEnabled: process.env.DISCORD_VOICE_ENABLED === 'true',
    discordBackfillOnStartup: process.env.DISCORD_BACKFILL_ON_STARTUP !== 'false',
    discordTriggerWords: undefined,
    discordTriggerReactions: [...DEFAULT_DISCORD_TRIGGER_REACTIONS],
    discordTriggerListenWindowMs: DEFAULT_DISCORD_TRIGGER_LISTEN_WINDOW_MS,
    characterName: '',
    uiThemeId: DEFAULT_UI_THEME_ID,
    voiceTargetGuildId: process.env.DISCORD_VOICE_GUILD_ID ?? '',
    voiceTargetUserId: process.env.DISCORD_VOICE_USER_ID ?? process.env.PRIMARY_USER_ID ?? '',
    voiceReadyCueText: process.env.DISCORD_VOICE_READY_CUE_TEXT ?? '',
    voiceDaveEncryption,
    voiceDecryptionFailureTolerance,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    deepgramModel: DEFAULT_DEEPGRAM_MODEL,
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
    elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
    ...(echoTtsModel ? { echoTtsModel } : {}),
    retryMaxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    ...(responseStyleOverrides ? { responseStyleOverrides } : {}),
    importProcessingRouteMode: DEFAULT_IMPORT_PROCESSING_ROUTE_MODE,
    importProcessingStrictPolicy: false,
    compositionalPolicy: createDefaultCompositionalPolicyConfig(),
    webFetchAllowHttp: false,
    webFetchAllowInternalNetwork: false,
    webFetchLocalCrawlerEnabled: false,
    webFetchLocalCrawlerAllowHttp: false,
    ...(gatewayTlsCaPath ? { gatewayTlsCaPath } : {}),
    ...(gatewayTlsRejectUnauthorized !== undefined ? { gatewayTlsRejectUnauthorized } : {}),
    wyomingShardRouting,
    wyomingEnabled,
    wyomingHost,
    ...(wyomingPort !== undefined ? { wyomingPort } : {}),
    telegramEnabled: false,
    capabilityTier: DEFAULT_CAPABILITY_TIER,
    ...(Object.keys(shardToolsets).length > 0 ? { shardToolsets } : {}),
    // Obsidian vault
    obsidianAutoPublish: false,
    obsidianTimeoutMs: DEFAULT_OBSIDIAN_TIMEOUT_MS,
  };
}

export function parseWyomingShardRoutingConfigEnv(
  env: NodeJS.ProcessEnv,
): WyomingShardRoutingConfig {
  const enabled = parseOptionalBooleanEnv(
    env.WYOMING_SHARD_DELEGATION_ENABLED ?? env.WYOMING_SHARD_ROUTING_ENABLED,
  ) ?? false;
  const siteAllowlist = parseStringListEnv(
    env.WYOMING_SHARD_DELEGATION_SITE_ALLOWLIST ?? env.WYOMING_SHARD_ROUTING_SITE_ALLOWLIST,
  );
  const satelliteAllowlist = parseStringListEnv(
    env.WYOMING_SHARD_DELEGATION_SATELLITE_ALLOWLIST ?? env.WYOMING_SHARD_ROUTING_SATELLITE_ALLOWLIST,
  );

  return {
    enabled,
    ...(siteAllowlist.length > 0 ? { siteAllowlist } : {}),
    ...(satelliteAllowlist.length > 0 ? { satelliteAllowlist } : {}),
  };
}

function parseIntegerEnv(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function parseOptionalIntegerEnv(value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed >= min ? parsed : undefined;
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function assertMutuallyRequiredEnvPair(
  primaryName: string,
  primaryValue: string | undefined,
  secondaryName: string,
  secondaryValue: string | undefined,
): void {
  const hasPrimary = typeof primaryValue === 'string' && primaryValue.length > 0;
  const hasSecondary = typeof secondaryValue === 'string' && secondaryValue.length > 0;
  if (hasPrimary === hasSecondary) return;

  if (!hasPrimary) {
    throw new Error(`${primaryName} is required when ${secondaryName} is configured`);
  }
  throw new Error(`${secondaryName} is required when ${primaryName} is configured`);
}

function parseShardToolsetEnv(
  env: NodeJS.ProcessEnv,
): ShardToolsetConfig {
  const entries: Array<[CapabilityTier, string | undefined]> = [
    ['nursery', env.SHARD_TOOLSET_NURSERY],
    ['apprentice', env.SHARD_TOOLSET_APPRENTICE],
    ['autonomous', env.SHARD_TOOLSET_AUTONOMOUS],
    ['custom', env.SHARD_TOOLSET_CUSTOM],
  ];

  const result: ShardToolsetConfig = {};
  for (const [tier, raw] of entries) {
    const parsed = parseStringListEnv(raw);
    if (parsed.length > 0) {
      result[tier] = parsed;
    }
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResponseStyle(value: unknown): ResponseStyle | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'concise' || normalized === 'expressive') {
    return normalized;
  }
  return undefined;
}

function parseResponseStyleMap(value: unknown): Record<string, ResponseStyle> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const parsed: Record<string, ResponseStyle> = {};
  for (const [rawKey, rawStyle] of Object.entries(value)) {
    const key = rawKey.trim();
    const style = parseResponseStyle(rawStyle);
    if (!key || !style) continue;
    parsed[key] = style;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseResponseStyleOverridesEnv(value: string | undefined): ResponseStyleOverrides | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (!isPlainRecord(parsed)) return undefined;
    const exact = parseResponseStyleMap(parsed.exact);
    const prefix = parseResponseStyleMap(parsed.prefix);
    const channelType = parseResponseStyleMap(parsed.channelType);
    const defaultStyle = parseResponseStyle(parsed.defaultStyle);

    if (!exact && !prefix && !channelType && !defaultStyle) return undefined;
    return {
      ...(exact ? { exact } : {}),
      ...(prefix ? { prefix } : {}),
      ...(channelType ? { channelType } : {}),
      ...(defaultStyle ? { defaultStyle } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseStringListEnv(value: string | undefined): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(
    value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  )];
}

function sanitizeDatabaseBasename(value: string | undefined): string {
  if (typeof value !== 'string') return 'companion';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'companion';
}

function parseBooleanMapEnv(value: string | undefined): Record<string, boolean> | undefined {
  if (typeof value !== 'string') return undefined;

  const parsed: Record<string, boolean> = {};
  for (const item of value.split(',')) {
    const [rawKey, rawValue] = item.split('=');
    const key = rawKey.trim();
    const boolValue = parseOptionalBooleanEnv(rawValue.trim());
    if (!key || boolValue === undefined) continue;
    parsed[key] = boolValue;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

// ── Lifecycle ──

export interface Lifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
