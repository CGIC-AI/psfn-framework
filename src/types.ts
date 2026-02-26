import {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from './context-budget.js';

// ── Channel-agnostic message types ──

export type ChannelType = 'discord' | 'terminal' | 'api' | 'telegram';

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

export interface ResponseMetadata {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
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

export interface ModelContextBudgetConfig {
  sessionHistoryMinTokens?: number;
  memoryRetrievalMinTokens?: number;
}

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
export type CompletionPurpose = 'background' | 'extraction' | 'summary' | 'reasoning';

export interface RuntimeConfigHooks {
  refreshModels?: () => void;
  refreshCapabilities?: () => void;
  invalidatePromptPrefixCache?: () => void;
}

// ── Configuration ──

export type CapabilityTier = 'nursery' | 'apprentice' | 'autonomous' | 'custom';
export type ShardToolsetConfig = Partial<Record<CapabilityTier, string[]>>;

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
  runtimeHooks?: RuntimeConfigHooks;
  capabilityTier?: CapabilityTier;
  shardToolsets?: ShardToolsetConfig;
  voiceEnabled?: boolean;
  discordBackfillOnStartup?: boolean;
  voiceTargetGuildId?: string;
  voiceTargetUserId?: string;
  voiceReadyCueText?: string;
  deepgramApiKey?: string;
  deepgramModel?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  thinkMaxTokens?: number;
  thinkMaxWallTimeMs?: number;
  thinkMaxSubQueries?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
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
  const capabilityTier = parseCapabilityTierEnv(process.env.CAPABILITY_TIER, 'nursery');
  const shardToolsets = parseShardToolsetEnv(process.env);
  const sessionMirrorEnabled = parseOptionalBooleanEnv(process.env.SESSION_MIRROR_ENABLED);
  const sessionMirrorMaxChars = parseOptionalIntegerEnv(process.env.SESSION_MIRROR_MAX_CHARS, 32);
  const sessionMirrorActiveWindowMs = parseOptionalIntegerEnv(process.env.SESSION_MIRROR_ACTIVE_WINDOW_MS, 1_000);
  const sessionMirrorChannelOverrides = parseBooleanMapEnv(process.env.SESSION_MIRROR_CHANNEL_OVERRIDES);
  const sessionMessageLimit = parseOptionalIntegerEnv(process.env.SESSION_MESSAGE_LIMIT, 1);
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

  return {
    primaryModel,
    primaryProvider,
    extractionModel,
    extractionProvider,
    primaryMaxTokens,
    extractionMaxTokens,
    discordToken: process.env.DISCORD_TOKEN ?? '',
    discordBotId: process.env.DISCORD_BOT_ID ?? '1050938702622375987',
    characterCardPath: process.env.CHARACTER_CARD_PATH ?? '/home/vega/.openclaw/agents/main/character.json',
    dataDir: process.env.DATA_DIR ?? './data',
    databasePath: process.env.DATABASE_PATH ?? './data/purrsephone.db',
    ...(sessionMessageLimit !== undefined ? { sessionMessageLimit } : {}),
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
    voiceTargetGuildId: process.env.DISCORD_VOICE_GUILD_ID ?? '',
    voiceTargetUserId: process.env.DISCORD_VOICE_USER_ID ?? process.env.PRIMARY_USER_ID ?? '',
    voiceReadyCueText: process.env.DISCORD_VOICE_READY_CUE_TEXT ?? '',
    deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
    deepgramModel: process.env.DEEPGRAM_MODEL ?? 'nova-3',
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? 'rPQ6h200dfjiuYAy0JDA',
    elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
    retryMaxAttempts,
    retryBaseDelayMs,
    capabilityTier,
    ...(Object.keys(shardToolsets).length > 0 ? { shardToolsets } : {}),
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
