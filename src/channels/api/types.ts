// ── OpenAI-compatible API types ──

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  provider?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  system_prompt_mode?: 'default' | 'none' | 'custom';
  system_prompt?: string;
  response_style?: 'concise' | 'expressive';
  // Accept-and-ignore for compatibility
  top_p?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  seed?: number;
  user?: string;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: 'assistant'; content: string };
  finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface TelemetryIngestRequest {
  source: string;
  eventType: string;
  timestamp: string;
  nonce: string;
  payload: Record<string, unknown>;
  channelId?: string;
  scope?: string;
}

export interface TelemetryIngestResponse {
  ok: true;
  id: string;
  acceptedEventType: string;
}

export const API_HEALTH_SUBSYSTEMS = [
  'memory',
  'llm',
  'discord',
  'embeddings',
  'scheduler',
] as const;

export const API_CONTINUITY_WATCHDOG_CHECKS = [
  'database',
  'gatewayLink',
  'schedulerHeartbeat',
] as const;

export type ApiHealthState = 'healthy' | 'degraded';
export type ApiHealthSubsystem = (typeof API_HEALTH_SUBSYSTEMS)[number];
export type ApiContinuityWatchdogCheck = (typeof API_CONTINUITY_WATCHDOG_CHECKS)[number];

export interface ApiHealthSubsystemStatus {
  status: ApiHealthState;
  detail?: string;
  meta?: Record<string, unknown>;
}

export type ApiServerHealthChecks = Partial<Record<
ApiHealthSubsystem,
() => Promise<ApiHealthSubsystemStatus> | ApiHealthSubsystemStatus
>>;

export interface ApiHealthResponse {
  status: ApiHealthState;
  checkedAt: string;
  uptimeSeconds: number;
  subsystems: Record<ApiHealthSubsystem, ApiHealthSubsystemStatus>;
  continuity: {
    status: ApiHealthState;
    checks: Record<ApiContinuityWatchdogCheck, ApiHealthSubsystemStatus>;
  };
}
