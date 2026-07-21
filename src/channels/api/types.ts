// ── OpenAI-compatible API types ──

import type { ExternalTelemetryEvent } from '../../shared/event-bus.js';
import type { IntentionalNoReplyMetadata } from '../../shared/contracts/runtime.js';
import type { SatelliteClientCertIdentity } from '../../shared/contracts/satellite-registry.js';
import type {
  HubDeviceAttachmentSnapshot,
  HubDevicePrincipalSnapshot,
} from '../../shared/contracts/hub-device-ingress.js';
import type { ApiAuthPrincipal } from '../backplane/http/auth.js';
import type {
  RequestCapabilityAuthorityVersions,
  RequestCapabilityParentBinding,
} from '../../boundary/fleet-auth/request-capability.js';
import type {
  ShardChatMessage,
  ShardChatResponse,
  ShardDirectoryEntry,
} from '../../shared/contracts/shard-directory.js';

export interface CompanionUiAgentCapability {
  /** Agent-audience token only; an operator token on this hop is invalid. */
  token: string;
  requestId: string;
  decisionId: string;
  versions: RequestCapabilityAuthorityVersions;
  parent: RequestCapabilityParentBinding;
  /** Canonical base64url of the exact browser frame signed by the capability. */
  rawBodyBase64Url: string;
}

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

/**
 * OpenAI-compatible file attachment part (htm9.9). `file_data` carries the
 * document bytes as base64 (optionally a `data:<mime>;base64,` URL). Parsed
 * server-side through the shared file-ingest faculty — never handed to the
 * model raw.
 */
export interface OpenAIFileContentPart {
  type: 'file';
  file: {
    /** Attachment filename; used for format inference alongside the data URL MIME. */
    filename?: string;
    /** Base64 payload, optionally wrapped as a data: URL with the declared MIME. */
    file_data: string;
  };
}

export type OpenAIMessageContent =
  | string
  | Array<
    | OpenAITextContentPart
    | OpenAIInlineImageContentPart
    | OpenAIImageUrlContentPart
    | OpenAIFileContentPart
  >;

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
  /**
   * Client-certificate identity authenticated by the gateway HTTP ingress
   * (real TLS peer cert or trusted proxy). Forwarded over the internal
   * gateway-agent RPC; never reconstructed from headers on the agent side.
   */
  clientCert?: SatelliteClientCertIdentity;
  /** Device-only principal normalized by authenticated gateway ingress. */
  hubDevicePrincipal?: HubDevicePrincipalSnapshot;
  /** Sibling human/guest + device contexts and server-owned channel binding. */
  hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
  companionUiCapability?: CompanionUiAgentCapability;
  timeoutMs?: number;
  /** Server-authored content-free timing anchor captured at HTTP ingress. */
  performance?: {
    receivedMonotonicAtMs: number;
    receivedTimestampMs: number;
  };
}

export interface ApiChatCompletionRpcSuccess {
  ok: true;
  response: {
    content: string;
    channelId: string;
    /** Gateway-authenticated companion connection that produced this response. */
    companionId?: string;
    inputTokens: number;
    outputTokens: number;
    noReply?: IntentionalNoReplyMetadata;
    /** Gateway-authored deterministic silence; never attributed to a companion choice. */
    disposition?: 'no_op';
  };
}

export interface ApiRpcFailure {
  ok: false;
  error: ApiRuntimeError;
}

export type ApiChatCompletionRpcResult = ApiChatCompletionRpcSuccess | ApiRpcFailure;

export interface ApiShardOwnerRpcParams {
  shardId: string;
}

export interface ApiShardOwnerRpcResult {
  parentCompanionId?: string;
}

export interface ApiCompanionUiShardActionRpcParams {
  requestId: string;
  principal: ApiAuthPrincipal;
  headers: ApiRpcHeaders;
  clientCert?: SatelliteClientCertIdentity;
  hubDevicePrincipal: HubDevicePrincipalSnapshot;
  hubDeviceAttachment: HubDeviceAttachmentSnapshot;
  companionUiCapability: CompanionUiAgentCapability;
}

export interface ApiCompanionUiShardActionRpcSuccess {
  ok: true;
  response:
    | readonly ShardDirectoryEntry[]
    | readonly ShardChatMessage[]
    | ShardChatResponse
    | Readonly<{
      interrupted: boolean;
      interactionId: string;
      attribution: Readonly<{ parentCompanionId: string; shardId: string }>;
    }>;
}

export type ApiCompanionUiShardActionRpcResult =
  | ApiCompanionUiShardActionRpcSuccess
  | ApiRpcFailure;

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
  /** Server-derived fleet target; browsers cannot provide this field. */
  companionId?: string;
  /** See `ApiChatCompletionRpcParams.clientCert`. */
  clientCert?: SatelliteClientCertIdentity;
  /** Device-only principal normalized by authenticated gateway ingress. */
  hubDevicePrincipal?: HubDevicePrincipalSnapshot;
  hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
  companionUiCapability?: CompanionUiAgentCapability;
  onDelta?: (text: string, companionId?: string) => void;
  signal?: AbortSignal;
}

export interface ApiServerRuntime {
  handleHealth(): Promise<ApiHealthRpcResult>;
  handleTelemetryIngest(event: ExternalTelemetryEvent): Promise<ApiTelemetryIngestRpcResult>;
  handleChatCompletion(input: ApiRuntimeChatRequest): Promise<ApiChatCompletionRpcResult>;
}

export interface SatelliteResponseEligibilityRpcParams {
  canonicalContactId: string;
  channelId: string;
}

export interface SatelliteResponseEligibilityRpcResult {
  fatigueAllows: boolean;
}
