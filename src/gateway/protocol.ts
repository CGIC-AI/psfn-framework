// ── JSON-RPC 2.0 method definitions ──
// The contract between gateway (host) and agent (container).

import type { ContextMessage, SubstrateMessage, ToolSchema } from '../types.js';

// ── Request parameter types (agent → gateway) ──

export interface LLMChatParams {
  model: string;
  provider: string;
  messages: ContextMessage[];
  systemPrompt: string;
  stream?: boolean;
  requestId?: string;
  maxTokens?: number;
  tools?: ToolSchema[];
}

export interface LLMCompleteParams {
  model: string;
  provider: string;
  messages: ContextMessage[];
  systemPrompt: string;
  purpose: 'extraction' | 'summary';
  maxTokens?: number;
}

export interface LLMEmbedParams {
  texts: string[];
}

export interface DiscordSendParams {
  channelId: string;
  content: string;
}

export interface DiscordTypingParams {
  channelId: string;
}

export interface WebFetchParams {
  url: string;
  prompt?: string;
}

export interface FsReadParams {
  path: string;
}

export interface FsWriteParams {
  path: string;
  content: string;
}

export interface ApprovalRequestParams {
  action: string;
  scope: string;
  reason: string;
}

// ── Result types (gateway → agent) ──

export interface LLMChatResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  requestId?: string;
}

export interface LLMCompleteResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface LLMEmbedResult {
  embeddings: number[][];
}

export interface DiscordSendResult {
  success: boolean;
}

export interface DiscordTypingResult {
  success: boolean;
}

export interface WebFetchResult {
  content: string;
  sanitized: boolean;
}

export interface FsReadResult {
  content: string;
}

export interface FsWriteResult {
  success: boolean;
}

export interface ApprovalResult {
  granted: boolean;
  capabilityToken?: string;
}

// ── Notification types (gateway → agent, no response) ──

export interface LLMChunkNotification {
  requestId: string;
  text: string;
}

export interface DiscordMessageNotification {
  message: SubstrateMessage;
}

// ── Method map for typed RPC ──

export interface GatewayMethods {
  'llm.chat': [LLMChatParams, LLMChatResult];
  'llm.complete': [LLMCompleteParams, LLMCompleteResult];
  'llm.embed': [LLMEmbedParams, LLMEmbedResult];
  'discord.send': [DiscordSendParams, DiscordSendResult];
  'discord.typing': [DiscordTypingParams, DiscordTypingResult];
  'web.fetch': [WebFetchParams, WebFetchResult];
  'fs.read': [FsReadParams, FsReadResult];
  'fs.write': [FsWriteParams, FsWriteResult];
  'approval.request': [ApprovalRequestParams, ApprovalResult];
}

export interface GatewayNotifications {
  'llm.chunk': LLMChunkNotification;
  'discord.message': DiscordMessageNotification;
}

// ── Policy types ──

export type PolicyDecision = 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL';

export interface PolicyContext {
  method: string;
  params: Record<string, unknown>;
}

// ── Error codes (JSON-RPC custom range: -32000 to -32099) ──

// ── Reverse RPC types (gateway → agent requests) ──

export type RpcSubstrateMessage = Omit<SubstrateMessage, 'timestamp'> & {
  timestamp: string | Date;
};

export interface DiscordHandleMessageParams {
  message: RpcSubstrateMessage;
}

export interface DiscordHandleMessageResult {
  content: string;
  channelId: string;
  model: string;
  durationMs: number;
}

export interface VoiceStreamMetadata {
  format?: string;
  language?: string;
  sampleRateHz?: number;
  [key: string]: unknown;
}

export interface VoiceStreamFrameBase {
  correlationId: string;
  streamId: string;
  sequence: number;
  metadata?: VoiceStreamMetadata;
}

export interface DiscordVoiceStreamStartParams extends VoiceStreamFrameBase {
  message: RpcSubstrateMessage;
}

export interface DiscordVoiceStreamChunkParams extends VoiceStreamFrameBase {
  text: string;
}

export interface DiscordVoiceStreamEndParams extends VoiceStreamFrameBase {}

export interface DiscordVoiceStreamCancelParams extends VoiceStreamFrameBase {
  reason?: string;
}

export interface DiscordVoiceStreamAckResult {
  correlationId: string;
  streamId: string;
  sequence: number;
  accepted: boolean;
  queueDepth: number;
  droppedChunks?: number;
}

export interface DiscordVoiceStreamCancelResult {
  correlationId: string;
  streamId: string;
  cancelled: boolean;
}

export interface DiscordVoiceStreamEndResult extends DiscordHandleMessageResult {
  correlationId: string;
  streamId: string;
  droppedChunks: number;
}

export interface AgentMethods {
  'discord.handleMessage': [DiscordHandleMessageParams, DiscordHandleMessageResult];
  'discord.voice.start': [DiscordVoiceStreamStartParams, DiscordVoiceStreamAckResult];
  'discord.voice.chunk': [DiscordVoiceStreamChunkParams, DiscordVoiceStreamAckResult];
  'discord.voice.end': [DiscordVoiceStreamEndParams, DiscordVoiceStreamEndResult];
  'discord.voice.cancel': [DiscordVoiceStreamCancelParams, DiscordVoiceStreamCancelResult];
}

// ── Error codes (JSON-RPC custom range: -32000 to -32099) ──

export const GatewayErrors = {
  NEEDS_APPROVAL: -32000,
  APPROVAL_DENIED: -32001,
  POLICY_DENIED: -32002,
  PROVIDER_ERROR: -32003,
  SANITIZATION_FAILED: -32004,
  VOICE_STREAM_NOT_FOUND: -32005,
  VOICE_STREAM_CANCELLED: -32006,
  VOICE_STREAM_OVERFLOW: -32007,
  VOICE_STREAM_SEQUENCE: -32008,
} as const;
