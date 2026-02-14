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

// ── Tool system ──

export interface SubstrateTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
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
  tools?: SubstrateTool[];
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onDone?: (response: LLMResponse) => void;
  onError?: (error: Error) => void;
}

export interface LLMResponse {
  content: string;
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

// ── Configuration ──

export interface SubstrateConfig {
  primaryModel: string;
  primaryProvider: string;
  extractionModel: string;
  extractionProvider: string;
  discordToken: string;
  discordBotId: string;
  characterCardPath: string;
  dataDir: string;
  databasePath: string;
  sessionMessageLimit: number;
  memoryRetrievalLimit: number;
  extractionInterval: number;
  primaryMaxTokens: number;
  extractionMaxTokens: number;
}

export function loadConfig(): SubstrateConfig {
  return {
    primaryModel: process.env.PRIMARY_MODEL ?? 'z-ai/glm-5',
    primaryProvider: process.env.PRIMARY_PROVIDER ?? 'openrouter',
    extractionModel: process.env.EXTRACTION_MODEL ?? 'deepseek/deepseek-v3.2',
    extractionProvider: process.env.EXTRACTION_PROVIDER ?? 'openrouter',
    discordToken: process.env.DISCORD_TOKEN ?? '',
    discordBotId: process.env.DISCORD_BOT_ID ?? '1050938702622375987',
    characterCardPath: process.env.CHARACTER_CARD_PATH ?? '/path/to/your/character.json',
    dataDir: process.env.DATA_DIR ?? './data',
    databasePath: process.env.DATABASE_PATH ?? './data/psfn.db',
    sessionMessageLimit: parseInt(process.env.SESSION_MESSAGE_LIMIT ?? '30', 10),
    memoryRetrievalLimit: parseInt(process.env.MEMORY_RETRIEVAL_LIMIT ?? '15', 10),
    extractionInterval: parseInt(process.env.EXTRACTION_INTERVAL ?? '5', 10),
    primaryMaxTokens: parseInt(process.env.PRIMARY_MAX_TOKENS ?? '16384', 10),
    extractionMaxTokens: parseInt(process.env.EXTRACTION_MAX_TOKENS ?? '8192', 10),
  };
}

// ── Lifecycle ──

export interface Lifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
