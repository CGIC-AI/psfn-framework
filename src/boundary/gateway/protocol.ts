// ── JSON-RPC 2.0 method definitions ──
// The contract between gateway (host) and agent (container).

import type {
  Attachment,
  CompletionPurpose,
  ContextMessage,
  LLMProviderObservability,
  LLMSystemPromptCacheBoundaries,
  LLMUsageDetails,
  ModelThinkingEffort,
  ObservabilityCallType,
  SubstrateMessage,
  ToolSchema,
} from '../../shared/contracts/runtime.js';
import type {
  ImageGenerationResult,
  ImageCreateParams as PrimitiveImageCreateParams,
  ImageEditParams as PrimitiveImageEditParams,
} from '../../primitives/images/types.js';
import type { DiscoveredModel } from '../../primitives/llm/discovery.js';
import type {
  ConfirmationDecision,
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationResolveResult,
} from '../../system/capabilities/confirmation-queue.js';
import type {
  GitCommitResult,
  GitDiffResult,
  GitStatusResult,
} from '../integrations/git/ops.js';
import type {
  VaultDailyResult,
  VaultReadResult,
  VaultSearchResult,
  VaultWriteResult,
} from '../integrations/vault/ops.js';
import type { JournalEntry } from '../../core/session/types.js';
import type { JournalIntegrityVerificationResult } from '../../persistence/journals/journal-utils.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiHealthRpcResult,
  ApiStreamDeltaNotification,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
} from '../../channels/api/types.js';
import type { RuntimeServiceHealthSnapshot } from '../../operator/tool-health/types.js';
import type { NotificationSenderMetadata } from './notification-sender.js';

// ── Request parameter types (agent → gateway) ──

export interface GatewayCorrelationParams {
  /**
   * Multi-companion (sprint-10 W1): companion the request acts for. Agents
   * self-stamp this from COMPANION_ID; the gateway verifies it against the
   * connection's identified companionId and disconnects on mismatch.
   */
  companionId?: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: ObservabilityCallType;
  originType?: ObservabilityCallType;
  originStage?: string;
  toolName?: string;
  toolCallId?: string;
  purpose?: string;
}

export interface LLMChatParams extends GatewayCorrelationParams {
  model: string;
  provider: string;
  pin?: boolean;
  messages: ContextMessage[];
  systemPrompt: string;
  /** PromptPlan cachePlan boundaries for systemPrompt (E2.4); hash-verified before use. */
  promptCacheBoundaries?: LLMSystemPromptCacheBoundaries;
  stream?: boolean;
  maxTokens?: number;
  contextWindow?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: ModelThinkingEffort;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
  tools?: ToolSchema[];
}

export interface LLMCompleteParams extends GatewayCorrelationParams {
  model: string;
  provider: string;
  pin?: boolean;
  messages: ContextMessage[];
  systemPrompt: string;
  /** PromptPlan cachePlan boundaries for systemPrompt (E2.4); hash-verified before use. */
  promptCacheBoundaries?: LLMSystemPromptCacheBoundaries;
  purpose: CompletionPurpose;
  maxTokens?: number;
  contextWindow?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: ModelThinkingEffort;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
}

export interface LLMEmbedParams {
  texts: string[];
}

export type LLMDiscoverModelsParams = Record<string, never>;
export type LLMInvalidateModelDiscoveryParams = Record<string, never>;

export interface DiscordSendParams {
  channelId: string;
  content: string;
}

export interface DiscordSendMediaParams {
  channelId: string;
  media: Attachment;
}

export interface DiscordTypingParams {
  channelId: string;
}

export type WebFetchLane = 'default' | 'local_crawler' | 'discovery';

export interface WebFetchParams {
  url: string;
  prompt?: string;
  lane?: WebFetchLane;
}

export interface WebFetchBinaryParams {
  url: string;
  lane?: WebFetchLane;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface WebRequestBinaryParams extends WebFetchBinaryParams {
  method?: string;
  bodyBase64?: string;
}

export interface HomeAssistantGetStatesParams extends GatewayCorrelationParams {
  entityId?: string;
}

export interface HomeAssistantCallServiceParams extends GatewayCorrelationParams {
  domain: string;
  service: string;
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
}

export type HomeAssistantCheckConnectionParams = GatewayCorrelationParams;

export interface WebSearchParams {
  query: string;
  maxResults?: number;
}


export interface FsReadParams {
  path: string;
  maxBytes?: number;
}

export interface FsWriteParams {
  path: string;
  content: string;
}

export interface FsListParams {
  path?: string;
  glob?: string;
  maxEntries?: number;
  maxScannedEntries?: number;
}

export interface FsSearchParams {
  query: string;
  glob?: string;
  mode?: 'literal' | 'regex';
  maxMatches?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  contextLines?: number;
}

export interface FsEditParams {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type GitStatusParams = Record<string, never>;

export interface GitDiffParams {
  staged?: boolean;
}

export interface GitCreateBranchParams {
  name: string;
  startPoint?: string;
}

export interface GitApplyPatchParams {
  filePath: string;
  content: string;
}

export interface GitCommitParams {
  message: string;
  intent: string;
  scope?: string;
}

export interface GitOpenPRParams {
  title: string;
  body: string;
  base?: string;
}

export type BeadsAction = 'ready' | 'show' | 'create' | 'update' | 'close' | 'sync';
export type BeadsIssueType = 'bug' | 'feature' | 'task' | 'epic' | 'chore';
export type BeadsIssueStatus = 'open' | 'in_progress' | 'blocked' | 'closed';

export interface BeadsBaseParams extends GatewayCorrelationParams {
  actor?: string;
}

export interface BeadsReadyParams extends BeadsBaseParams {
  /** Max ready issues returned (default 20, cap 100): the full list is a context firehose. */
  limit?: number;
}

export interface BeadsShowParams extends BeadsBaseParams {
  id: string;
}

export interface BeadsCreateParams extends BeadsBaseParams {
  title: string;
  issueType?: BeadsIssueType;
  priority?: number;
  deps?: string[];
  parent?: string;
}

export interface BeadsUpdateParams extends BeadsBaseParams {
  id: string;
  status?: BeadsIssueStatus;
  priority?: number;
}

export interface BeadsCloseParams extends BeadsBaseParams {
  id: string;
  reason: string;
}

export interface BeadsSyncParams extends BeadsBaseParams {}

interface ImageCreateRpcParams extends PrimitiveImageCreateParams, GatewayCorrelationParams {}

interface ImageEditRpcParams extends PrimitiveImageEditParams, GatewayCorrelationParams {}

export interface ShellExecParams {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  envVars?: string[];
}

export type ShardBackendRequestBackend = 'container' | 'orchestrated';

export interface ShardBackendRequestParams {
  backend: ShardBackendRequestBackend;
  shardId: string;
  name: string;
  capabilityTier: string;
}

export type VaultWriteMode = 'create' | 'append' | 'prepend';

export interface VaultWriteParams extends GatewayCorrelationParams {
  name: string;
  content: string;
  folder?: string;
  mode?: VaultWriteMode;
}

export interface VaultReadParams extends GatewayCorrelationParams {
  name: string;
}

export interface VaultSearchParams extends GatewayCorrelationParams {
  query: string;
  limit?: number;
}

export interface VaultDailyParams extends GatewayCorrelationParams {
  content?: string;
}

export interface ApprovalRequestParams {
  action: string;
  scope: string;
  reason: string;
}

export interface NotifyNtfyParams {
  message: string;
  title?: string;
  priority?: number;
  topic?: string;
  sender: NotificationSenderMetadata;
}

export interface SessionHmacSignParams {
  entry: JournalEntry;
  previousHmac: string | null;
}

export interface SessionHmacSignResult {
  entry: JournalEntry;
}

export interface SessionHmacVerifyParams {
  entry: JournalEntry;
  previousHmac: string | null;
}

export type SessionHmacVerifyResult = JournalIntegrityVerificationResult;

export type ConfirmationListParams = Record<string, never>;
export type ConfirmationHistoryListParams = Record<string, never>;
export type RuntimeHealthParams = Record<string, never>;

export interface ConfirmationListResult {
  entries: ConfirmationQueueEntry[];
}

export interface ConfirmationHistoryListResult {
  entries: ConfirmationQueueHistoryEntry[];
}

export type RuntimeHealthResult = RuntimeServiceHealthSnapshot;

export type GatewayCredentialPresenceParams = Record<string, never>;

/** Redacted credential inventory. Raw values never cross the gateway boundary. */
export interface GatewayCredentialPresenceResult {
  discordToken: boolean;
  apiKey: boolean;
  adminToken: boolean;
  openrouterApiKey: boolean;
  litellmBaseUrl: boolean;
  litellmApiKey: boolean;
  importProcessingLocalApiKey: boolean;
  falApiKey: boolean;
  telegramBotToken: boolean;
}

export interface ConfirmationResolveParams {
  id: string;
  decision: ConfirmationDecision;
  modifiedParams?: Record<string, unknown>;
}

// ── Result types (gateway → agent) ──

export interface LLMChatResult {
  content: string;
  reasoning?: string;
  providerObservability?: LLMProviderObservability;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usageDetails?: LLMUsageDetails;
  stopReason: string;
  requestId?: string;
}

export interface LLMCompleteResult {
  content: string;
  reasoning?: string;
  providerObservability?: LLMProviderObservability;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usageDetails?: LLMUsageDetails;
  stopReason: string;
}

export interface LLMEmbedResult {
  embeddings: number[][];
}

export interface LLMDiscoverModelsResult {
  models: DiscoveredModel[];
}

export interface LLMInvalidateModelDiscoveryResult {
  success: boolean;
}

export interface DiscordSendResult {
  success: boolean;
}

export interface DiscordSendMediaResult {
  success: boolean;
}

export interface DiscordTypingResult {
  success: boolean;
}

/**
 * Cognition intake firewall (htm9.2): screening outcome attached to web
 * content results. Absent when intake-policy mode is 'off'. In shadow mode
 * the decision is recorded but `content` is unaltered; in enforce mode a
 * quarantine decision replaces `content` with the fixed withheld-content
 * placeholder (`withheld: true`).
 */
export interface WebIntakeScreeningSummary {
  envelopeId: string;
  action: 'pass' | 'sanitize' | 'quarantine' | 'block';
  state: string;
  riskLabels: string[];
  mode: 'shadow' | 'enforce';
  withheld: boolean;
}

export interface WebFetchResult {
  content: string;
  sanitized: boolean;
  intake?: WebIntakeScreeningSummary;
}

export interface WebFetchBinaryResult {
  dataBase64: string;
  mimeType: string;
  sizeBytes: number;
}

export interface WebRequestBinaryResult extends WebFetchBinaryResult {
  status: number;
  statusText: string;
  ok: boolean;
}

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HomeAssistantGetStatesResult {
  states: HomeAssistantState[];
  count: number;
  entityId?: string;
}

export interface HomeAssistantCallServiceResult {
  domain: string;
  service: string;
  entityIds?: string[];
  response: unknown;
}

export interface HomeAssistantCheckConnectionResult {
  ok: true;
  message: string;
}

export interface WebSearchResult {
  content: string;
  sanitized: boolean;
  citations: string[];
  intake?: WebIntakeScreeningSummary;
}

export interface FsReadResult {
  content: string;
  truncated: boolean;
}

export interface FsWriteResult {
  success: boolean;
}

export interface FsListResult {
  paths: string[];
  scannedEntries: number;
  maxEntries: number;
  maxScannedEntries: number;
  truncated: boolean;
  scanLimitReached: boolean;
  entryLimitReached: boolean;
}

export interface FsSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FsSearchResult {
  query: string;
  glob: string;
  mode: 'literal' | 'regex';
  scannedFiles: number;
  hitLimit: boolean;
  truncatedFiles: string[];
  matches: FsSearchMatch[];
}

export interface FsEditResult {
  success: boolean;
  replacements: number;
}

export interface GitCreateBranchResult {
  name: string;
}

export interface GitApplyPatchResult {
  success: boolean;
}

export interface GitOpenPRResult {
  url: string;
}

export interface ShardBackendRequestResult {
  backend: ShardBackendRequestBackend;
  controller: 'gateway';
  status: 'unavailable';
  reason: string;
}

export interface GitHubProjectSyncResult {
  integration: 'github_project';
  state: 'disabled' | 'skipped' | 'synced' | 'archived' | 'error';
  owner?: string;
  projectNumber?: number;
  issueId?: string;
  itemId?: string;
  draftContentId?: string;
  reason?: string;
  created?: boolean;
  reopened?: boolean;
}

export interface GitHubProjectBulkSyncResult {
  integration: 'github_project';
  state: 'disabled' | 'synced' | 'error';
  owner?: string;
  projectNumber?: number;
  totalIssues: number;
  synced: number;
  archived: number;
  skipped: number;
  errors?: Array<{
    issueId: string;
    message: string;
  }>;
}

export type BeadsExternalSyncResult =
  | GitHubProjectSyncResult
  | GitHubProjectBulkSyncResult;

export interface BeadsActionResult {
  actor: string;
  action: BeadsAction;
  target: string;
  result: 'success';
  payload: unknown;
  sync?: BeadsExternalSyncResult[];
}

export type ImageGenerationRpcResult = ImageGenerationResult;

export interface ShellExecResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ApprovalResult {
  granted: boolean;
  capabilityToken?: string;
}

export interface NotifyNtfyResult {
  status: 'sent' | 'debounced';
  topic: string;
  messageId?: string;
}

// ── Notification types (gateway → agent, no response) ──

export interface LLMChunkNotification {
  requestId: string;
  text: string;
}

export interface DiscordMessageNotification {
  message: SubstrateMessage;
}

// ── Inter-companion channel lane (sprint 10, W6) ──
// Agent → gateway send; gateway → recipient agents as an ordinary inbound
// channel message notification so the normal turn pipeline (fatigue, trust,
// extraction) applies with zero new mechanism.

export interface CompanionMessageSendParams {
  /** `companion-room:<placeId>` or canonical `companion-dm:<a>:<b>`. */
  channelId: string;
  content: string;
  /** Display-only sender name (identity is the connection-bound companionId). */
  authorName?: string;
  /** Client-stamped companion identity; verified against the connection binding. */
  companionId?: string;
}

export interface CompanionMessageSendResult {
  channelId: string;
  messageId: string;
  deliveredTo: string[];
  /** Room recipients present at the place but without a live agent connection. */
  skippedOffline: string[];
}

export type CompanionDeliveryFailureReason = 'processing_failed' | 'reply_delivery_failed';

/**
 * Recipient-to-gateway negative acknowledgement for a previously delivered
 * companion message. The gateway derives both reporter and original sender
 * from connection-bound identity and its delivery receipt; neither is trusted
 * from this payload.
 */
export interface CompanionMessageFailureReportParams {
  channelId: string;
  messageId: string;
  reason: CompanionDeliveryFailureReason;
  /** Client-stamped identity for the gateway's generic frame mismatch guard. */
  companionId?: string;
}

export interface CompanionMessageFailureReportResult {
  reportedTo: string;
}

/** Structured, observe-only failure evidence sent to the original companion. */
export interface CompanionMessageDeliveryFailureNotification {
  channelId: string;
  messageId: string;
  reportingCompanionId: string;
  reason: CompanionDeliveryFailureReason;
  reportedAt: string;
}

export interface CompanionMessageNotification {
  message: SubstrateMessage;
}

// ── Method map for typed RPC ──

export interface GatewayMethods {
  'llm.chat': [LLMChatParams, LLMChatResult];
  'llm.complete': [LLMCompleteParams, LLMCompleteResult];
  'llm.embed': [LLMEmbedParams, LLMEmbedResult];
  'llm.discover_models': [LLMDiscoverModelsParams, LLMDiscoverModelsResult];
  'llm.invalidate_model_discovery': [LLMInvalidateModelDiscoveryParams, LLMInvalidateModelDiscoveryResult];
  'discord.send': [DiscordSendParams, DiscordSendResult];
  'discord.sendMedia': [DiscordSendMediaParams, DiscordSendMediaResult];
  'discord.typing': [DiscordTypingParams, DiscordTypingResult];
  'companion.message.send': [CompanionMessageSendParams, CompanionMessageSendResult];
  'companion.message.report_failure': [CompanionMessageFailureReportParams, CompanionMessageFailureReportResult];
  'web.fetch': [WebFetchParams, WebFetchResult];
  'web.fetch_binary': [WebFetchBinaryParams, WebFetchBinaryResult];
  'web.request_binary': [WebRequestBinaryParams, WebRequestBinaryResult];
  'home_assistant.get_states': [HomeAssistantGetStatesParams, HomeAssistantGetStatesResult];
  'home_assistant.call_service': [HomeAssistantCallServiceParams, HomeAssistantCallServiceResult];
  'home_assistant.check_connection': [HomeAssistantCheckConnectionParams, HomeAssistantCheckConnectionResult];
  'web.search': [WebSearchParams, WebSearchResult];
  'shell.exec': [ShellExecParams, ShellExecResult];
  'vault.write': [VaultWriteParams, VaultWriteResult];
  'vault.read': [VaultReadParams, VaultReadResult];
  'vault.search': [VaultSearchParams, VaultSearchResult];
  'vault.daily': [VaultDailyParams, VaultDailyResult];
  'fs.read': [FsReadParams, FsReadResult];
  'fs.write': [FsWriteParams, FsWriteResult];
  'fs.list': [FsListParams, FsListResult];
  'fs.search': [FsSearchParams, FsSearchResult];
  'fs.edit': [FsEditParams, FsEditResult];
  'git.status': [GitStatusParams, GitStatusResult];
  'git.diff': [GitDiffParams, GitDiffResult];
  'git.create_branch': [GitCreateBranchParams, GitCreateBranchResult];
  'git.apply_patch': [GitApplyPatchParams, GitApplyPatchResult];
  'git.commit': [GitCommitParams, GitCommitResult];
  'git.open_pr': [GitOpenPRParams, GitOpenPRResult];
  'beads.ready': [BeadsReadyParams, BeadsActionResult];
  'beads.show': [BeadsShowParams, BeadsActionResult];
  'beads.create': [BeadsCreateParams, BeadsActionResult];
  'beads.update': [BeadsUpdateParams, BeadsActionResult];
  'beads.close': [BeadsCloseParams, BeadsActionResult];
  'beads.sync': [BeadsSyncParams, BeadsActionResult];
  'image.create': [ImageCreateRpcParams, ImageGenerationRpcResult];
  'image.edit': [ImageEditRpcParams, ImageGenerationRpcResult];
  'approval.request': [ApprovalRequestParams, ApprovalResult];
  'notify.ntfy': [NotifyNtfyParams, NotifyNtfyResult];
  'shard.backend.request': [ShardBackendRequestParams, ShardBackendRequestResult];
  'confirmation.list': [ConfirmationListParams, ConfirmationListResult];
  'confirmation.history': [ConfirmationHistoryListParams, ConfirmationHistoryListResult];
  'confirmation.resolve': [ConfirmationResolveParams, ConfirmationResolveResult];
  'runtime.health': [RuntimeHealthParams, RuntimeHealthResult];
  'runtime.credential_presence': [GatewayCredentialPresenceParams, GatewayCredentialPresenceResult];
  'session.hmac.sign': [SessionHmacSignParams, SessionHmacSignResult];
  'session.hmac.verify': [SessionHmacVerifyParams, SessionHmacVerifyResult];
}

export interface GatewayNotifications {
  'llm.chunk': LLMChunkNotification;
  'discord.message': DiscordMessageNotification;
  'companion.message': CompanionMessageNotification;
  'companion.message.delivery_failure': CompanionMessageDeliveryFailureNotification;
  'api.stream.delta': ApiStreamDeltaNotification;
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

export interface VoiceHandleMessageParams {
  message: RpcSubstrateMessage;
}

export interface VoiceHandleMessageResult {
  content: string;
  channelId: string;
  attachments?: Attachment[];
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

export interface VoiceStreamStartParams extends VoiceStreamFrameBase {
  message: RpcSubstrateMessage;
}

export interface VoiceStreamChunkParams extends VoiceStreamFrameBase {
  text: string;
}

export interface VoiceStreamEndParams extends VoiceStreamFrameBase {}

export interface VoiceStreamCancelParams extends VoiceStreamFrameBase {
  reason?: string;
}

export interface VoiceStreamAckResult {
  correlationId: string;
  streamId: string;
  sequence: number;
  accepted: boolean;
  queueDepth: number;
  droppedChunks?: number;
}

export interface VoiceStreamCancelResult {
  correlationId: string;
  streamId: string;
  cancelled: boolean;
}

export interface VoiceStreamEndResult extends VoiceHandleMessageResult {
  correlationId: string;
  streamId: string;
  droppedChunks: number;
}

export interface AgentMethods {
  'voice.handleMessage': [VoiceHandleMessageParams, VoiceHandleMessageResult];
  'voice.stream.start': [VoiceStreamStartParams, VoiceStreamAckResult];
  'voice.stream.chunk': [VoiceStreamChunkParams, VoiceStreamAckResult];
  'voice.stream.end': [VoiceStreamEndParams, VoiceStreamEndResult];
  'voice.stream.cancel': [VoiceStreamCancelParams, VoiceStreamCancelResult];
  'api.chat.completion': [ApiChatCompletionRpcParams, ApiChatCompletionRpcResult];
  'api.chat.cancel': [ApiChatCompletionCancelRpcParams, ApiChatCompletionCancelRpcResult];
  'api.telemetry.ingest': [ApiTelemetryIngestRpcParams, ApiTelemetryIngestRpcResult];
  'api.health': [Record<string, never>, ApiHealthRpcResult];
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
  COMPANION_IDENTIFY_REQUIRED: -32009,
  COMPANION_IDENTITY_MISMATCH: -32010,
  COMPANION_ROUTING_UNAVAILABLE: -32011,
  CONNECTION_ROLE_DENIED: -32012,
  COMPANION_AUTH_FAILED: -32013,
  // htm9.18: an outbound action was HELD because the session canary token
  // leaked into egress (prompt leak / hijack tripwire). The error message is
  // the calm companion-facing soft notice.
  EGRESS_HELD: -32014,
} as const;
