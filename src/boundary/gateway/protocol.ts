// ── JSON-RPC 2.0 method definitions ──
// The contract between gateway (host) and agent (container).

import type {
  Attachment,
  ChannelType,
  CompletionPurpose,
  ContextMessage,
  LLMProviderObservability,
  LLMCallAccountingContext,
  LLMStreamFirstOutputObservation,
  LLMSystemPromptCacheBoundaries,
  LLMUsageDetails,
  ModelThinkingEffort,
  ObservabilityCallType,
  SubstrateMessage,
  TelemetryVisibility,
  ToolSchema,
} from '../../shared/contracts/runtime.js';
import type {
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@earendil-works/pi-ai';
import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from '../../shared/contracts/charge-policy.js';
import type {
  ImageGenerationResult,
  ImageCreateParams as PrimitiveImageCreateParams,
  ImageEditParams as PrimitiveImageEditParams,
} from '../../primitives/images/types.js';
import type { DiscoveredModel } from '../../primitives/llm/discovery.js';
import type { LLMWorkSpecWireParams } from '../../primitives/llm/work-spec-wire.js';
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
import type { BeadsAction } from '../integrations/beads/enablement.js';
export type { BeadsAction } from '../integrations/beads/enablement.js';
import type {
  VaultDailyResult,
  VaultReadResult,
  VaultSearchResult,
  VaultWriteResult,
} from '../integrations/vault/ops.js';
import type { JournalEntry } from '../../core/session/types.js';
import type { JournalIntegrityVerificationResult } from '../../persistence/journals/journal-utils.js';
import type {
  ContactAuthoritySnapshotRequest,
  VerifiedDiscordContactAuthoritySnapshot,
} from '../../shared/contracts/contact-authority-snapshot.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiCompanionUiShardActionRpcParams,
  ApiCompanionUiShardActionRpcResult,
  ApiHealthRpcResult,
  ApiShardOwnerRpcParams,
  ApiShardOwnerRpcResult,
  ApiStreamDeltaNotification,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
} from '../../channels/api/types.js';
import type { RuntimeServiceHealthSnapshot } from '../../operator/tool-health/types.js';
import type { NotificationSenderMetadata } from './notification-sender.js';
import type {
  IcpInitiationGateDecision,
  IcpInitiationHandoffPrepareResult,
  IcpInitiationPermitIssueInput,
  IcpInitiationPermitIssueResult,
  IcpInitiationPreflightInput,
  IcpOwnAvailabilityReadParams,
  IcpOwnAvailabilityResult,
  IcpPermitConsumeResult,
  IcpPeerAvailabilityResult,
  IcpRuntimeAvailabilityClearParams,
  IcpRuntimeAvailabilityRefreshParams,
} from './icp-autonomy-contract.js';
export type {
  IcpPermitConsumeResult,
  IcpRuntimeAvailabilityClearParams,
  IcpRuntimeAvailabilityRefreshParams,
} from './icp-autonomy-contract.js';
import type {
  IcpAvailabilityLease,
  IcpAvailabilityState,
  IcpAutonomyReasonCode,
  IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import type { TurnPerformanceEvent } from '../../shared/telemetry/turn-performance.js';
import type {
  ContactAuthorityLifecycleRequest,
  ContactAuthorityLifecycleResult,
} from '../../shared/contracts/contact-authority-lifecycle.js';
import type {
  KubeSelfManagementRequest,
  KubeSelfManagementResponse,
} from '../../system/lifecycle/kube-self-management.js';
import type { SensitivityLevel } from '../../system/trust/types.js';
export type {
  KubeSelfManagementRequest,
  KubeSelfManagementResponse,
} from '../../system/lifecycle/kube-self-management.js';

// ── Request parameter types (agent → gateway) ──

export interface GatewayCorrelationParams {
  /**
   * Multi-companion (sprint-10 W1): companion the request acts for. Agents
   * self-stamp this from COMPANION_ID; the gateway verifies it against the
   * connection's identified companionId and disconnects on mismatch.
   */
  companionId?: string;
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  channelType?: ChannelType;
  callType?: ObservabilityCallType;
  originType?: ObservabilityCallType;
  originStage?: string;
  toolName?: string;
  toolCallId?: string;
  purpose?: string;
  telemetryVisibility?: TelemetryVisibility;
  service?: string;
  process?: string;
  chargeLane?: ChargePolicyRuntimeLane;
  chargeSurface?: ChargePolicySurface;
  chargeEventId?: string;
  chargeRunId?: string;
  chargeRootRunId?: string;
  chargeParentRunId?: string;
  shardId?: string;
  subagentId?: string;
  conversationId?: string;
  rootInitiationId?: string;
  workloadType?: string;
  workloadId?: string;
  /** Validated, content-free ICP episode and cost classification. */
  icpCorrelation?: IcpConversationCorrelation;
}

export interface GatewayLLMCancellationParams {
  /** Opaque, connection-scoped request identity used only for exact cancellation. */
  cancellationId?: string;
}

export interface LLMCancelParams {
  cancellationId: string;
  /** Optional authenticated routing claim; the gateway verifies it against the connection. */
  companionId?: string;
}

export interface LLMCancelResult {
  cancelled: boolean;
}

export interface GatewayInlineImageReferenceContent {
  type: 'gateway_image_ref';
  handle: string;
}

export type GatewayLLMContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCall
  | GatewayInlineImageReferenceContent;

export type GatewayToolResultContentBlock =
  | TextContent
  | ImageContent
  | GatewayInlineImageReferenceContent;

/** JSON-RPC wire form; unlike the legacy provider context, it carries structured content blocks. */
export type GatewayLLMMessage =
  | (Omit<ContextMessage, 'content'> & {
      content: string | GatewayLLMContentBlock[];
    })
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: GatewayToolResultContentBlock[];
      isError: boolean;
      provenance?: ContextMessage['provenance'];
    };

export interface LLMChatParams extends GatewayCorrelationParams, GatewayLLMCancellationParams {
  model: string;
  provider: string;
  pin?: boolean;
  /**
   * 23pp per-companion model selection: models.json registry entry id chosen
   * by the calling companion's settings overlay. Resolved fail-closed against
   * the gateway's registry; explicit model/provider fields take precedence.
   */
  slotKey?: string;
  messages: GatewayLLMMessage[];
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
  /** Runtime-derived disclosure classification; never model-visible or accepted by mcp.execute. */
  mcpOutboundSensitivity?: SensitivityLevel;
  accounting?: LLMCallAccountingContext;
  /**
   * d8vq.2: declared work spec for an autonomous streamed call.
   * Threads the typed LLMWorkSpec (minus its correlation, which rides the flat
   * correlation params) across the RPC boundary so the gateway-side LLMClient
   * enforces the same fail-closed accountability guard + lane reconciliation.
   * Absent for the interactive chat turn. Parsed fail-closed at the handler.
   */
  workSpec?: LLMWorkSpecWireParams;
}

export interface LLMCompleteParams extends GatewayCorrelationParams, GatewayLLMCancellationParams {
  model: string;
  provider: string;
  pin?: boolean;
  /**
   * 23pp per-companion model selection: models.json registry entry id chosen
   * by the calling companion's settings overlay. Resolved fail-closed against
   * the gateway's registry; explicit model/provider fields take precedence.
   */
  slotKey?: string;
  messages: GatewayLLMMessage[];
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
  accounting?: LLMCallAccountingContext;
  /**
   * d8vq.2: declared work spec for an autonomous completion
   * (the `completeWithWorkSpec` entry). Threads the typed LLMWorkSpec (minus its
   * correlation, which rides the flat correlation params) across the RPC boundary
   * so the gateway-side LLMClient enforces the same fail-closed accountability
   * guard + lane reconciliation. Parsed fail-closed at the handler.
   */
  workSpec?: LLMWorkSpecWireParams;
}

export interface LLMEmbedParams extends GatewayCorrelationParams {
  texts: string[];
}

export type LLMDiscoverModelsParams = Record<string, never>;
export type LLMInvalidateModelDiscoveryParams = Record<string, never>;

export interface ContactLifecycleExecuteParams {
  request: ContactAuthorityLifecycleRequest;
}

export type ContactLifecycleExecuteResult = ContactAuthorityLifecycleResult;

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

export interface DiscordAvailabilityParams {
  state: 'available' | 'idle' | 'do_not_disturb';
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
  placeId: string;
  affordanceId: string;
  reason: string;
  intent?: 'direct' | 'presence_enter' | 'presence_exit' | 'attention' | 'sleep' | 'wake';
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
}

export type HomeAssistantCheckConnectionParams = GatewayCorrelationParams;

export interface WebSearchParams {
  query: string;
  maxResults?: number;
}

export type McpExecuteAction = 'catalog' | 'search' | 'inspect' | 'call' | 'release';

/** Agent-to-gateway execution of one exact gateway-authorized MCP tool call. */
export interface McpExecuteParams {
  action: McpExecuteAction;
  serverId?: string;
  toolName?: string;
  query?: string;
  limit?: number;
  arguments?: Record<string, unknown>;
  /** Opaque, single-use permit minted when the gateway observed this model tool call. */
  permit?: string;
  cancellationId?: string;
}

export interface McpCancelParams {
  cancellationId: string;
}

export interface McpCancelResult {
  cancelled: boolean;
}

/** Reversible operator lifecycle action; it cannot connect or invoke a server. */
export interface McpReleaseParams {
  serverId?: string;
}

export interface McpReleaseResult {
  released: true;
  serverId?: string;
}

export type McpExecuteResult =
  | {
      action: 'catalog';
      servers: Array<{
        serverId: string;
        displayName: string;
        description: string;
        trustLevel: 'primary' | 'trusted' | 'regular' | 'public';
      }>;
    }
  | {
      action: 'search';
      query: string;
      tools: Array<{
        serverId: string;
        serverDisplayName: string;
        toolName: string;
        description: string;
        effect: 'read' | 'write' | 'read_write' | 'destructive' | 'control';
        confirmation: 'never' | 'sensitive' | 'always';
        maxOutboundSensitivity: 'public' | 'personal' | 'intimate' | 'confidential';
      }>;
    }
  | {
      action: 'inspect';
      serverId: string;
      serverDisplayName: string;
      tool: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      };
      policy: {
        effect: 'read' | 'write' | 'read_write' | 'destructive' | 'control';
        confirmation: 'never' | 'sensitive' | 'always';
        maxOutboundSensitivity: 'public' | 'personal' | 'intimate' | 'confidential';
      };
    }
  | {
      action: 'call';
      serverId: string;
      toolName: string;
      isError: boolean;
      effectiveText: string;
      withheld: boolean;
    }
  | {
      action: 'release';
      serverId?: string;
      released: true;
    };


export interface FsReadParams {
  path: string;
  maxBytes?: number;
  offsetBytes?: number;
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
  description?: string;
  acceptance?: string;
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
  /** Manager-bound assertion; gateway recomputes it from authenticated authority. */
  ownerVersion: string;
  /** Manager-bound assertion; gateway recomputes it from authenticated authority. */
  grantDigest: string;
}

export interface ShardWorkloadRegisterParams {
  /** Client-generated idempotency/cleanup key; never carries authority. */
  registrationId: string;
  shardId: string;
  shardLabel?: string;
  channelIds: string[];
  /** Agent launch assertions; the gateway independently re-derives both. */
  ownerVersion: string;
  grantDigest: string;
}

export interface ShardWorkloadRegisterResult {
  registrationId: string;
  workloadGeneration: string;
}

export interface ShardWorkloadEndParams {
  registrationId: string;
}

export interface ShardWorkloadEndResult {
  ended: boolean;
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

/**
 * A structured clarification the companion raises when she needs the person to
 * pick among a few concrete options rather than continue open-ended.
 *
 * This is the channel-agnostic seam the channel layer consumes: a renderer
 * presents `question` plus the ordered `choices`, and a later selection returns
 * as a {@link ClarificationSelection}. Like a notify approval_request, it is a
 * pure outbound structured notification — the answer arrives out-of-band, not by
 * resuming the emitting turn.
 */
export interface PendingClarification {
  /** Runtime-generated id that binds a delivered clarification to its answer. */
  readonly id: string;
  /** The short question the companion needs answered. */
  readonly question: string;
  /** The ordered, distinct options to choose between. */
  readonly choices: readonly string[];
}

/**
 * The structured answer that flows back when the person picks a choice for a
 * {@link PendingClarification}. `selectedIndex` indexes into the delivered
 * `choices`; `selectedChoice` is the resolved text at that index.
 */
export interface ClarificationSelection {
  readonly clarificationId: string;
  readonly selectedIndex: number;
  readonly selectedChoice: string;
}

/**
 * Wire parameters for delivering a {@link PendingClarification} to an
 * interactive channel that runs in the gateway process (Discord buttons or a
 * Telegram numbered list). The agent-side clarification port resolves the
 * active channel and target from the current turn's request context before
 * dispatching; the gateway renders the choices, awaits the human's answer up to
 * `timeoutMs`, and returns a {@link ClarifyDeliverResult}.
 */
export interface ClarifyDeliverParams {
  /** Which interactive channel renders the choices. */
  readonly channel: 'discord' | 'telegram';
  /** Channel-scoped destination (Discord channel id / Telegram `telegram:<chatId>`). */
  readonly target: string;
  /** The runtime-owned clarification to present. */
  readonly clarification: PendingClarification;
  /** Upper bound the channel waits for an answer before reporting no-answer. */
  readonly timeoutMs: number;
  /**
   * Channel-native id of the turn's originating user (Discord user snowflake /
   * Telegram user id). Runtime-resolved from the turn's author, never model
   * supplied. The rendering channel binds the answer to this author so a
   * different member of a shared channel/group cannot answer another user's
   * clarification. Absent only for turns with no resolvable human author, where
   * the channel fails closed rather than accept an unbound answer.
   */
  readonly originatingUserId?: string;
}

/**
 * Wire result of a clarify delivery. `resolved` carries the verified-at-source
 * {@link ClarificationSelection}; `pending` (with no selection) is the
 * structured no-answer returned on timeout, an unrecognized reply, or an
 * out-of-range choice. The channel never fabricates a selection.
 */
export interface ClarifyDeliverResult {
  readonly status: 'pending' | 'resolved';
  readonly channel: string;
  readonly target: string;
  readonly selection?: ClarificationSelection;
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
  importProcessingLocalApiKey: boolean;
  falApiKey: boolean;
  telegramBotToken: boolean;
}

export interface ConfirmationResolveParams {
  id: string;
  decision: ConfirmationDecision;
  modifiedParams?: Record<string, unknown>;
}

export interface MemoryDeletionProposeParams {
  proposalId: string;
  memoryId: string;
  justificationCategory: string;
  explanation: string;
}

export type MemoryDeletionProposeResult = {
  status: 'approval_required';
  proposalId: string;
  approvalId: string;
  expiresAt: number;
} | {
  status: 'already_approved' | 'already_denied';
  proposalId: string;
  approvalId?: string;
  deleteId?: string;
};

// ── Result types (gateway → agent) ──

export interface LLMChatResult {
  content: string;
  reasoning?: string;
  providerObservability?: LLMProviderObservability;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    /** Gateway-client transport detail; stripped before the model loop sees the tool call. */
    gatewayMcpPermit?: string;
  }>;
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

export interface DiscordAvailabilityResult {
  status: 'applied' | 'unsupported';
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
  offsetBytes: number;
  nextOffsetBytes: number | null;
  eof: boolean;
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

export interface OperatorAlertDelivery {
  sink: 'ntfy' | 'telegram';
  status: 'sent' | 'debounced' | 'failed';
  target?: string;
  messageId?: string;
  error?: string;
}

export interface OperatorAlertResult {
  deliveries: OperatorAlertDelivery[];
}

// ── Notification types (gateway → agent, no response) ──

export interface LLMChunkNotification {
  requestId: string;
  text: string;
}

export interface LLMFirstOutputNotification extends LLMStreamFirstOutputObservation {
  requestId: string;
}

export interface TurnPerformanceIngestParams {
  event: TurnPerformanceEvent;
}

export interface TurnPerformanceIngestResult {
  accepted: true;
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
  /** Deterministic and gateway-verified for every correlated ICP send. */
  messageId?: string;
  /**
   * Optional autonomous-initiation binding. This still uses the ordinary
   * companion.message.send lane; the gateway consumes the permit before
   * routing and mints a stable message id for replay-safe recipient handling.
   */
  initiation?: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  };
  /** Episode-bound lineage for a non-initial autonomous conversation reply. */
  correlation?: IcpConversationCorrelation;
  /**
   * Gateway-issued inbound message id this send directly answers. For room
   * messages, the gateway may use the matching delivery receipt as a
   * short-lived, one-shot stale-presence reply capability.
   */
  replyToMessageId?: string;
}

export interface CompanionMessageSendResult {
  channelId: string;
  messageId: string;
  deliveredTo: string[];
  /** Room recipients present at the place but without a live agent connection. */
  skippedOffline: string[];
  permitOutcome?: 'consumed' | 'replayed';
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

// ── ICP autonomy control plane (sprint 10, s10mc.6.2) ──

export interface IcpAvailabilityPublishParams {
  state: IcpAvailabilityState;
  expiresAtMs: number;
  revision: number;
  companionId?: string;
}

export interface IcpAvailabilityClearParams {
  expectedRevision: number;
  companionId?: string;
}

export interface IcpPeerAvailabilityReadParams {
  peerCompanionId: string;
  companionId?: string;
}

export interface IcpInitiationHandoffPrepareParams {
  permitId: string;
  peerContactId: string;
  companionId?: string;
}

export type IcpInitiationPreflightParams = IcpInitiationPreflightInput & {
  companionId?: string;
};

export type IcpInitiationPermitIssueParams = IcpInitiationPermitIssueInput & {
  companionId?: string;
};

export interface IcpPermitConsumeParams {
  permitId: string;
  conversationId: string;
  recipientCompanionId: string;
  channelId: string;
  rootInitiationId: string;
  peerContactId: string;
  companionId?: string;
}

export interface IcpPermitRevokeParams {
  permitId: string;
  expectedRevision: number;
  companionId?: string;
}

export interface IcpPermitRevokeResult {
  status: 'revoked';
  revision: number;
  reasonCode: IcpAutonomyReasonCode;
}

export interface IcpPermitInvalidateSelfParams {
  reasonCode: 'peer_blocked';
  companionId?: string;
}

// ── Method map for typed RPC ──

export interface GatewayMethods {
  'llm.chat': [LLMChatParams, LLMChatResult];
  'llm.complete': [LLMCompleteParams, LLMCompleteResult];
  'llm.cancel': [LLMCancelParams, LLMCancelResult];
  'llm.embed': [LLMEmbedParams, LLMEmbedResult];
  'llm.discover_models': [LLMDiscoverModelsParams, LLMDiscoverModelsResult];
  'llm.invalidate_model_discovery': [LLMInvalidateModelDiscoveryParams, LLMInvalidateModelDiscoveryResult];
  'discord.send': [DiscordSendParams, DiscordSendResult];
  'discord.sendMedia': [DiscordSendMediaParams, DiscordSendMediaResult];
  'discord.typing': [DiscordTypingParams, DiscordTypingResult];
  'discord.availability': [DiscordAvailabilityParams, DiscordAvailabilityResult];
  'companion.message.send': [CompanionMessageSendParams, CompanionMessageSendResult];
  'companion.message.report_failure': [CompanionMessageFailureReportParams, CompanionMessageFailureReportResult];
  'companion.availability.publish': [IcpAvailabilityPublishParams, IcpAvailabilityLease];
  'companion.availability.clear': [IcpAvailabilityClearParams, { cleared: boolean }];
  'companion.availability.refresh_runtime': [IcpRuntimeAvailabilityRefreshParams, IcpOwnAvailabilityResult];
  'companion.availability.clear_runtime': [IcpRuntimeAvailabilityClearParams, IcpOwnAvailabilityResult];
  'companion.availability.read_peer': [IcpPeerAvailabilityReadParams, IcpPeerAvailabilityResult];
  'companion.availability.read_self': [IcpOwnAvailabilityReadParams, IcpOwnAvailabilityResult];
  'companion.initiation.preflight': [IcpInitiationPreflightParams, IcpInitiationGateDecision];
  'companion.initiation.permit.issue': [IcpInitiationPermitIssueParams, IcpInitiationPermitIssueResult];
  'companion.initiation.permit.prepare_handoff': [IcpInitiationHandoffPrepareParams, IcpInitiationHandoffPrepareResult];
  'companion.initiation.permit.consume': [IcpPermitConsumeParams, IcpPermitConsumeResult];
  'companion.initiation.permit.revoke': [IcpPermitRevokeParams, IcpPermitRevokeResult];
  'companion.initiation.permit.invalidate_for_self': [IcpPermitInvalidateSelfParams, { revokedCount: number }];
  'web.fetch': [WebFetchParams, WebFetchResult];
  'web.fetch_binary': [WebFetchBinaryParams, WebFetchBinaryResult];
  'web.request_binary': [WebRequestBinaryParams, WebRequestBinaryResult];
  'home_assistant.get_states': [HomeAssistantGetStatesParams, HomeAssistantGetStatesResult];
  'home_assistant.call_service': [HomeAssistantCallServiceParams, HomeAssistantCallServiceResult];
  'home_assistant.check_connection': [HomeAssistantCheckConnectionParams, HomeAssistantCheckConnectionResult];
  'web.search': [WebSearchParams, WebSearchResult];
  'mcp.execute': [McpExecuteParams, McpExecuteResult];
  'mcp.cancel': [McpCancelParams, McpCancelResult];
  'mcp.release': [McpReleaseParams, McpReleaseResult];
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
  'notify.operator': [NotifyNtfyParams, OperatorAlertResult];
  'clarify.deliver': [ClarifyDeliverParams, ClarifyDeliverResult];
  'shard.backend.request': [ShardBackendRequestParams, ShardBackendRequestResult];
  'shard.workload.register': [ShardWorkloadRegisterParams, ShardWorkloadRegisterResult];
  'shard.workload.end': [ShardWorkloadEndParams, ShardWorkloadEndResult];
  'confirmation.list': [ConfirmationListParams, ConfirmationListResult];
  'confirmation.history': [ConfirmationHistoryListParams, ConfirmationHistoryListResult];
  'confirmation.resolve': [ConfirmationResolveParams, ConfirmationResolveResult];
  'memory.deletion.propose': [MemoryDeletionProposeParams, MemoryDeletionProposeResult];
  'runtime.health': [RuntimeHealthParams, RuntimeHealthResult];
  'runtime.credential_presence': [GatewayCredentialPresenceParams, GatewayCredentialPresenceResult];
  'kube.self_management': [KubeSelfManagementRequest, KubeSelfManagementResponse];
  'session.hmac.sign': [SessionHmacSignParams, SessionHmacSignResult];
  'session.hmac.verify': [SessionHmacVerifyParams, SessionHmacVerifyResult];
}

export interface GatewayNotifications {
  'llm.chunk': LLMChunkNotification;
  'llm.first_output': LLMFirstOutputNotification;
  'discord.message': DiscordMessageNotification;
  'companion.message': CompanionMessageNotification;
  'companion.message.delivery_failure': CompanionMessageDeliveryFailureNotification;
  'api.stream.delta': ApiStreamDeltaNotification;
}

// ── Policy types ──

export type GatewayPolicyDecision =
  | 'ALLOW'
  | 'DENY'
  | 'AUTONOMOUS_TIER_REQUIRED'
  | 'REQUIRES_HUMAN_APPROVAL';

export interface GatewayPolicyContext {
  method: string;
  params: Record<string, unknown>;
  /** Trusted server-derived caller class; never populated from RPC params. */
  callerClass?: 'companion' | 'shard';
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
  /** Structured silence outcome; never inferred from prose. */
  disposition?: 'decline' | 'no_op';
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

export interface MemoryDeletionPartnerAlertedParams {
  proposalId: string;
}

export interface MemoryDeletionProposalSnapshotParams {
  proposalId: string;
}

export interface MemoryDeletionProposalSnapshotResult {
  proposalId: string;
  memoryId: string;
  justificationCategory: string;
  explanation: string;
  status: 'pending_partner_alert' | 'pending_operator_validation' | 'approved' | 'denied' | 'restored';
  deleteId?: string;
}

export interface MemoryDeletionPartnerAlertedResult {
  proposalId: string;
  status: 'pending_operator_validation';
}

export interface MemoryDeletionResolveParams {
  proposalId: string;
  decision: 'approve' | 'deny';
  operatorId: string;
}

export interface MemoryDeletionResolveResult {
  proposalId: string;
  status: 'approved' | 'denied';
  deleteId?: string;
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
  'memory.deletion.snapshot': [
    MemoryDeletionProposalSnapshotParams,
    MemoryDeletionProposalSnapshotResult,
  ];
  'memory.deletion.partner_alerted': [
    MemoryDeletionPartnerAlertedParams,
    MemoryDeletionPartnerAlertedResult,
  ];
  'memory.deletion.resolve': [MemoryDeletionResolveParams, MemoryDeletionResolveResult];
  'contact.authority.snapshot': [
    ContactAuthoritySnapshotRequest,
    VerifiedDiscordContactAuthoritySnapshot | null,
  ];
  'voice.handleMessage': [VoiceHandleMessageParams, VoiceHandleMessageResult];
  // mmo9.8.6: inbound transcript-chunking family renamed voice.stream.* ->
  // voice.transcript.*. Both names are registered on the same handlers and kept
  // typed here so version skew stays type-safe; do not remove the legacy names.
  'voice.stream.start': [VoiceStreamStartParams, VoiceStreamAckResult];
  'voice.stream.chunk': [VoiceStreamChunkParams, VoiceStreamAckResult];
  'voice.stream.end': [VoiceStreamEndParams, VoiceStreamEndResult];
  'voice.stream.cancel': [VoiceStreamCancelParams, VoiceStreamCancelResult];
  'voice.transcript.begin': [VoiceStreamStartParams, VoiceStreamAckResult];
  'voice.transcript.chunk': [VoiceStreamChunkParams, VoiceStreamAckResult];
  'voice.transcript.end': [VoiceStreamEndParams, VoiceStreamEndResult];
  'voice.transcript.cancel': [VoiceStreamCancelParams, VoiceStreamCancelResult];
  'api.chat.completion': [ApiChatCompletionRpcParams, ApiChatCompletionRpcResult];
  'api.chat.cancel': [ApiChatCompletionCancelRpcParams, ApiChatCompletionCancelRpcResult];
  'api.companion-ui.shard.action': [
    ApiCompanionUiShardActionRpcParams,
    ApiCompanionUiShardActionRpcResult,
  ];
  'shard.directory.owner': [ApiShardOwnerRpcParams, ApiShardOwnerRpcResult];
  'api.telemetry.ingest': [ApiTelemetryIngestRpcParams, ApiTelemetryIngestRpcResult];
  'api.health': [Record<string, never>, ApiHealthRpcResult];
  'telemetry.turn.performance': [TurnPerformanceIngestParams, TurnPerformanceIngestResult];
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
  MODEL_BUDGET_BLOCKED: -32015,
  ICP_CONVERSATION_COST_BLOCKED: -32016,
  /** Retained image reference was absent, expired, evicted, or outside its request scope. */
  INLINE_IMAGE_RETENTION_MISS: -32017,
  /**
   * mmo9.5.1: an in-flight PREEMPTABLE background model call was aborted at the
   * gateway's model-call gate by a higher-priority (foreground) acquire. Carries
   * the preempted/preemptor runtime classes so the agent can reconstruct the
   * typed ModelCallPreemptedError and defer (no attempt consumed) rather than
   * treat the abort as a generic provider failure.
   */
  MODEL_CALL_PREEMPTED: -32018,
  /**
   * d8vq.2: an RPC-transported LLMWorkSpec was structurally
   * malformed (missing/invalid required field or out-of-domain value). Rejected
   * at the boundary before any provider I/O — fail closed.
   */
  INVALID_WORK_SPEC: -32019,
  /**
   * 23pp: a per-companion model selection slot key did not resolve to an
   * enabled models.json registry entry. Rejected at the boundary before any
   * provider I/O — fail closed, never silently substituted.
   */
  UNKNOWN_MODEL_SELECTION_SLOT: -32020,
  /**
   * oetdv: an `llm.cancel` request was structurally invalid (non-object params,
   * missing cancellationId, or a non-canonical UUID). Surfaced as a typed
   * gateway error instead of a bare Error flattened to JSON-RPC code 0, so a
   * malformed cancel is observable in the audit trail rather than a silent
   * console.warn no-op while the provider keeps burning tokens.
   */
  INVALID_LLM_CANCELLATION: -32021,
  /**
   * The vision lane resolved to a catalog model without explicit image-input
   * capability. Rejected before provider I/O so image analysis never degrades
   * into an ungrounded text-only completion.
   */
  VISION_PURPOSE_RESOLVED_NON_VISION_MODEL: -32022,
} as const;
