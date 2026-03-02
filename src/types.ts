import {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from './context-budget.js';
import type { ModelContextBudgetConfig } from './context-budget-contracts.js';
import type { StreamingTtsProvider } from './voice/connectors/tts/index.js';

// ── Channel-agnostic message types ──

export type ChannelType = 'discord' | 'terminal' | 'api' | 'telegram';

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

export interface MessageModelOverride {
  provider: string;
  model: string;
  maxTokens?: number;
  contextWindow?: number;
  slotKey?: string;
  purpose?: string;
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
  correlation?: CorrelationMetadata;
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

export interface ModelSlot {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
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
}

export type ModelRoleAssignments = Record<string, string>;

export type ModelPurpose = 'chat' | 'background' | 'reasoning' | 'longContext';
export type CompletionPurpose = 'background' | 'extraction' | 'summary' | 'reasoning' | 'import_processing';
export type ImportProcessingRouteMode = 'background' | 'openrouter_zdr' | 'local_endpoint';

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

export interface WyomingShardRoutingConfig {
  enabled: boolean;
  siteAllowlist?: string[];
  satelliteAllowlist?: string[];
}

export interface SubstrateConfig {
  primaryModel: string;
  primaryProvider: string;
  extractionModel: string;
  extractionProvider: string;
  primaryMaxTokens: number;
  extractionMaxTokens: number;
  discordToken: string;
  discordBotId: string;
  characterCardPath: string;
  dataDir: string;
  databasePath: string;
  sessionMessageLimit?: number;
  sessionRestartBehavior?: SessionRestartBehavior;
  continuityMessageLimit?: number;
  memoryRetrievalLimit?: number;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
  extractionInterval: number;
  maintenanceIntervalMs: number;
  defaultContextWindow: number;
  memoryBudgetPct: number;
  extractionThresholdPct: number;
  compactionThresholdPct: number;
  compactionEmotionalSalienceThresholdPct?: number;
  sessionMirrorEnabled?: boolean;
  sessionMirrorMaxChars?: number;
  sessionMirrorActiveWindowMs?: number;
  sessionMirrorChannelOverrides?: Record<string, boolean>;
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
  modelRoster: Partial<Record<ModelPurpose, ModelSlot>>;
  modelCatalog?: Record<string, ModelCatalogEntry>;
  modelRoleAssignments?: ModelRoleAssignments;
  responseStyleOverrides?: ResponseStyleOverrides;
  runtimeHooks?: RuntimeConfigHooks;
  promotedExtendedTools?: string[];
  capabilityTier?: CapabilityTier;
  shardToolsets?: ShardToolsetConfig;
  voiceEnabled?: boolean;
  discordBackfillOnStartup?: boolean;
  discordTriggerWords?: string[];
  discordTriggerReactions?: string[];
  discordTriggerListenWindowMs?: number;
  characterName?: string;
  voiceTargetGuildId?: string;
  voiceTargetUserId?: string;
  voiceReadyCueText?: string;
  voiceDaveEncryption?: boolean;
  voiceDecryptionFailureTolerance?: number;
  ttsProvider?: StreamingTtsProvider;
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

export function loadConfig(): SubstrateConfig {
  const primaryModel = process.env.PRIMARY_MODEL ?? 'z-ai/glm-5';
  const primaryProvider = process.env.PRIMARY_PROVIDER ?? 'openrouter';
  const primaryMaxTokens = parseInt(process.env.PRIMARY_MAX_TOKENS ?? '16384', 10);
  const defaultContextWindow = parseInt(process.env.DEFAULT_CONTEXT_WINDOW ?? '128000', 10);
  const extractionModel = process.env.EXTRACTION_MODEL ?? 'deepseek/deepseek-v3.2';
  const extractionProvider = process.env.EXTRACTION_PROVIDER ?? 'openrouter';
  const extractionMaxTokens = parseInt(process.env.EXTRACTION_MAX_TOKENS ?? '8192', 10);
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
    chat: 'primary',
    background: 'extraction',
    extraction: 'extraction',
    summary: 'primary',
    reasoning: 'primary',
    longContext: 'primary',
    import_processing: 'extraction',
  };
  const memoryExtractionMinImportance = parseNumberEnv(
    process.env.MEMORY_EXTRACTION_MIN_IMPORTANCE,
    0.45,
  );
  const memoryExtractionMinConfidence = parseNumberEnv(
    process.env.MEMORY_EXTRACTION_MIN_CONFIDENCE,
    0.6,
  );
  const memoryExtractionMinNovelty = parseNumberEnv(
    process.env.MEMORY_EXTRACTION_MIN_NOVELTY,
    0.35,
  );
  const memoryExtractionMaxWrites = parseIntegerEnv(
    process.env.MEMORY_EXTRACTION_MAX_WRITES,
    2,
    0,
  );
  const memoryExtractionTelemetryEnabled = process.env.MEMORY_EXTRACTION_TELEMETRY_ENABLED !== 'false';
  const memoryRetrievalTelemetryEnabled = process.env.MEMORY_RETRIEVAL_TELEMETRY_ENABLED !== 'false';
  const profileSynthesisEnabled = process.env.PROFILE_SYNTHESIS_ENABLED !== 'false';
  const profileSynthesisRefreshIntervalMs = parseInt(
    process.env.PROFILE_SYNTHESIS_REFRESH_INTERVAL_MS ?? String(6 * 60 * 60 * 1000),
    10,
  );
  const profileSynthesisCooldownMs = parseInt(
    process.env.PROFILE_SYNTHESIS_COOLDOWN_MS ?? String(5 * 60 * 1000),
    10,
  );
  const profileSynthesisMinWrites = parseInt(process.env.PROFILE_SYNTHESIS_MIN_WRITES ?? '1', 10);
  const profileSynthesisMinImportance = parseNumberEnv(process.env.PROFILE_SYNTHESIS_MIN_IMPORTANCE, 0.65);
  const profileSynthesisMinConfidence = parseNumberEnv(process.env.PROFILE_SYNTHESIS_MIN_CONFIDENCE, 0.7);
  const profileSynthesisMinNovelty = parseNumberEnv(process.env.PROFILE_SYNTHESIS_MIN_NOVELTY, 0.12);
  const profileSynthesisSourceMemoryLimit = parseInt(process.env.PROFILE_SYNTHESIS_SOURCE_MEMORY_LIMIT ?? '16', 10);
  const profileSynthesisMinSourceMemories = parseInt(process.env.PROFILE_SYNTHESIS_MIN_SOURCE_MEMORIES ?? '2', 10);
  const retryMaxAttempts = parseInt(process.env.RETRY_MAX_ATTEMPTS ?? '3', 10);
  const retryBaseDelayMs = parseInt(process.env.RETRY_BASE_DELAY_MS ?? '2000', 10);
  const openRouterProviderOrder = parseStringListEnv(process.env.OPENROUTER_PROVIDER_ORDER);
  const responseStyleOverrides = parseResponseStyleOverridesEnv(process.env.RESPONSE_STYLE_OVERRIDES);
  const importProcessingRouteMode = parseImportProcessingRouteMode(
    process.env.IMPORT_PROCESSING_ROUTE_MODE,
    'background',
  );
  const importProcessingStrictPolicy = parseOptionalBooleanEnv(process.env.IMPORT_PROCESSING_STRICT_POLICY) ?? false;
  const importProcessingLocalEndpointUrl = parseOptionalStringEnv(process.env.IMPORT_PROCESSING_LOCAL_ENDPOINT_URL);
  const importProcessingLocalModel = parseOptionalStringEnv(process.env.IMPORT_PROCESSING_LOCAL_MODEL);
  const webFetchAllowHttp = parseOptionalBooleanEnv(process.env.ALLOW_HTTP_FETCH) ?? false;
  const webFetchDomainAllowlist = parseStringListEnv(process.env.FETCH_DOMAIN_ALLOWLIST);
  const webFetchAllowInternalNetwork = parseOptionalBooleanEnv(process.env.ALLOW_INTERNAL_NETWORK) ?? false;
  const webFetchLocalCrawlerEnabled = parseOptionalBooleanEnv(process.env.FETCH_LOCAL_CRAWLER_ENABLED) ?? false;
  const webFetchLocalCrawlerAllowHttp = parseOptionalBooleanEnv(process.env.FETCH_LOCAL_CRAWLER_ALLOW_HTTP) ?? false;
  const webFetchLocalCrawlerHostAllowlist = parseStringListEnv(process.env.FETCH_LOCAL_CRAWLER_HOST_ALLOWLIST);
  const webFetchLocalCrawlerDomainAllowlist = parseStringListEnv(process.env.FETCH_LOCAL_CRAWLER_DOMAIN_ALLOWLIST);
  const webFetchTlsCaCertPaths = parseStringListEnv(process.env.FETCH_TLS_CA_CERT_PATHS);
  const gatewayTlsCaPath = parseOptionalStringEnv(process.env.GATEWAY_TLS_CA_PATH);
  const gatewayTlsRejectUnauthorized = parseOptionalBooleanEnv(process.env.GATEWAY_TLS_REJECT_UNAUTHORIZED);
  const wyomingShardRouting = parseWyomingShardRoutingConfigEnv(process.env);
  const wyomingEnabled = parseOptionalBooleanEnv(process.env.WYOMING_ENABLED) ?? false;
  const wyomingHost = parseOptionalStringEnv(process.env.WYOMING_HOST) ?? '127.0.0.1';
  const wyomingPort = parseOptionalIntegerEnv(process.env.WYOMING_PORT, 1);
  const capabilityTier = parseCapabilityTierEnv(process.env.CAPABILITY_TIER, 'nursery');
  const shardToolsets = parseShardToolsetEnv(process.env);
  const sessionMirrorEnabled = parseOptionalBooleanEnv(process.env.SESSION_MIRROR_ENABLED);
  const sessionMirrorMaxChars = parseOptionalIntegerEnv(process.env.SESSION_MIRROR_MAX_CHARS, 32);
  const sessionMirrorActiveWindowMs = parseOptionalIntegerEnv(process.env.SESSION_MIRROR_ACTIVE_WINDOW_MS, 1_000);
  const sessionMirrorChannelOverrides = parseBooleanMapEnv(process.env.SESSION_MIRROR_CHANNEL_OVERRIDES);
  const sessionMessageLimit = parseOptionalIntegerEnv(process.env.SESSION_MESSAGE_LIMIT, 1);
  const sessionRestartBehavior = parseSessionRestartBehaviorEnv(
    process.env.SESSION_RESTART_BEHAVIOR,
    'reuse_latest_session',
  );
  const continuityMessageLimit = parseOptionalIntegerEnv(process.env.CONTINUITY_MESSAGE_LIMIT, 1);
  const memoryRetrievalLimit = parseOptionalIntegerEnv(process.env.MEMORY_RETRIEVAL_LIMIT, 1);
  const sessionHistoryBudgetPct = parseBoundedIntegerEnv(
    process.env.SESSION_HISTORY_BUDGET_PCT,
    SESSION_HISTORY_BUDGET_PCT_DEFAULT,
    SESSION_HISTORY_BUDGET_PCT_RANGE.min,
    SESSION_HISTORY_BUDGET_PCT_RANGE.max,
  );
  const memoryRetrievalBudgetPct = parseBoundedIntegerEnv(
    process.env.MEMORY_RETRIEVAL_BUDGET_PCT,
    MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
  );
  const voiceDaveEncryption = parseOptionalBooleanEnv(process.env.DISCORD_VOICE_DAVE_ENCRYPTION) ?? true;
  const voiceDecryptionFailureTolerance = parseIntegerEnv(
    process.env.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE,
    24,
    0,
  );
  const ttsProvider = parseStreamingTtsProviderEnv(
    process.env.TTS_PROVIDER ?? process.env.VOICE_TTS_PROVIDER,
    'elevenlabs',
  );
  const echoTtsUrl = parseOptionalStringEnv(process.env.ECHO_TTS_URL);
  const echoTtsVoice = parseOptionalStringEnv(process.env.ECHO_TTS_VOICE);
  const echoTtsPreset = parseOptionalStringEnv(process.env.ECHO_TTS_PRESET);
  const echoTtsModel = parseOptionalStringEnv(process.env.ECHO_TTS_MODEL);
  const telegramAuthorizedUsers = parseStringListEnv(
    process.env.TELEGRAM_ALLOWED_USERS ?? process.env.TELEGRAM_AUTHORIZED_USERS,
  );

  return {
    primaryModel,
    primaryProvider,
    extractionModel,
    extractionProvider,
    primaryMaxTokens,
    extractionMaxTokens,
    discordToken: process.env.DISCORD_TOKEN ?? '',
    discordBotId: process.env.DISCORD_BOT_ID ?? '',
    characterCardPath: process.env.CHARACTER_CARD_PATH ?? '/path/to/your/character.json',
    dataDir: process.env.DATA_DIR ?? './data',
    databasePath: process.env.DATABASE_PATH ?? './data/purrsephone.db',
    ...(sessionMessageLimit !== undefined ? { sessionMessageLimit } : {}),
    sessionRestartBehavior,
    ...(continuityMessageLimit !== undefined ? { continuityMessageLimit } : {}),
    ...(memoryRetrievalLimit !== undefined ? { memoryRetrievalLimit } : {}),
    sessionHistoryBudgetPct,
    memoryRetrievalBudgetPct,
    extractionInterval: parseInt(process.env.EXTRACTION_INTERVAL ?? '5', 10),
    maintenanceIntervalMs: parseInt(process.env.MAINTENANCE_INTERVAL_MS ?? '300000', 10),
    defaultContextWindow,
    memoryBudgetPct: parseInt(process.env.MEMORY_BUDGET_PCT ?? '20', 10),
    extractionThresholdPct: parseInt(process.env.EXTRACTION_THRESHOLD_PCT ?? '30', 10),
    compactionThresholdPct: parseInt(process.env.COMPACTION_THRESHOLD_PCT ?? '70', 10),
    compactionEmotionalSalienceThresholdPct: parseBoundedIntegerEnv(
      process.env.COMPACTION_EMOTIONAL_SALIENCE_THRESHOLD_PCT,
      75,
      0,
      100,
    ),
    ...(sessionMirrorEnabled !== undefined ? { sessionMirrorEnabled } : {}),
    ...(sessionMirrorMaxChars !== undefined ? { sessionMirrorMaxChars } : {}),
    ...(sessionMirrorActiveWindowMs !== undefined ? { sessionMirrorActiveWindowMs } : {}),
    ...(sessionMirrorChannelOverrides ? { sessionMirrorChannelOverrides } : {}),
    memoryExtractionMinImportance,
    memoryExtractionMinConfidence,
    memoryExtractionMinNovelty,
    memoryExtractionMaxWrites,
    memoryExtractionTelemetryEnabled,
    memoryRetrievalTelemetryEnabled,
    profileSynthesisEnabled,
    profileSynthesisRefreshIntervalMs,
    profileSynthesisCooldownMs,
    profileSynthesisMinWrites,
    profileSynthesisMinImportance,
    profileSynthesisMinConfidence,
    profileSynthesisMinNovelty,
    profileSynthesisSourceMemoryLimit,
    profileSynthesisMinSourceMemories,
    modelCatalog,
    modelRoleAssignments,
    modelRoster: {
      chat: { model: primaryModel, provider: primaryProvider, maxTokens: primaryMaxTokens, contextWindow: defaultContextWindow },
      background: { model: extractionModel, provider: extractionProvider, maxTokens: extractionMaxTokens },
    },
    voiceEnabled: process.env.DISCORD_VOICE_ENABLED === 'true',
    discordBackfillOnStartup: process.env.DISCORD_BACKFILL_ON_STARTUP !== 'false',
    discordTriggerWords: parseStringListEnv(process.env.DISCORD_TRIGGER_WORDS),
    discordTriggerReactions: (() => {
      const configured = parseStringListEnv(process.env.DISCORD_TRIGGER_REACTIONS);
      return configured.length > 0 ? configured : ['👆'];
    })(),
    discordTriggerListenWindowMs: parseBoundedIntegerEnv(
      process.env.DISCORD_TRIGGER_LISTEN_WINDOW_MS,
      120_000,
      10_000,
      600_000,
    ),
    characterName: '',
    voiceTargetGuildId: process.env.DISCORD_VOICE_GUILD_ID ?? '',
    voiceTargetUserId: process.env.DISCORD_VOICE_USER_ID ?? process.env.PRIMARY_USER_ID ?? '',
    voiceReadyCueText: process.env.DISCORD_VOICE_READY_CUE_TEXT ?? '',
    voiceDaveEncryption,
    voiceDecryptionFailureTolerance,
    ttsProvider,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
    deepgramModel: process.env.DEEPGRAM_MODEL ?? 'nova-3',
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? 'YOUR_VOICE_ID',
    elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
    ...(echoTtsUrl ? { echoTtsUrl } : {}),
    ...(echoTtsVoice ? { echoTtsVoice } : {}),
    ...(echoTtsPreset ? { echoTtsPreset } : {}),
    ...(echoTtsModel ? { echoTtsModel } : {}),
    retryMaxAttempts,
    retryBaseDelayMs,
    ...(openRouterProviderOrder.length > 0 ? { openRouterProviderOrder } : {}),
    ...(responseStyleOverrides ? { responseStyleOverrides } : {}),
    importProcessingRouteMode,
    importProcessingStrictPolicy,
    ...(importProcessingLocalEndpointUrl ? { importProcessingLocalEndpointUrl } : {}),
    ...(importProcessingLocalModel ? { importProcessingLocalModel } : {}),
    webFetchAllowHttp,
    ...(webFetchDomainAllowlist.length > 0 ? { webFetchDomainAllowlist } : {}),
    webFetchAllowInternalNetwork,
    webFetchLocalCrawlerEnabled,
    webFetchLocalCrawlerAllowHttp,
    ...(webFetchLocalCrawlerHostAllowlist.length > 0 ? { webFetchLocalCrawlerHostAllowlist } : {}),
    ...(webFetchLocalCrawlerDomainAllowlist.length > 0 ? { webFetchLocalCrawlerDomainAllowlist } : {}),
    ...(webFetchTlsCaCertPaths.length > 0 ? { webFetchTlsCaCertPaths } : {}),
    ...(gatewayTlsCaPath ? { gatewayTlsCaPath } : {}),
    ...(gatewayTlsRejectUnauthorized !== undefined ? { gatewayTlsRejectUnauthorized } : {}),
    wyomingShardRouting,
    wyomingEnabled,
    wyomingHost,
    ...(wyomingPort !== undefined ? { wyomingPort } : {}),
    telegramEnabled: parseOptionalBooleanEnv(process.env.TELEGRAM_ENABLED) ?? false,
    ...(telegramAuthorizedUsers.length > 0
      ? { telegramAuthorizedUsers }
      : {}),
    capabilityTier,
    ...(Object.keys(shardToolsets).length > 0 ? { shardToolsets } : {}),
    // Obsidian vault
    ...(parseOptionalStringEnv(process.env.OBSIDIAN_VAULT_NAME)
      ? { obsidianVaultName: parseOptionalStringEnv(process.env.OBSIDIAN_VAULT_NAME) }
      : {}),
    ...(parseOptionalStringEnv(process.env.OBSIDIAN_CLI_PATH)
      ? { obsidianCliPath: parseOptionalStringEnv(process.env.OBSIDIAN_CLI_PATH) }
      : {}),
    ...(parseOptionalBooleanEnv(process.env.OBSIDIAN_AUTO_PUBLISH) !== undefined
      ? { obsidianAutoPublish: parseOptionalBooleanEnv(process.env.OBSIDIAN_AUTO_PUBLISH) }
      : {}),
    ...(parseOptionalIntegerEnv(process.env.OBSIDIAN_TIMEOUT_MS, 1000) !== undefined
      ? { obsidianTimeoutMs: parseOptionalIntegerEnv(process.env.OBSIDIAN_TIMEOUT_MS, 1000) }
      : {}),
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

function parseNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function parseSessionRestartBehaviorEnv(
  value: string | undefined,
  fallback: SessionRestartBehavior,
): SessionRestartBehavior {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'reuse_latest_session' || normalized === 'new_session') {
    return normalized;
  }
  return fallback;
}

function parseBoundedIntegerEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseOptionalStringEnv(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStreamingTtsProviderEnv(
  value: string | undefined,
  fallback: StreamingTtsProvider,
): StreamingTtsProvider {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'elevenlabs' || trimmed === 'echo') {
    return trimmed;
  }
  return fallback;
}

function parseImportProcessingRouteMode(
  value: string | undefined,
  fallback: ImportProcessingRouteMode,
): ImportProcessingRouteMode {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'background' || trimmed === 'openrouter_zdr' || trimmed === 'local_endpoint') {
    return trimmed;
  }
  return fallback;
}

function parseCapabilityTierEnv(
  value: string | undefined,
  fallback: CapabilityTier,
): CapabilityTier {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === 'nursery'
    || trimmed === 'apprentice'
    || trimmed === 'autonomous'
    || trimmed === 'custom'
  ) {
    return trimmed;
  }
  return fallback;
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

function parseBooleanMapEnv(value: string | undefined): Record<string, boolean> | undefined {
  if (typeof value !== 'string') return undefined;

  const parsed: Record<string, boolean> = {};
  for (const item of value.split(',')) {
    const [rawKey, rawValue] = item.split('=');
    const key = rawKey?.trim();
    const boolValue = parseOptionalBooleanEnv(rawValue?.trim());
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
