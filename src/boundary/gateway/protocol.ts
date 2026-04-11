// ── JSON-RPC 2.0 method definitions ──
// The contract between gateway (host) and agent (container).

import type {
  Attachment,
  CompletionPurpose,
  ContextMessage,
  LLMProviderObservability,
  ModelThinkingEffort,
  ObservabilityCallType,
  SubstrateMessage,
  ToolSchema,
} from '../../shared/contracts/runtime.js';
import type {
  FalCreateModel,
  FalEditModel,
  ImageAspectRatio,
  ImageGenerationResult,
  ImageProviderPreference,
} from '../../primitives/images/types.js';
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

// ── Request parameter types (agent → gateway) ──

export interface GatewayCorrelationParams {
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

export interface FsReadParams {
  path: string;
  maxBytes?: number;
}

export interface FsWriteParams {
  path: string;
  content: string;
}

export interface FsListParams {
  glob?: string;
  maxEntries?: number;
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

export interface BeadsReadyParams extends BeadsBaseParams {}

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

export interface ImageCreateParams extends GatewayCorrelationParams {
  prompt: string;
  provider?: ImageProviderPreference;
  model?: FalCreateModel;
  numImages?: number;
  width?: number;
  height?: number;
  aspectRatio?: ImageAspectRatio;
  resolution?: string;
  imageSize?: string;
  background?: string;
  outputFormat?: string;
  seed?: number;
  guidanceScale?: number;
  numInferenceSteps?: number;
  acceleration?: string;
  enablePromptExpansion?: boolean;
  enableSafetyChecker?: boolean;
  negativePrompt?: string;
  useTurbo?: boolean;
}

export interface ImageEditParams extends GatewayCorrelationParams {
  prompt: string;
  imageUrls: string[];
  provider?: ImageProviderPreference;
  model?: FalEditModel;
  numImages?: number;
  width?: number;
  height?: number;
  aspectRatio?: ImageAspectRatio;
  resolution?: string;
  imageSize?: string;
  background?: string;
  outputFormat?: string;
  maskImageUrl?: string;
  inputFidelity?: string;
  seed?: number;
}

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

export type ConfirmationDecision = 'approve' | 'deny' | 'modify';

export interface ConfirmationQueueEntry {
  id: string;
  method: string;
  action: string;
  scope: string;
  params: Record<string, unknown>;
  companionReason: string;
  requestedAt: number;
  expiresAt: number;
}

export interface ConfirmationQueueHistoryEntry extends Partial<ConfirmationQueueEntry> {
  id: string;
  status: ConfirmationResolutionStatus;
  resolvedAt: number;
  executed: boolean;
  message: string;
  decision?: ConfirmationDecision;
  appliedParams?: Record<string, unknown>;
  error?: string;
}

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

export interface ConfirmationResolveParams {
  id: string;
  decision: ConfirmationDecision;
  modifiedParams?: Record<string, unknown>;
}

export interface ConfirmationResolveResult {
  id: string;
  status: 'approved' | 'denied' | 'modified' | 'expired' | 'failed' | 'not_found';
  message: string;
  executed: boolean;
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
  stopReason: string;
}

export interface LLMEmbedResult {
  embeddings: number[][];
}

export interface LLMDiscoverModelsResult {
  models: unknown[];
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

export interface WebFetchResult {
  content: string;
  sanitized: boolean;
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

export interface FsReadResult {
  content: string;
  truncated: boolean;
}

export interface FsWriteResult {
  success: boolean;
}

export interface FsListResult {
  paths: string[];
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

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface GitDiffResult {
  staged: string;
  unstaged: string;
}

export interface GitCreateBranchResult {
  name: string;
}

export interface GitApplyPatchResult {
  success: boolean;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesChanged: number;
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

export interface VaultWriteResult {
  name: string;
  folder?: string;
  mode: VaultWriteMode;
}

export interface VaultReadResult {
  name: string;
  content: string;
}

export interface VaultSearchResult {
  query: string;
  results: Array<{ path: string; snippet?: string }>;
}

export interface VaultDailyResult {
  date: string;
  content?: string;
  mode: 'read' | 'append';
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

// ── Method map for typed RPC ──

export interface GatewayMethods {
  'llm.chat': [LLMChatParams, LLMChatResult];
  'llm.complete': [LLMCompleteParams, LLMCompleteResult];
  'llm.embed': [LLMEmbedParams, LLMEmbedResult];
  'discord.send': [DiscordSendParams, DiscordSendResult];
  'discord.sendMedia': [DiscordSendMediaParams, DiscordSendMediaResult];
  'discord.typing': [DiscordTypingParams, DiscordTypingResult];
  'web.fetch': [WebFetchParams, WebFetchResult];
  'web.fetch_binary': [WebFetchBinaryParams, WebFetchBinaryResult];
  'web.request_binary': [WebRequestBinaryParams, WebRequestBinaryResult];
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
  'image.create': [ImageCreateParams, ImageGenerationRpcResult];
  'image.edit': [ImageEditParams, ImageGenerationRpcResult];
  'approval.request': [ApprovalRequestParams, ApprovalResult];
  'notify.ntfy': [NotifyNtfyParams, NotifyNtfyResult];
  'shard.backend.request': [ShardBackendRequestParams, ShardBackendRequestResult];
  'confirmation.list': [ConfirmationListParams, ConfirmationListResult];
  'confirmation.history': [ConfirmationHistoryListParams, ConfirmationHistoryListResult];
  'confirmation.resolve': [ConfirmationResolveParams, ConfirmationResolveResult];
  'runtime.health': [RuntimeHealthParams, RuntimeHealthResult];
  'session.hmac.sign': [SessionHmacSignParams, SessionHmacSignResult];
  'session.hmac.verify': [SessionHmacVerifyParams, SessionHmacVerifyResult];
}

export interface GatewayNotifications {
  'llm.chunk': LLMChunkNotification;
  'discord.message': DiscordMessageNotification;
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
} as const;
