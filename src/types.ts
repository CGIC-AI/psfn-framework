// ── Channel-agnostic message types ──

export type ChannelType = 'discord' | 'terminal' | 'api';

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

export interface ModelSlot {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
}

export type ModelPurpose = 'chat' | 'background' | 'reasoning' | 'longContext';
export type CompletionPurpose = 'extraction' | 'summary' | 'reasoning';

export interface RuntimeConfigHooks {
  refreshModels?: () => void;
}

// ── Configuration ──

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
  sessionMessageLimit: number;
  memoryRetrievalLimit: number;
  extractionInterval: number;
  maintenanceIntervalMs: number;
  defaultContextWindow: number;
  memoryBudgetPct: number;
  extractionThresholdPct: number;
  compactionThresholdPct: number;
  memoryExtractionMinImportance?: number;
  memoryExtractionMinConfidence?: number;
  memoryExtractionMinNovelty?: number;
  memoryExtractionTelemetryEnabled?: boolean;
  memoryRetrievalTelemetryEnabled?: boolean;
  modelRoster: Partial<Record<ModelPurpose, ModelSlot>>;
  runtimeHooks?: RuntimeConfigHooks;
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
  const memoryExtractionTelemetryEnabled = process.env.MEMORY_EXTRACTION_TELEMETRY_ENABLED !== 'false';
  const memoryRetrievalTelemetryEnabled = process.env.MEMORY_RETRIEVAL_TELEMETRY_ENABLED !== 'false';
  const retryMaxAttempts = parseInt(process.env.RETRY_MAX_ATTEMPTS ?? '3', 10);
  const retryBaseDelayMs = parseInt(process.env.RETRY_BASE_DELAY_MS ?? '2000', 10);

  return {
    primaryModel,
    primaryProvider,
    extractionModel,
    extractionProvider,
    primaryMaxTokens,
    extractionMaxTokens,
    discordToken: process.env.DISCORD_TOKEN ?? '',
    discordBotId: process.env.DISCORD_BOT_ID ?? '1050938702622375987',
    characterCardPath: process.env.CHARACTER_CARD_PATH ?? '/path/to/your/character.json',
    dataDir: process.env.DATA_DIR ?? './data',
    databasePath: process.env.DATABASE_PATH ?? './data/purrsephone.db',
    sessionMessageLimit: parseInt(process.env.SESSION_MESSAGE_LIMIT ?? '30', 10),
    memoryRetrievalLimit: parseInt(process.env.MEMORY_RETRIEVAL_LIMIT ?? '15', 10),
    extractionInterval: parseInt(process.env.EXTRACTION_INTERVAL ?? '5', 10),
    maintenanceIntervalMs: parseInt(process.env.MAINTENANCE_INTERVAL_MS ?? '300000', 10),
    defaultContextWindow,
    memoryBudgetPct: parseInt(process.env.MEMORY_BUDGET_PCT ?? '20', 10),
    extractionThresholdPct: parseInt(process.env.EXTRACTION_THRESHOLD_PCT ?? '30', 10),
    compactionThresholdPct: parseInt(process.env.COMPACTION_THRESHOLD_PCT ?? '70', 10),
    memoryExtractionMinImportance,
    memoryExtractionMinConfidence,
    memoryExtractionMinNovelty,
    memoryExtractionTelemetryEnabled,
    memoryRetrievalTelemetryEnabled,
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
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? 'YOUR_VOICE_ID',
    elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
    retryMaxAttempts,
    retryBaseDelayMs,
  };
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Lifecycle ──

export interface Lifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
