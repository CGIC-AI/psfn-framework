// ── OpenAI-compatible API types ──

import type { ExternalTelemetryEvent } from '../../shared/event-bus.js';
import type { ApiAuthPrincipal } from '../backplane/http/auth.js';

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIInlineImageContentPart {
  type: 'image';
  data: string;
  mimeType: string;
  name?: string;
}

export interface OpenAIImageUrlContentPart {
  type: 'image_url';
  image_url: string | {
    url?: string;
    detail?: string;
  };
}

export type OpenAIMessageContent =
  | string
  | Array<OpenAITextContentPart | OpenAIInlineImageContentPart | OpenAIImageUrlContentPart>;

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: OpenAIMessageContent;
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
  'schedulerHealthcheck',
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

export interface ApiRuntimeError {
  status: number;
  type: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiRpcHeaders {
  [name: string]: string | undefined;
}

export interface ApiChatCompletionRpcParams {
  requestId: string;
  request: ChatCompletionRequest;
  principal: ApiAuthPrincipal;
  headers: ApiRpcHeaders;
  timeoutMs?: number;
}

export interface ApiChatCompletionRpcSuccess {
  ok: true;
  response: {
    content: string;
    channelId: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ApiRpcFailure {
  ok: false;
  error: ApiRuntimeError;
}

export type ApiChatCompletionRpcResult = ApiChatCompletionRpcSuccess | ApiRpcFailure;

export interface ApiChatCompletionCancelRpcParams {
  requestId: string;
}

export interface ApiChatCompletionCancelRpcResult {
  cancelled: boolean;
}

export interface ApiStreamDeltaNotification {
  requestId: string;
  text: string;
}

export interface ApiTelemetryIngestRpcParams {
  event: ExternalTelemetryEvent;
}

export interface ApiTelemetryIngestRpcSuccess {
  ok: true;
  response: TelemetryIngestResponse;
}

export type ApiTelemetryIngestRpcResult = ApiTelemetryIngestRpcSuccess | ApiRpcFailure;

export type ApiHealthRpcResult = ApiHealthResponse;

export interface ApiRuntimeChatRequest {
  request: ChatCompletionRequest;
  principal: ApiAuthPrincipal;
  headers: ApiRpcHeaders;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ApiServerRuntime {
  handleHealth(): Promise<ApiHealthRpcResult>;
  handleTelemetryIngest(event: ExternalTelemetryEvent): Promise<ApiTelemetryIngestRpcResult>;
  handleChatCompletion(input: ApiRuntimeChatRequest): Promise<ApiChatCompletionRpcResult>;
}
