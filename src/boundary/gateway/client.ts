// ── Gateway Client ──
// Agent-side typed RPC wrapper. Implements LLMProviderPort and EmbeddingProviderPort
// so it can be used as a drop-in replacement for direct clients.

import { JSONRPCErrorException } from 'json-rpc-2.0';
import { randomUUID } from 'node:crypto';
import type {
  LLMProviderPort,
  LLMProviderStreamOptions,
  LLMProviderCompletionOptions,
} from '../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { toWorkSpecWireParams } from '../../primitives/llm/work-spec-wire.js';
import type { Attachment, CompletionPurpose, CorrelationMetadata, LLMContext, LLMModelHint, LLMResponse, ModelBudgetBlockedEvent, ModelPurposeSelection, StreamCallbacks, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  GatewayRpcConnection,
  GatewayRpcEndpoint,
  GatewayRpcSerializedTransportStats,
} from './transport.js';
import type {
  GatewaySystemDataWriterPort,
  SystemDataWriteRequest,
  SystemDataWriteResult,
} from './system-data-writer.js';
import { parseSystemDataWriteResult } from './system-data-writer.js';
import {
  createSocketClient,
  createWebSocketRpcClient,
} from './transport.js';
import { createComponentLogger } from '../../shared/logger.js';
import { getMcpTurnDisclosureContext } from '../../core/cogsec/disclosure/mcp-turn-context.js';
import type { QueueOverflowPolicy } from './backpressure.js';
import { GatewayClientTransportRuntime } from './client/transport-runtime.js';
import { GatewayClientSessionIntegrityRuntime } from './client/session-integrity-runtime.js';
import {
  GatewayClientReverseRpcRuntime,
  type IcpLocalPolicyAuthorityPort,
} from './client/reverse-rpc-runtime.js';
import type { MessageHandler } from '../../channels/backplane/types.js';
import {
  type ContactAuthoritySnapshotRequest,
  type VerifiedDiscordContactAuthoritySnapshot,
} from '../../shared/contracts/contact-authority-snapshot.js';
const log = createComponentLogger('GatewayClient');

import type { JournalIntegrityVerificationResult } from '../../persistence/journals/journal-utils.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiCompanionUiShardActionRpcParams,
  ApiCompanionUiShardActionRpcResult,
  ApiHealthRpcResult,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
  ApiShardOwnerRpcParams,
  ApiShardOwnerRpcResult,
  SatelliteResponseEligibilityRpcParams,
  SatelliteResponseEligibilityRpcResult,
} from '../../channels/api/types.js';
import type { SessionIntegrityProvider } from '../../persistence/sessions/store.js';
import type { VisionIntakeImageScreenResult } from './intake/vision-screener.js';
import type { JournalEntry } from '../../core/session/types.js';
import type { ConfirmationResolveResult } from '../../system/capabilities/confirmation-queue.js';
import type { CompanionRelayPublishParams } from '../../channels/backplane/companion-relay/relay.js';
import { isGardenQueueName, type GardenQueueName } from '../../shared/event-bus.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionApprovalRequest,
  MemoryDeletionApprovalResult,
} from '../../faculties/memory/deletion-proposals.js';
import { stripChargeAttribution } from '../../shared/telemetry/model-usage-attribution.js';
import type {
  GitCommitResult,
  GitDiffResult,
  GitStatusResult,
} from '../integrations/git/ops.js';
import type {
  ImageCreateParams,
  ImageEditParams,
} from '../../primitives/images/types.js';
import type { DiscoveredModel, GatewayModelDiscoveryTransport } from '../../primitives/llm/discovery.js';
import type {
  VaultDailyResult,
  VaultReadResult,
  VaultSearchResult,
  VaultWriteResult,
} from '../integrations/vault/ops.js';
import type {
  LLMChatResult,
  LLMCompleteResult,
  LLMDiscoverModelsResult,
  LLMEmbedResult,
  LLMInvalidateModelDiscoveryResult,
  DiscordSendResult,
  DiscordSendMediaResult,
  DiscordAvailabilityResult,
  WebFetchResult,
  WebFetchBinaryResult,
  WebRequestBinaryResult,
  WebSearchResult,
  WebFetchLane,
  ShellExecResult,
  ShardBackendRequestParams,
  ShardBackendRequestResult,
  ShardWorkloadRegisterResult,
  FsReadResult,
  FsWriteResult,
  FsListResult,
  FsSearchParams,
  FsSearchResult,
  FsEditParams,
  FsEditResult,
  CompanionMessageNotification,
  CompanionMessageDeliveryFailureNotification,
  CompanionMessageFailureReportParams,
  CompanionMessageFailureReportResult,
  CompanionMessageSendResult,
  DiscordMessageNotification,
  LLMChunkNotification,
  NotifyNtfyParams,
  NotifyNtfyResult,
  OperatorAlertResult,
  ClarifyDeliverParams,
  ClarifyDeliverResult,
  ConfirmationListResult,
  ConfirmationResolveParams,
  RuntimeHealthResult,
  KubeSelfManagementRequest,
  KubeSelfManagementResponse,
  GatewayCredentialPresenceResult,
  SessionHmacSignResult,
  SessionHmacVerifyResult,
  GitDiffParams,
  GitCreateBranchResult,
  GitApplyPatchResult,
  GitOpenPRResult,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsCreateParams,
  BeadsUpdateParams,
  BeadsCloseParams,
  BeadsSyncParams,
  BeadsActionResult,
  HomeAssistantGetStatesParams,
  HomeAssistantGetStatesResult,
  HomeAssistantCallServiceParams,
  HomeAssistantCallServiceResult,
  ImageGenerationRpcResult,
  IcpAvailabilityPublishParams,
  IcpAvailabilityClearParams,
  IcpRuntimeAvailabilityClearParams,
  IcpRuntimeAvailabilityRefreshParams,
  IcpPeerAvailabilityReadParams,
  IcpInitiationPreflightParams,
  IcpInitiationPermitIssueParams,
  IcpInitiationHandoffPrepareParams,
  IcpPermitConsumeParams,
  IcpPermitConsumeResult,
  IcpPermitRevokeParams,
  IcpPermitRevokeResult,
  IcpPermitInvalidateSelfParams,
  GatewayCorrelationParams,
  ContactLifecycleExecuteResult,
  MemoryDeletionPartnerAlertedParams,
  MemoryDeletionPartnerAlertedResult,
  MemoryDeletionProposalSnapshotParams,
  MemoryDeletionProposalSnapshotResult,
  MemoryDeletionResolveParams,
  MemoryDeletionResolveResult,
  McpExecuteParams,
  McpExecuteResult,
  McpReleaseResult,
} from './protocol.js';
import type {
  AuthenticatedShardWorkloadHandle,
  ShardWorkloadLifecyclePort,
  ShardWorkloadRegistrationInput,
} from '../../system/capabilities/shard-approval-grant-contracts.js';
import type { ContactAuthorityLifecycleRequest } from '../../shared/contracts/contact-authority-lifecycle.js';
import { parseContactAuthorityLifecycleResult } from '../../shared/contracts/contact-authority-lifecycle.js';
import type {
  IcpInitiationGateDecision,
  IcpInitiationHandoffPrepareResult,
  IcpInitiationPermitIssueResult,
  IcpOwnAvailabilityReadParams,
  IcpOwnAvailabilityResult,
  IcpPeerAvailabilityResult,
} from './icp-autonomy-contract.js';
import {
  deriveIcpTransportMessageId,
  type IcpAvailabilityLease,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import { GatewayErrors } from './protocol.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { GatewayInlineImageReferenceHints } from './inline-image-reference-hints.js';
import {
  normalizeModelHint,
  OPTIONAL_MODEL_HINT_NORMALIZATION,
  resolveModelSelectionSlotForPurpose,
} from '../../primitives/llm/model-hint-routing.js';
import {
  toCompletionRoutingPurpose,
  toStreamRoutingPurpose,
  type RoutingPurpose,
} from '../../primitives/llm/routing.js';
import { parseModelBudgetBlockedEvent } from '../../shared/contracts/model-budget.js';
import { parseIcpConversationCostBreakerEvent } from '../../shared/contracts/icp-conversation-cost.js';
import { IcpConversationCostBreakerError } from '../../primitives/llm/icp-conversation-cost-breaker.js';
import {
  ModelCallPreemptedError,
  modelCallPreemptedErrorFromData,
} from '../../primitives/llm/model-call-gate.js';
import { resolveCorrelationMetadata } from '../../primitives/llm/correlation.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { getRunChargeSnapshot } from '../../shared/telemetry/run-charge.js';
import {
  createCompanionId,
  type CompanionId,
  type OptionalCompanionRoutingBinding,
} from '../../shared/routing/companion-id.js';
import type { TurnPerformanceEvent } from '../../shared/telemetry/turn-performance.js';
import type { FleetCompanionPostureSummary } from '../../shared/telemetry/fleet-posture.js';

const DEFAULT_VOICE_STREAM_QUEUE_SIZE = 32;
const DEFAULT_VOICE_STREAM_OVERFLOW_POLICY: QueueOverflowPolicy = 'error';
const DEFAULT_SESSION_INTEGRITY_RPC_TIMEOUT_MS = 3_000;
const DEFAULT_GATEWAY_KEEPALIVE_INTERVAL_MS = 30_000;

export interface GatewayClientOptions extends OptionalCompanionRoutingBinding {
  voiceStreamQueueSize?: number;
  voiceStreamOverflowPolicy?: QueueOverflowPolicy;
  sessionIntegritySocketPath?: string;
  sessionIntegrityEndpoint?: GatewayRpcEndpoint;
  sessionIntegrityRpcTimeoutMs?: number;
  sessionIntegritySignMaxRetries?: number;
  sessionIntegritySignRetryBaseDelayMs?: number;
  keepaliveIntervalMs?: number;
  /**
   * Multi-companion (sprint-10 W1): the companion this agent process acts for
   * (COMPANION_ID via load-config). Stamped on gateway.client.identify and on
   * LLM correlation params so the gateway can verify companion identity.
   */
  companionId?: CompanionId;
  /** Fleet-scoped proof paired with companionId during gateway identification. */
  companionAuthToken?: string;
  /** Role-bound proof exposed only to the isolated session-integrity worker. */
  sessionIntegrityAuthToken?: string;
  onModelBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  /**
   * 23pp per-companion model selection: canonical purpose → models.json
   * registry entry id, resolved from the companion's effective settings
   * (settings.json + settings.overlay.json) and validated at agent startup.
   * Injected as the wire `slotKey` when a call carries no explicit model hint;
   * the gateway re-validates it fail-closed against its own registry.
   */
  modelPurposeSelection?: ModelPurposeSelection;
}

function modelBudgetBlockedEventFromError(error: unknown): ModelBudgetBlockedEvent | undefined {
  if (!(error instanceof JSONRPCErrorException) || error.code !== GatewayErrors.MODEL_BUDGET_BLOCKED) {
    return undefined;
  }
  try {
    return parseModelBudgetBlockedEvent(error.data);
  } catch {
    return undefined;
  }
}

/**
 * mmo9.5.1: reconstruct the typed preemption error the gateway's model-call
 * gate raised, so a preempted background call defers (no attempt consumed)
 * instead of being misread as a generic provider failure. Without this the
 * gateway error arrives as a flattened -32603 and the agent's name-match
 * (`error.name === 'ModelCallPreemptedError'`) fails, exhausting retries and
 * losing the background cognition job.
 */
function modelCallPreemptedErrorFromRpc(
  error: unknown,
): ModelCallPreemptedError | undefined {
  if (
    !(error instanceof JSONRPCErrorException)
    || error.code !== GatewayErrors.MODEL_CALL_PREEMPTED
  ) {
    return undefined;
  }
  return modelCallPreemptedErrorFromData(error.data);
}

function icpConversationCostBreakerErrorFromRpc(
  error: unknown,
): IcpConversationCostBreakerError | undefined {
  if (
    !(error instanceof JSONRPCErrorException)
    || error.code !== GatewayErrors.ICP_CONVERSATION_COST_BLOCKED
  ) {
    return undefined;
  }
  try {
    const event = parseIcpConversationCostBreakerEvent(error.data);
    return event.outcome === 'blocked'
      ? new IcpConversationCostBreakerError({ ...event, outcome: 'blocked' })
      : undefined;
  } catch {
    return undefined;
  }
}

function buildOutboundUsageCorrelation(
  companionId: string | undefined,
  correlation: Partial<CorrelationMetadata> | undefined,
): GatewayCorrelationParams {
  const resolvedCorrelation = correlation?.icpCorrelation
    ? resolveCorrelationMetadata(correlation, undefined, 'background')
    : correlation;
  const declaredCompanionId = resolvedCorrelation?.companionId?.trim();
  if (companionId && declaredCompanionId && declaredCompanionId !== companionId) {
    throw new Error(
      `Gateway usage correlation companionId ${JSON.stringify(declaredCompanionId)} does not match `
      + `the authenticated client companion ${JSON.stringify(companionId)}`,
    );
  }
  const charge = getRunChargeSnapshot();
  const canonicalIcpChargeLane = resolvedCorrelation?.icpCorrelation
    ? resolvedCorrelation.chargeLane
    : undefined;
  // #49: companion_private work (e.g. blinded introspection audits) must not
  // carry re-identifying turn/request/channel/tool linkage to the gateway. The
  // visibility flag still rides along so downstream telemetry stays filtered.
  const companionPrivate = correlation?.telemetryVisibility === 'companion_private';
  return {
    ...(companionId ? { companionId } : (declaredCompanionId ? { companionId: declaredCompanionId } : {})),
    ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
    ...(!companionPrivate && resolvedCorrelation?.turnId ? { turnId: resolvedCorrelation.turnId } : {}),
    ...(!companionPrivate && resolvedCorrelation?.requestId ? { requestId: resolvedCorrelation.requestId } : {}),
    ...(!companionPrivate && resolvedCorrelation?.channelId ? { channelId: resolvedCorrelation.channelId } : {}),
    ...(resolvedCorrelation?.channelType ? { channelType: resolvedCorrelation.channelType } : {}),
    ...(resolvedCorrelation?.callType ? { callType: resolvedCorrelation.callType } : {}),
    ...(resolvedCorrelation?.originType ? { originType: resolvedCorrelation.originType } : {}),
    ...(resolvedCorrelation?.originStage ? { originStage: resolvedCorrelation.originStage } : {}),
    ...(!companionPrivate && resolvedCorrelation?.toolName ? { toolName: resolvedCorrelation.toolName } : {}),
    ...(!companionPrivate && resolvedCorrelation?.toolCallId ? { toolCallId: resolvedCorrelation.toolCallId } : {}),
    ...(resolvedCorrelation?.purpose ? { purpose: resolvedCorrelation.purpose } : {}),
    ...(companionPrivate ? { telemetryVisibility: 'companion_private' as const } : {}),
    ...(resolvedCorrelation?.service ? { service: resolvedCorrelation.service } : {}),
    ...(resolvedCorrelation?.process ? { process: resolvedCorrelation.process } : {}),
    ...(canonicalIcpChargeLane
      ? { chargeLane: canonicalIcpChargeLane }
      : (charge?.lane ? { chargeLane: charge.lane } : (resolvedCorrelation?.chargeLane
        ? { chargeLane: resolvedCorrelation.chargeLane }
        : {}))),
    ...(charge?.surface
      ? { chargeSurface: charge.surface }
      : (resolvedCorrelation?.chargeSurface ? { chargeSurface: resolvedCorrelation.chargeSurface } : {})),
    ...(charge?.chargeEventId
      ? { chargeEventId: charge.chargeEventId }
      : (resolvedCorrelation?.chargeEventId ? { chargeEventId: resolvedCorrelation.chargeEventId } : {})),
    ...(charge?.lineage.runId
      ? { chargeRunId: charge.lineage.runId }
      : (resolvedCorrelation?.chargeRunId ? { chargeRunId: resolvedCorrelation.chargeRunId } : {})),
    ...(charge?.lineage.rootRunId
      ? { chargeRootRunId: charge.lineage.rootRunId }
      : (resolvedCorrelation?.chargeRootRunId ? { chargeRootRunId: resolvedCorrelation.chargeRootRunId } : {})),
    ...(charge?.lineage.parentRunId
      ? { chargeParentRunId: charge.lineage.parentRunId }
      : (resolvedCorrelation?.chargeParentRunId ? { chargeParentRunId: resolvedCorrelation.chargeParentRunId } : {})),
    ...(resolvedCorrelation?.shardId ? { shardId: resolvedCorrelation.shardId } : {}),
    ...(resolvedCorrelation?.subagentId ? { subagentId: resolvedCorrelation.subagentId } : {}),
    ...(resolvedCorrelation?.conversationId ? { conversationId: resolvedCorrelation.conversationId } : {}),
    ...(resolvedCorrelation?.rootInitiationId ? { rootInitiationId: resolvedCorrelation.rootInitiationId } : {}),
    ...(resolvedCorrelation?.workloadType ? { workloadType: resolvedCorrelation.workloadType } : {}),
    ...(resolvedCorrelation?.workloadId ? { workloadId: resolvedCorrelation.workloadId } : {}),
    ...(resolvedCorrelation?.icpCorrelation ? { icpCorrelation: resolvedCorrelation.icpCorrelation } : {}),
  };
}

export interface GatewayConnectionCloseEvent {
  source: 'close' | 'error';
  error?: Error;
}

export type { IcpLocalPolicyAuthorityPort } from './client/reverse-rpc-runtime.js';

export class GatewayClient implements
  LLMProviderPort,
  EmbeddingProviderPort,
  GatewayModelDiscoveryTransport,
  GatewaySystemDataWriterPort,
  ShardWorkloadLifecyclePort,
  MemoryDeletionApprovalPort {
  private transportRuntime: GatewayClientTransportRuntime;
  private reverseRpcRuntime: GatewayClientReverseRpcRuntime;
  private embeddingDims: number;
  private connectionCloseHandlers = new Set<(event: GatewayConnectionCloseEvent) => void>();
  private chunkHandlers = new Map<string, (text: string) => void>();
  private firstOutputHandlers = new Map<
    string,
    NonNullable<StreamCallbacks['onFirstOutput']>
  >();
  private requestCounter = 0;
  private readonly voiceStreamQueueSize: number;
  private readonly voiceStreamOverflowPolicy: QueueOverflowPolicy;
  private readonly sessionIntegrityEndpoint: GatewayRpcEndpoint | null;
  private readonly sessionIntegrityRpcTimeoutMs: number;
  private readonly sessionIntegritySignMaxRetries?: number;
  private readonly sessionIntegritySignRetryBaseDelayMs?: number;
  private readonly sessionIntegrityRuntime: GatewayClientSessionIntegrityRuntime;
  private readonly keepaliveIntervalMs: number;
  private closedNotified = false;
  private isDestroying = false;
  private readonly companionId?: CompanionId;
  private readonly companionAuthToken?: string;
  private readonly sessionIntegrityAuthToken?: string;
  private readonly inlineImageReferenceHints = new GatewayInlineImageReferenceHints();
  private readonly onModelBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  private readonly modelPurposeSelection?: ModelPurposeSelection;
  private readonly shardWorkloadRegistrationIds =
    new WeakMap<AuthenticatedShardWorkloadHandle, string>();
  /** Opaque gateway permits stay outside model-visible tool-call objects. */
  private readonly mcpPermitByToolCallId = new Map<string, string>();

  constructor(conn: GatewayRpcConnection, embeddingDims: number, options: GatewayClientOptions = {}) {
    this.embeddingDims = embeddingDims;
    if (options.companionId !== undefined) {
      this.companionId = createCompanionId(options.companionId, 'GatewayClient companionId');
    }
    if (options.companionAuthToken !== undefined) {
      const trimmed = options.companionAuthToken.trim();
      if (!trimmed) {
        throw new Error('GatewayClient companionAuthToken must be a non-empty string when provided');
      }
      this.companionAuthToken = trimmed;
    }
    if (options.sessionIntegrityAuthToken !== undefined) {
      const trimmed = options.sessionIntegrityAuthToken.trim();
      if (!trimmed) {
        throw new Error('GatewayClient sessionIntegrityAuthToken must be a non-empty string when provided');
      }
      this.sessionIntegrityAuthToken = trimmed;
    }
    this.voiceStreamQueueSize = options.voiceStreamQueueSize ?? DEFAULT_VOICE_STREAM_QUEUE_SIZE;
    this.voiceStreamOverflowPolicy = options.voiceStreamOverflowPolicy ?? DEFAULT_VOICE_STREAM_OVERFLOW_POLICY;
    this.sessionIntegrityEndpoint = options.sessionIntegrityEndpoint
      ?? (options.sessionIntegritySocketPath
        ? { kind: 'unix', socketPath: options.sessionIntegritySocketPath }
        : null);
    this.sessionIntegrityRpcTimeoutMs = options.sessionIntegrityRpcTimeoutMs ?? DEFAULT_SESSION_INTEGRITY_RPC_TIMEOUT_MS;
    this.sessionIntegritySignMaxRetries = options.sessionIntegritySignMaxRetries;
    this.sessionIntegritySignRetryBaseDelayMs = options.sessionIntegritySignRetryBaseDelayMs;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_GATEWAY_KEEPALIVE_INTERVAL_MS;
    this.onModelBudgetBlocked = options.onModelBudgetBlocked;
    if (options.modelPurposeSelection !== undefined) {
      this.modelPurposeSelection = { ...options.modelPurposeSelection };
    }

    if (!Number.isInteger(this.voiceStreamQueueSize) || this.voiceStreamQueueSize <= 0) {
      throw new Error(`voiceStreamQueueSize must be a positive integer, got ${this.voiceStreamQueueSize}`);
    }
    if (!Number.isInteger(this.sessionIntegrityRpcTimeoutMs) || this.sessionIntegrityRpcTimeoutMs <= 0) {
      throw new Error(
        `sessionIntegrityRpcTimeoutMs must be a positive integer, got ${this.sessionIntegrityRpcTimeoutMs}`,
      );
    }
    const hasConfiguredSignMaxRetries = typeof this.sessionIntegritySignMaxRetries === 'number'; // ubs:ignore — compares optional retry configuration type, not signature or secret material
    const hasConfiguredSignRetryDelay = typeof this.sessionIntegritySignRetryBaseDelayMs === 'number';
    if (hasConfiguredSignMaxRetries !== hasConfiguredSignRetryDelay) {
      throw new Error(
        'sessionIntegritySignMaxRetries and sessionIntegritySignRetryBaseDelayMs must be configured together',
      );
    }
    if (hasConfiguredSignMaxRetries
      && (!Number.isInteger(this.sessionIntegritySignMaxRetries)
        || this.sessionIntegritySignMaxRetries < 0)) {
      throw new Error(
        'sessionIntegritySignMaxRetries must be a non-negative integer, '
        + `got ${this.sessionIntegritySignMaxRetries}`,
      );
    }
    if (hasConfiguredSignRetryDelay
      && (!Number.isInteger(this.sessionIntegritySignRetryBaseDelayMs)
        || this.sessionIntegritySignRetryBaseDelayMs < 0)) {
      throw new Error(
        'sessionIntegritySignRetryBaseDelayMs must be a non-negative integer, '
        + `got ${this.sessionIntegritySignRetryBaseDelayMs}`,
      );
    }
    if (!Number.isInteger(this.keepaliveIntervalMs) || this.keepaliveIntervalMs <= 0) {
      throw new Error(`keepaliveIntervalMs must be a positive integer, got ${this.keepaliveIntervalMs}`);
    }

    this.sessionIntegrityRuntime = new GatewayClientSessionIntegrityRuntime({
      endpoint: this.sessionIntegrityEndpoint,
      rpcTimeoutMs: this.sessionIntegrityRpcTimeoutMs,
      signMaxRetries: this.sessionIntegritySignMaxRetries,
      signRetryBaseDelayMs: this.sessionIntegritySignRetryBaseDelayMs,
      companionId: this.companionId,
      authToken: this.sessionIntegrityAuthToken,
    });

    this.transportRuntime = new GatewayClientTransportRuntime(conn, {
      onChunkNotification: (params) => this.handleChunkNotification(params),
      onFirstOutputNotification: (params) => this.handleFirstOutputNotification(params),
      onClose: (event) => this.emitConnectionClose(event),
    });
    this.reverseRpcRuntime = new GatewayClientReverseRpcRuntime({
      target: this.transportRuntime.target,
      send: (message) => this.transportRuntime.send(message),
      companionId: this.companionId,
      voiceStreamQueueSize: this.voiceStreamQueueSize,
      voiceStreamOverflowPolicy: this.voiceStreamOverflowPolicy,
      isClosed: () => this.isDestroying || this.closedNotified,
    });

    this.transportRuntime.startKeepalive(this.keepaliveIntervalMs);
  }

  static async connect(
    socketPath: string,
    embeddingDims: number,
    options: GatewayClientOptions = {},
  ): Promise<GatewayClient> {
    return await GatewayClient.connectEndpoint({ kind: 'unix', socketPath }, embeddingDims, options);
  }

  static async connectEndpoint(
    endpoint: GatewayRpcEndpoint,
    embeddingDims: number,
    options: GatewayClientOptions = {},
  ): Promise<GatewayClient> {
    const conn = endpoint.kind === 'unix'
      ? await createSocketClient({ socketPath: endpoint.socketPath })
      : await createWebSocketRpcClient({ url: endpoint.url, tls: endpoint.tls });
    return new GatewayClient(conn, embeddingDims, {
      ...options,
      sessionIntegrityEndpoint: options.sessionIntegrityEndpoint
        ?? (options.sessionIntegritySocketPath
          ? { kind: 'unix', socketPath: options.sessionIntegritySocketPath }
          : endpoint),
    });
  }

  /**
   * Identify this connection to the gateway as an agent, self-reporting the
   * companionId when configured. Multi-companion gateways reject agents that
   * identify without a companionId (and duplicate companion identities), so a
   * failure here must abort agent startup — never continue unidentified.
   */
  async identifyAsAgent(): Promise<void> {
    await this.transportRuntime.request('gateway.client.identify', {
      role: 'agent',
      ...(this.companionId ? { companionId: this.companionId } : {}),
      ...(this.companionAuthToken ? { authToken: this.companionAuthToken } : {}),
    });
  }

  /**
   * Publish the application-level readiness boundary after every inbound
   * notification handler is installed. Identification authenticates the
   * process; it does not mean the runtime can safely consume partner traffic.
   */
  async declareRuntimeReady(): Promise<void> {
    const result = await this.transportRuntime.request('gateway.client.ready', {});
    if (!isRecord(result)
      || result.success !== true
      || Object.keys(result).length !== 1) {
      throw new Error('Gateway returned an invalid runtime-ready acknowledgement');
    }
  }

  /**
   * Attach the agent-owned deterministic welfare posture after its charge and
   * fatigue runtimes are ready. The initial report is acknowledged so invalid
   * wiring fails startup instead of silently leaving a fabricated healthy view.
   */
  async startFleetPostureReporting(
    provider: () => FleetCompanionPostureSummary,
  ): Promise<void> {
    if (!this.companionId) {
      throw new Error('Fleet posture reporting requires a configured companionId');
    }
    await this.transportRuntime.startFleetPostureReporting(provider);
  }

  /**
   * 23pp: the model-selection slot key to transport for a call, or undefined.
   * An explicit hint slot key is forwarded as-is; an explicit hint model
   * suppresses injection entirely (per-request overrides beat the companion
   * default); otherwise the companion's configured selection for the call's
   * routing lane applies. Slot validity is enforced fail-closed at agent
   * startup AND again by the gateway's registry when the call is served.
   */
  private resolveSelectionSlotKeyForCall(
    modelHint: LLMModelHint | undefined,
    routingPurpose: RoutingPurpose,
  ): string | undefined {
    if (modelHint?.slotKey) return modelHint.slotKey;
    if (modelHint?.model) return undefined;
    return resolveModelSelectionSlotForPurpose(this.modelPurposeSelection, routingPurpose);
  }

  // ── LLMProviderPort interface ──

  async stream(
    context: LLMContext,
    callbacks?: StreamCallbacks,
    options?: LLMProviderStreamOptions,
  ): Promise<LLMResponse> {
    // Keep one opaque fallback available even when private telemetry strips
    // source correlation. Stream notifications still need a connection-local
    // routing key that cannot expose the source request identifier.
    const opaqueRoutingRequestId = `req-${++this.requestCounter}`;
    const contextRequestId = context.correlation?.requestId?.trim()
      || context.correlation?.icpCorrelation?.requestId.trim()
      || opaqueRoutingRequestId;
    const callType = context.correlation?.callType
      ?? context.correlation?.originType
      ?? 'chat';
    const purpose = context.correlation?.purpose
      ?? context.correlation?.originStage
      ?? 'chat';
    // Autonomous streamed calls declare their correlation on the work spec.
    // Resolve that option-level correlation through the same canonical seam as
    // the in-process LLMClient before flattening it onto the gateway request.
    // Interactive calls without a work spec intentionally retain the existing
    // byte-for-byte correlation construction.
    const resolvedStreamCorrelation = options?.workSpec
      ? resolveCorrelationMetadata(
          { ...(context.correlation ?? {}), requestId: contextRequestId },
          options.workSpec.correlation,
          options.workSpec.purpose,
        )
      : {
          ...(context.correlation ?? {}),
          requestId: contextRequestId,
          callType,
          purpose,
        };
    const streamRequestId = resolvedStreamCorrelation.telemetryVisibility === 'companion_private'
      ? opaqueRoutingRequestId
      : (resolvedStreamCorrelation.requestId.trim() || opaqueRoutingRequestId);
    const usageCorrelation = buildOutboundUsageCorrelation(
      this.companionId,
      resolvedStreamCorrelation,
    );
    const modelHint = normalizeModelHint(context.modelHint, OPTIONAL_MODEL_HINT_NORMALIZATION);
    const hintedModel = normalizeCorrelationText(modelHint?.model);
    const hintedProvider = normalizeCorrelationText(modelHint?.provider);
    const qualifiedHint = hintedModel ? parseProviderQualifiedModel(hintedModel) : null;
    const model = qualifiedHint?.model ?? hintedModel ?? '';
    const provider = (hintedProvider ?? qualifiedHint?.provider ?? '').trim().toLowerCase();
    // 23pp per-companion model selection: transport the companion's configured
    // slot key for the lane this streamed call routes to (interactive chat
    // unless a work spec declares a background purpose). Explicit model hints
    // take precedence; the gateway re-validates the slot fail-closed.
    const selectionSlotKey = this.resolveSelectionSlotKeyForCall(
      modelHint,
      toStreamRoutingPurpose(options?.workSpec?.purpose),
    );

    // Register chunk handler before sending the RPC so no chunks are missed
    if (callbacks?.onText) {
      this.chunkHandlers.set(streamRequestId, callbacks.onText);
    }
    if (callbacks?.onFirstOutput) {
      this.firstOutputHandlers.set(streamRequestId, callbacks.onFirstOutput);
    }

    try {
      const referencedMessages = this.inlineImageReferenceHints.referenceMessages(
        context.messages,
        context.correlation?.turnId,
      );
      const mcpDisclosureLineage = getMcpTurnDisclosureContext()?.getLineage();
      const requestParams = {
        model,  // gateway resolves roster defaults when hint fields are unset
        provider,
        ...usageCorrelation,
        // This ID is transport routing, not source correlation. Private calls
        // receive the opaque connection-local ID above after their source
        // identifiers have been collapsed.
        requestId: streamRequestId,
        ...(selectionSlotKey !== undefined ? { slotKey: selectionSlotKey } : {}),
        ...(modelHint?.pin !== undefined ? { pin: modelHint.pin } : {}),
        messages: referencedMessages.messages,
        systemPrompt: context.systemPrompt,
        ...(context.promptCacheBoundaries ? { promptCacheBoundaries: context.promptCacheBoundaries } : {}),
        stream: Boolean(callbacks?.onText || callbacks?.onFirstOutput),
        ...(modelHint?.maxTokens !== undefined ? { maxTokens: modelHint.maxTokens } : {}),
        ...(modelHint?.contextWindow !== undefined ? { contextWindow: modelHint.contextWindow } : {}),
        ...(modelHint?.thinkingEnabled !== undefined ? { thinkingEnabled: modelHint.thinkingEnabled } : {}),
        ...(modelHint?.thinkingEffort !== undefined ? { thinkingEffort: modelHint.thinkingEffort } : {}),
        ...(modelHint?.temperature !== undefined ? { temperature: modelHint.temperature } : {}),
        ...(modelHint?.topP !== undefined ? { topP: modelHint.topP } : {}),
        ...(modelHint?.topK !== undefined ? { topK: modelHint.topK } : {}),
        ...(modelHint?.frequencyPenalty !== undefined ? { frequencyPenalty: modelHint.frequencyPenalty } : {}),
        ...(modelHint?.repetitionPenalty !== undefined ? { repetitionPenalty: modelHint.repetitionPenalty } : {}),
        ...(context.tools?.length ? { tools: context.tools } : {}),
        ...(mcpDisclosureLineage
          ? { mcpOutboundSensitivity: mcpDisclosureLineage.effectiveSensitivity }
          : {}),
        ...(context.accounting ? { accounting: context.accounting } : {}),
        // d8vq.2: carry the declared work spec (minus its
        // correlation, which rides the flat correlation params) so the
        // gateway-side LLMClient enforces the accountability guard + lane
        // reconciliation on an autonomous streamed call.
        ...(options?.workSpec ? { workSpec: toWorkSpecWireParams(options.workSpec) } : {}),
      };
      let result: LLMChatResult;
      try {
        // mmo9.6.1: route through the abort-aware request path so a barge-in
        // AbortSignal (carried as options.signal, mmo9.5.1 shape) tears down the
        // in-flight streaming turn rather than only dropping locally-consumed
        // chunks.
        result = await this.requestWithAbortSignal<LLMChatResult>(
          'llm.chat',
          requestParams,
          options?.signal,
          'llm',
        );
      } catch (error) {
        if (!this.shouldResendInlineImages(error, referencedMessages.usedHintKeys)) throw error;
        this.inlineImageReferenceHints.invalidate(referencedMessages.usedHintKeys);
        log.warn('Gateway retained image unavailable; resending explicit inline bytes once', {
          requestId: streamRequestId,
          imageCount: referencedMessages.usedHintKeys.length,
        });
        result = await this.requestWithAbortSignal<LLMChatResult>(
          'llm.chat',
          {
            ...requestParams,
            messages: context.messages,
          },
          options?.signal,
          'llm',
        );
      }

      const resultToolCalls = result.toolCalls;
      for (const toolCall of resultToolCalls) {
        if (toolCall.name !== 'mcp') continue;
        const permit = toolCall.gatewayMcpPermit?.trim();
        if (permit) this.mcpPermitByToolCallId.set(toolCall.id, permit);
      }
      const response: LLMResponse = {
        content: result.content,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.providerObservability ? { providerObservability: result.providerObservability } : {}),
        toolCalls: resultToolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        })),
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ...(result.usageDetails ? { usageDetails: result.usageDetails } : {}),
        stopReason: result.stopReason,
      };

      callbacks?.onDone?.(response);
      return response;
    } catch (error) {
      const preemptBlock = modelCallPreemptedErrorFromRpc(error);
      if (preemptBlock) {
        callbacks?.onError?.(preemptBlock);
        throw preemptBlock;
      }
      const icpCostBlock = icpConversationCostBreakerErrorFromRpc(error);
      if (icpCostBlock) {
        callbacks?.onError?.(icpCostBlock);
        throw icpCostBlock;
      }
      const budgetBlock = modelBudgetBlockedEventFromError(error);
      if (budgetBlock) this.onModelBudgetBlocked?.(budgetBlock);
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    } finally {
      this.chunkHandlers.delete(streamRequestId);
      this.firstOutputHandlers.delete(streamRequestId);
    }
  }

  async complete(
    context: LLMContext,
    purpose: CompletionPurpose,
    options: LLMProviderCompletionOptions = {},
  ): Promise<LLMResponse> {
    const correlation = {
      ...(context.correlation ?? {}),
      ...(options.correlation ?? {}),
    };
    const usageCorrelation = buildOutboundUsageCorrelation(this.companionId, correlation);
    const modelHint = mergeGatewayModelHints(context.modelHint, options.modelHint);
    const hintedModel = normalizeCorrelationText(modelHint?.model);
    const hintedProvider = normalizeCorrelationText(modelHint?.provider);
    const qualifiedHint = hintedModel ? parseProviderQualifiedModel(hintedModel) : null;
    const model = qualifiedHint?.model ?? hintedModel ?? '';
    const provider = (hintedProvider ?? qualifiedHint?.provider ?? '').trim().toLowerCase();
    // 23pp per-companion model selection: transport the companion's configured
    // slot key for the lane this completion routes to. Explicit model hints
    // take precedence; the gateway re-validates the slot fail-closed.
    const selectionSlotKey = this.resolveSelectionSlotKeyForCall(
      modelHint,
      toCompletionRoutingPurpose(purpose),
    );

    const referencedMessages = this.inlineImageReferenceHints.referenceMessages(
      context.messages,
      correlation.turnId,
    );
    const requestParams = {
      model,
      provider,
      ...usageCorrelation,
      ...(selectionSlotKey !== undefined ? { slotKey: selectionSlotKey } : {}),
      ...(modelHint?.pin !== undefined ? { pin: modelHint.pin } : {}),
      messages: referencedMessages.messages,
      systemPrompt: context.systemPrompt,
      ...(context.promptCacheBoundaries ? { promptCacheBoundaries: context.promptCacheBoundaries } : {}),
      purpose,
      ...(modelHint?.maxTokens !== undefined ? { maxTokens: modelHint.maxTokens } : {}),
      ...(modelHint?.contextWindow !== undefined ? { contextWindow: modelHint.contextWindow } : {}),
      ...(modelHint?.thinkingEnabled !== undefined ? { thinkingEnabled: modelHint.thinkingEnabled } : {}),
      ...(modelHint?.thinkingEffort !== undefined ? { thinkingEffort: modelHint.thinkingEffort } : {}),
      ...(modelHint?.temperature !== undefined ? { temperature: modelHint.temperature } : {}),
      ...(modelHint?.topP !== undefined ? { topP: modelHint.topP } : {}),
      ...(modelHint?.topK !== undefined ? { topK: modelHint.topK } : {}),
      ...(modelHint?.frequencyPenalty !== undefined ? { frequencyPenalty: modelHint.frequencyPenalty } : {}),
      ...(modelHint?.repetitionPenalty !== undefined ? { repetitionPenalty: modelHint.repetitionPenalty } : {}),
      ...(context.accounting ? { accounting: context.accounting } : {}),
      // d8vq.2: carry the declared work spec (minus its
      // correlation, which rides the flat correlation params) so the
      // gateway-side LLMClient enforces the fail-closed accountability guard +
      // lane reconciliation for an autonomous completion.
      ...(options.workSpec ? { workSpec: toWorkSpecWireParams(options.workSpec) } : {}),
    };
    let result: LLMCompleteResult;
    try {
      try {
        result = await this.requestWithAbortSignal<LLMCompleteResult>(
          'llm.complete',
          requestParams,
          options.signal,
          'llm',
        );
      } catch (error) {
        if (!this.shouldResendInlineImages(error, referencedMessages.usedHintKeys)) throw error;
        this.inlineImageReferenceHints.invalidate(referencedMessages.usedHintKeys);
        log.warn('Gateway retained image unavailable; resending explicit inline bytes once', {
          requestId: correlation.requestId,
          imageCount: referencedMessages.usedHintKeys.length,
        });
        result = await this.requestWithAbortSignal<LLMCompleteResult>(
          'llm.complete',
          { ...requestParams, messages: context.messages },
          options.signal,
          'llm',
        );
      }
    } catch (error) {
      const preemptBlock = modelCallPreemptedErrorFromRpc(error);
      if (preemptBlock) throw preemptBlock;
      const icpCostBlock = icpConversationCostBreakerErrorFromRpc(error);
      if (icpCostBlock) throw icpCostBlock;
      const budgetBlock = modelBudgetBlockedEventFromError(error);
      if (budgetBlock) this.onModelBudgetBlocked?.(budgetBlock);
      throw error;
    }

    return {
      content: result.content,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(result.providerObservability ? { providerObservability: result.providerObservability } : {}),
      toolCalls: [],
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ...(result.usageDetails ? { usageDetails: result.usageDetails } : {}),
      stopReason: result.stopReason,
    };
  }

  // ── EmbeddingProviderPort interface ──

  get dims(): number {
    return this.embeddingDims;
  }

  getSerializedTransportStats(): GatewayRpcSerializedTransportStats {
    return this.transportRuntime.serializedTransportStats;
  }

  async embed(text: string, options: { signal?: AbortSignal } = {}): Promise<Float32Array> {
    const results = await this.embedBatch([text], options);
    return results[0];
  }

  async embedBatch(
    texts: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Float32Array[]> {
    const result = await this.requestWithAbortSignal<LLMEmbedResult>(
      'llm.embed',
      {
        texts,
        ...stripChargeAttribution(
          buildOutboundUsageCorrelation(this.companionId, getRequestContext()),
        ),
      },
      options.signal,
      // zn2iy: like llm.chat/llm.complete, mint a cancellationId and fire
      // llm.cancel on abort so the gateway's connection-scoped registry aborts
      // the upstream embedding provider instead of only releasing this local
      // JSON-RPC wrapper while the provider keeps running.
      'llm',
    );

    return result.embeddings.map(e => new Float32Array(e));
  }

  async getAvailableModels(): Promise<DiscoveredModel[]> {
    const result = await this.transportRuntime.request('llm.discover_models', {}) as LLMDiscoverModelsResult;
    return result.models;
  }

  async invalidateModelDiscoveryCache(): Promise<void> {
    await this.transportRuntime.request('llm.invalidate_model_discovery', {}) as LLMInvalidateModelDiscoveryResult;
  }

  // ── Discord methods ──

  async discordSend(channelId: string, content: string): Promise<void> {
    await this.transportRuntime.request('discord.send', {
      channelId,
      content,
    }) as DiscordSendResult;
  }

  async discordSendMedia(channelId: string, media: Attachment): Promise<void> {
    await this.transportRuntime.request('discord.sendMedia', {
      channelId,
      media,
    }) as DiscordSendMediaResult;
  }

  async discordTyping(channelId: string): Promise<void> {
    await this.transportRuntime.request('discord.typing', { channelId });
  }

  async discordSetAvailability(
    state: 'available' | 'idle' | 'do_not_disturb',
  ): Promise<'applied' | 'unsupported'> {
    const result = (await this.transportRuntime.request('discord.availability', { state })) as DiscordAvailabilityResult;
    return result.status;
  }

  /** Contact authority executes in the companion domain bound to this connection. */
  async executeContactLifecycle(
    request: ContactAuthorityLifecycleRequest,
  ): Promise<ContactLifecycleExecuteResult> {
    return parseContactAuthorityLifecycleResult(
      await this.transportRuntime.request('contact.lifecycle.execute', { request }),
    );
  }

  // ── Inter-companion channel lane (sprint 10, W6) ──

  /**
   * Send a message into a companion room (`companion-room:<placeId>`) or a
   * peer DM (`companion-dm:<a>:<b>`). The gateway verifies the sender against
   * this connection's bound companionId and routes fail-closed; recipients get
   * the message as an ordinary inbound channel turn (fatigue/trust apply).
   */
  async companionSend(
    channelId: string,
    content: string,
    authorName?: string,
    correlationOrReplyToMessageId?: IcpConversationCorrelation | string,
  ): Promise<CompanionMessageSendResult> {
    const correlation = typeof correlationOrReplyToMessageId === 'object'
      ? correlationOrReplyToMessageId
      : undefined;
    const replyToMessageId = typeof correlationOrReplyToMessageId === 'string'
      ? correlationOrReplyToMessageId
      : correlation?.messageId;
    const messageId = correlation ? deriveIcpTransportMessageId(correlation) : undefined;
    return await this.transportRuntime.request('companion.message.send', {
      channelId,
      content,
      ...(authorName ? { authorName } : {}),
      ...(correlation ? { correlation } : {}),
      ...(messageId ? { messageId } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as CompanionMessageSendResult;
  }

  /** Permit-bound first message through the same ordinary companion lane. */
  async companionSendInitiation(input: {
    channelId: string;
    content: string;
    authorName?: string;
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  }): Promise<CompanionMessageSendResult & { permitOutcome: 'consumed' | 'replayed' }> {
    const messageId = deriveIcpTransportMessageId(input.correlation);
    return await this.transportRuntime.request('companion.message.send', {
      channelId: input.channelId,
      content: input.content,
      ...(input.authorName ? { authorName: input.authorName } : {}),
      initiation: {
        permitId: input.permitId,
        conversationId: input.conversationId,
        recipientCompanionId: input.recipientCompanionId,
        correlation: input.correlation,
      },
      messageId,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as CompanionMessageSendResult & { permitOutcome: 'consumed' | 'replayed' };
  }

  /** Report a failed inbound companion turn without creating a reply turn. */
  async companionReportFailure(
    params: CompanionMessageFailureReportParams,
  ): Promise<CompanionMessageFailureReportResult> {
    return await this.transportRuntime.request('companion.message.report_failure', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as CompanionMessageFailureReportResult;
  }

  // ── ICP autonomy control plane (s10mc.6.2) ──

  async companionPublishAvailability(
    params: Omit<IcpAvailabilityPublishParams, 'companionId'>,
  ): Promise<IcpAvailabilityLease> {
    return await this.transportRuntime.request('companion.availability.publish', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpAvailabilityLease;
  }

  async companionClearAvailability(
    params: Omit<IcpAvailabilityClearParams, 'companionId'>,
  ): Promise<{ cleared: boolean }> {
    return await this.transportRuntime.request('companion.availability.clear', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as { cleared: boolean };
  }

  async refreshRuntimeAvailability(
    params: Omit<IcpRuntimeAvailabilityRefreshParams, 'companionId'>,
  ): Promise<IcpOwnAvailabilityResult> {
    return await this.transportRuntime.request('companion.availability.refresh_runtime', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpOwnAvailabilityResult;
  }

  async clearRuntimeAvailability(): Promise<IcpOwnAvailabilityResult> {
    const params: IcpRuntimeAvailabilityClearParams = {
      ...(this.companionId ? { companionId: this.companionId } : {}),
    };
    return await this.transportRuntime.request(
      'companion.availability.clear_runtime',
      params,
    ) as IcpOwnAvailabilityResult;
  }

  async companionReadPeerAvailability(
    params: Omit<IcpPeerAvailabilityReadParams, 'companionId'>,
  ): Promise<IcpPeerAvailabilityResult> {
    return await this.transportRuntime.request('companion.availability.read_peer', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpPeerAvailabilityResult;
  }

  async companionReadOwnAvailability(): Promise<IcpOwnAvailabilityResult> {
    const params: IcpOwnAvailabilityReadParams = {
      ...(this.companionId ? { companionId: this.companionId } : {}),
    };
    return await this.transportRuntime.request('companion.availability.read_self', params) as
      IcpOwnAvailabilityResult;
  }

  async companionInitiationPreflight(
    params: Omit<IcpInitiationPreflightParams, 'companionId'>,
  ): Promise<IcpInitiationGateDecision> {
    return await this.transportRuntime.request('companion.initiation.preflight', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpInitiationGateDecision;
  }

  async companionIssueInitiationPermit(
    params: Omit<IcpInitiationPermitIssueParams, 'companionId'>,
  ): Promise<IcpInitiationPermitIssueResult> {
    return await this.transportRuntime.request('companion.initiation.permit.issue', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpInitiationPermitIssueResult;
  }

  async companionPrepareInitiationHandoff(
    params: Omit<IcpInitiationHandoffPrepareParams, 'companionId'>,
  ): Promise<IcpInitiationHandoffPrepareResult> {
    return await this.transportRuntime.request('companion.initiation.permit.prepare_handoff', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpInitiationHandoffPrepareResult;
  }

  async companionConsumeInitiationPermit(
    params: Omit<IcpPermitConsumeParams, 'companionId'>,
  ): Promise<IcpPermitConsumeResult> {
    return await this.transportRuntime.request('companion.initiation.permit.consume', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpPermitConsumeResult;
  }

  async companionRevokeInitiationPermit(
    params: Omit<IcpPermitRevokeParams, 'companionId'>,
  ): Promise<IcpPermitRevokeResult> {
    return await this.transportRuntime.request('companion.initiation.permit.revoke', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpPermitRevokeResult;
  }

  /** Fence and revoke pending permits while linearizing a companion contact block. */
  async invalidatePendingInitiationPermitsForBlock(
    params: Omit<IcpPermitInvalidateSelfParams, 'companionId'> = { reasonCode: 'peer_blocked' },
  ): Promise<{ revokedCount: number }> {
    return await this.transportRuntime.request('companion.initiation.permit.invalidate_for_self', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as { revokedCount: number };
  }

  // ── Web fetch ──

  async webFetch(
    url: string,
    prompt?: string,
    lane: WebFetchLane = 'default',
  ): Promise<string> {
    const result = await this.transportRuntime.request('web.fetch', {
      url,
      prompt,
      lane,
    }) as WebFetchResult;
    return result.content;
  }

  async webSearch(
    query: string,
    maxResults?: number,
  ): Promise<WebSearchResult> {
    return await this.transportRuntime.request('web.search', {
      query,
      ...(typeof maxResults === 'number' && Number.isFinite(maxResults)
        ? { maxResults: Math.max(1, Math.floor(maxResults)) }
        : {}),
    }) as WebSearchResult;
  }

  /** Invoke the exact model-emitted MCP action authorized by the gateway. */
  async mcpExecute(
    params: Omit<McpExecuteParams, 'permit' | 'cancellationId'>,
    options: {
      toolCallId: string;
      signal?: AbortSignal;
    },
  ): Promise<McpExecuteResult> {
    const toolCallId = options.toolCallId.trim();
    const permit = this.mcpPermitByToolCallId.get(toolCallId);
    this.mcpPermitByToolCallId.delete(toolCallId);
    if (!permit) {
      throw new Error('Gateway did not authorize this MCP tool call');
    }
    const result = await this.requestWithAbortSignal<McpExecuteResult>(
      'mcp.execute',
      {
        ...params,
        permit,
      },
      options.signal,
      'mcp',
    );
    if (!isRecord(result) || result.action !== params.action) {
      throw new Error('Gateway returned an invalid MCP result');
    }
    return result;
  }

  /** Reversible operator lifecycle path; never connects to or invokes MCP. */
  async mcpRelease(serverId?: string): Promise<McpReleaseResult> {
    const result = await this.transportRuntime.request('mcp.release', {
      ...(serverId?.trim() ? { serverId: serverId.trim() } : {}),
    });
    if (!isRecord(result)
      || result.released !== true
      || (result.serverId !== undefined && typeof result.serverId !== 'string')) {
      throw new Error('Gateway returned an invalid MCP release result');
    }
    return {
      released: true,
      ...(result.serverId ? { serverId: result.serverId } : {}),
    };
  }

  async webFetchBinary(
    url: string,
    options: {
      lane?: WebFetchLane;
      maxBytes?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<WebFetchBinaryResult> {
    return await this.transportRuntime.request('web.fetch_binary', {
      url,
      lane: options.lane ?? 'default',
      ...(typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
        ? { maxBytes: Math.max(1, Math.floor(options.maxBytes)) }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    }) as WebFetchBinaryResult;
  }

  /**
   * htm9.8: screens one inbound image through the gateway's vision intake
   * screener BEFORE it may become a vision block in the main model context.
   * The gateway answers with the decision (withheld / promptBlock / notice);
   * flagged transcripts never cross this boundary.
   */
  async screenImageIntake(input: {
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
    originRef: string;
    originDetail?: string;
    subjectIndex?: number;
    canonicalContactId?: string;
    requestScope?: string;
  }): Promise<VisionIntakeImageScreenResult> {
    const result = await this.transportRuntime.request('intake.screen_image', {
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      ...(input.imageBase64 ? { imageBase64: input.imageBase64 } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      originRef: input.originRef,
      ...(input.originDetail ? { originDetail: input.originDetail } : {}),
      ...(typeof input.subjectIndex === 'number' ? { subjectIndex: input.subjectIndex } : {}),
      ...(input.canonicalContactId ? { canonicalContactId: input.canonicalContactId } : {}),
      ...(input.requestScope ? { requestScope: input.requestScope } : {}),
    }) as VisionIntakeImageScreenResult;
    if (
      input.imageBase64
      && input.mimeType
      && input.requestScope
      && result.retainedImage
    ) {
      this.inlineImageReferenceHints.record({
        imageBase64: input.imageBase64,
        mimeType: input.mimeType,
        requestScope: input.requestScope,
        descriptor: result.retainedImage,
      });
    }
    return result;
  }

  async webRequestBinary(
    url: string,
    options: {
      method?: string;
      lane?: WebFetchLane;
      maxBytes?: number;
      headers?: Record<string, string>;
      bodyBase64?: string;
    } = {},
  ): Promise<WebRequestBinaryResult> {
    return await this.transportRuntime.request('web.request_binary', {
      url,
      ...(options.method ? { method: options.method } : {}),
      lane: options.lane ?? 'default',
      ...(typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
        ? { maxBytes: Math.max(1, Math.floor(options.maxBytes)) }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.bodyBase64 ? { bodyBase64: options.bodyBase64 } : {}),
    }) as WebRequestBinaryResult;
  }

  async shellExec(
    command: string,
    args: string[] = [],
    options: {
      cwd?: string;
      timeoutMs?: number;
      maxOutputChars?: number;
      envVars?: string[];
    } = {},
  ): Promise<ShellExecResult> {
    return await this.transportRuntime.request('shell.exec', {
      command,
      args,
      ...options,
    }) as ShellExecResult;
  }

  async shardBackendRequest(
    params: ShardBackendRequestParams,
  ): Promise<ShardBackendRequestResult> {
    return await this.transportRuntime.request('shard.backend.request', params) as ShardBackendRequestResult;
  }

  async registerWorkload(
    input: ShardWorkloadRegistrationInput,
  ): Promise<AuthenticatedShardWorkloadHandle> {
    if (this.companionId && input.parentCompanionId !== this.companionId) {
      throw new Error(
        'Shard workload parent does not match the GatewayClient authenticated companion',
      );
    }
    const registrationId = randomUUID();
    let result: ShardWorkloadRegisterResult;
    try {
      result = await this.transportRuntime.request('shard.workload.register', {
        registrationId,
        shardId: input.shardId,
        ...(input.shardLabel ? { shardLabel: input.shardLabel } : {}),
        channelIds: [...input.channelIds],
        ownerVersion: input.capabilityGrant.ownerVersion,
        grantDigest: input.capabilityGrant.grantDigest,
      }) as ShardWorkloadRegisterResult;
    } catch (registrationError) {
      try {
        await this.confirmShardWorkloadEnded(registrationId);
      } catch (cleanupError) {
        this.transportRuntime.destroyConnection();
        throw new AggregateError(
          [registrationError, cleanupError],
          'Shard workload registration failed and gateway cleanup could not be confirmed',
        );
      }
      throw registrationError;
    }
    if (result.registrationId !== registrationId
      || typeof result.workloadGeneration !== 'string'
      || !result.workloadGeneration.trim()) {
      const invalidResultError = new Error(
        'Gateway returned an invalid shard workload registration result',
      );
      try {
        await this.confirmShardWorkloadEnded(registrationId);
      } catch (cleanupError) {
        this.transportRuntime.destroyConnection();
        throw new AggregateError(
          [invalidResultError, cleanupError],
          'Gateway returned an invalid shard workload registration result and cleanup failed',
        );
      }
      throw invalidResultError;
    }
    const handle = Object.freeze({
      kind: 'authenticated-shard-workload' as const,
    }) as AuthenticatedShardWorkloadHandle;
    this.shardWorkloadRegistrationIds.set(handle, registrationId);
    return handle;
  }

  async endWorkload(handle: AuthenticatedShardWorkloadHandle): Promise<void> {
    const registrationId = this.shardWorkloadRegistrationIds.get(handle);
    if (!registrationId) {
      throw new Error('Cannot end an unknown gateway shard workload handle');
    }
    try {
      await this.confirmShardWorkloadEnded(registrationId);
    } catch (error) {
      // Revocation is security-sensitive. If its acknowledgement is missing,
      // tear down the authenticated connection so the gateway releases every
      // connection-scoped lease rather than retaining ambiguous authority.
      this.transportRuntime.destroyConnection();
      throw error;
    }
    this.shardWorkloadRegistrationIds.delete(handle);
  }

  private async confirmShardWorkloadEnded(registrationId: string): Promise<void> {
    const result = await this.transportRuntime.request('shard.workload.end', {
      registrationId,
    }) as unknown;
    if (!isRecord(result) || typeof result.ended !== 'boolean') {
      throw new Error('Gateway returned an invalid shard workload revocation result');
    }
  }

  async vaultWrite(
    name: string,
    content: string,
    options: {
      folder?: string;
      mode?: 'create' | 'append' | 'prepend';
    } = {},
  ): Promise<VaultWriteResult> {
    return await this.transportRuntime.request('vault.write', {
      name,
      content,
      ...options,
    }) as VaultWriteResult;
  }

  async vaultRead(name: string): Promise<VaultReadResult> {
    return await this.transportRuntime.request('vault.read', { name }) as VaultReadResult;
  }

  async vaultSearch(query: string, limit?: number): Promise<VaultSearchResult> {
    return await this.transportRuntime.request('vault.search', {
      query,
      ...(typeof limit === 'number' && Number.isFinite(limit)
        ? { limit: Math.max(1, Math.floor(limit)) }
        : {}),
    }) as VaultSearchResult;
  }

  async vaultDaily(content?: string): Promise<VaultDailyResult> {
    return await this.transportRuntime.request('vault.daily', {
      ...(typeof content === 'string' ? { content } : {}),
    }) as VaultDailyResult;
  }

  async ['vault.write'](
    name: string,
    content: string,
    options?: {
      folder?: string;
      mode?: 'create' | 'append' | 'prepend';
    },
  ): Promise<VaultWriteResult> {
    return await this.vaultWrite(name, content, options);
  }

  async ['vault.read'](name: string): Promise<VaultReadResult> {
    return await this.vaultRead(name);
  }

  async ['vault.search'](query: string, limit?: number): Promise<VaultSearchResult> {
    return await this.vaultSearch(query, limit);
  }

  async ['vault.daily'](content?: string): Promise<VaultDailyResult> {
    return await this.vaultDaily(content);
  }

  // ── Filesystem ──

  async fsReadDetailed(
    path: string,
    options?: { maxBytes?: number; offsetBytes?: number },
  ): Promise<FsReadResult> {
    return await this.transportRuntime.request('fs.read', {
      path,
      ...(typeof options?.maxBytes === 'number' ? { maxBytes: options.maxBytes } : {}),
      ...(typeof options?.offsetBytes === 'number' ? { offsetBytes: options.offsetBytes } : {}),
    }) as FsReadResult;
  }

  async fsRead(path: string, options?: { maxBytes?: number; offsetBytes?: number }): Promise<string> {
    const result = await this.fsReadDetailed(path, options);
    return result.content;
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.transportRuntime.request('fs.write', { path, content }) as FsWriteResult;
  }

  async fsList(
    glob?: string,
    maxEntries = 200,
    options?: { path?: string; maxScannedEntries?: number },
  ): Promise<FsListResult> {
    return await this.transportRuntime.request('fs.list', {
      ...(typeof options?.path === 'string' ? { path: options.path } : {}),
      ...(typeof glob === 'string' ? { glob } : {}),
      ...(typeof options?.maxScannedEntries === 'number' ? { maxScannedEntries: options.maxScannedEntries } : {}),
      maxEntries,
    }) as FsListResult;
  }

  async fsSearch(params: FsSearchParams): Promise<FsSearchResult> {
    return await this.transportRuntime.request('fs.search', params) as FsSearchResult;
  }

  async fsEdit(params: FsEditParams): Promise<FsEditResult> {
    return await this.transportRuntime.request('fs.edit', params) as FsEditResult;
  }

  // ── Git operations ──

  async gitStatus(): Promise<GitStatusResult> {
    return await this.transportRuntime.request('git.status', {}) as GitStatusResult;
  }

  async gitDiff(opts: GitDiffParams = {}): Promise<GitDiffResult> {
    return await this.transportRuntime.request('git.diff', opts) as GitDiffResult;
  }

  async gitCreateBranch(name: string, startPoint?: string): Promise<string> {
    const result = await this.transportRuntime.request('git.create_branch', {
      name,
      startPoint,
    }) as GitCreateBranchResult;
    return result.name;
  }

  async gitApplyPatch(filePath: string, content: string): Promise<void> {
    await this.transportRuntime.request('git.apply_patch', { filePath, content }) as GitApplyPatchResult;
  }

  async gitCommit(message: string, intent: string, scope?: string): Promise<GitCommitResult> {
    return await this.transportRuntime.request('git.commit', { message, intent, scope }) as GitCommitResult;
  }

  async gitOpenPR(title: string, body: string, base?: string): Promise<string> {
    const result = await this.transportRuntime.request('git.open_pr', { title, body, base }) as GitOpenPRResult;
    return result.url;
  }

  // ── Beads issue management ──

  async beadsReady(params: BeadsReadyParams = {}): Promise<BeadsActionResult> {
    return await this.transportRuntime.request('beads.ready', params) as BeadsActionResult;
  }

  async beadsShow(params: BeadsShowParams): Promise<BeadsActionResult> {
    return await this.transportRuntime.request('beads.show', params) as BeadsActionResult;
  }

  async beadsCreate(params: BeadsCreateParams): Promise<BeadsActionResult> {
    return await this.transportRuntime.request('beads.create', params) as BeadsActionResult;
  }

  async beadsUpdate(params: BeadsUpdateParams): Promise<BeadsActionResult> {
    return await this.transportRuntime.request('beads.update', params) as BeadsActionResult;
  }

  async beadsClose(params: BeadsCloseParams): Promise<BeadsActionResult> {
    return await this.transportRuntime.request('beads.close', params) as BeadsActionResult;
  }

  async beadsSync(params: BeadsSyncParams = {}): Promise<BeadsActionResult> {
    return await this.transportRuntime.request('beads.sync', params) as BeadsActionResult;
  }

  // ── Home Assistant world control (Sprint 10, bead .8 gateway method) ──

  async homeAssistantGetStates(
    params: HomeAssistantGetStatesParams = {},
  ): Promise<HomeAssistantGetStatesResult> {
    return await this.transportRuntime.request('home_assistant.get_states', params) as HomeAssistantGetStatesResult;
  }

  async homeAssistantCallService(
    params: HomeAssistantCallServiceParams,
  ): Promise<HomeAssistantCallServiceResult> {
    return await this.transportRuntime.request('home_assistant.call_service', params) as HomeAssistantCallServiceResult;
  }

  async imageCreate(params: ImageCreateParams): Promise<ImageGenerationRpcResult> {
    return await this.transportRuntime.request('image.create', {
      ...params,
      ...buildOutboundUsageCorrelation(this.companionId, getRequestContext()),
    }) as ImageGenerationRpcResult;
  }

  async imageEdit(params: ImageEditParams): Promise<ImageGenerationRpcResult> {
    return await this.transportRuntime.request('image.edit', {
      ...params,
      ...buildOutboundUsageCorrelation(this.companionId, getRequestContext()),
    }) as ImageGenerationRpcResult;
  }

  async notifyNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    return await this.transportRuntime.request('notify.ntfy', params) as NotifyNtfyResult;
  }

  async notifyOperator(params: NotifyNtfyParams): Promise<OperatorAlertResult> {
    return await this.transportRuntime.request('notify.operator', params) as OperatorAlertResult;
  }

  async clarifyDeliver(params: ClarifyDeliverParams): Promise<ClarifyDeliverResult> {
    return await this.transportRuntime.request('clarify.deliver', params) as ClarifyDeliverResult;
  }

  async runtimeHealth(): Promise<RuntimeHealthResult> {
    return await this.transportRuntime.request('runtime.health', {}) as RuntimeHealthResult;
  }

  async writeSystemData(request: SystemDataWriteRequest): Promise<SystemDataWriteResult> {
    const result = await this.transportRuntime.request('system.data.write', request) as unknown;
    return parseSystemDataWriteResult(request, result);
  }

  async kubeSelfManagement(
    params: KubeSelfManagementRequest,
  ): Promise<KubeSelfManagementResponse> {
    return await this.transportRuntime.request(
      'kube.self_management',
      params,
    ) as KubeSelfManagementResponse;
  }

  async getCredentialPresence(): Promise<GatewayCredentialPresenceResult> {
    return await this.transportRuntime.request(
      'runtime.credential_presence',
      {},
    ) as GatewayCredentialPresenceResult;
  }

  async listConfirmationQueue(): Promise<ConfirmationListResult> {
    return await this.transportRuntime.request('confirmation.list', {}) as ConfirmationListResult;
  }

  async resolveConfirmationQueue(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult> {
    return await this.transportRuntime.request('confirmation.resolve', params) as ConfirmationResolveResult;
  }

  async requestMemoryDeletionApproval(
    request: MemoryDeletionApprovalRequest,
  ): Promise<MemoryDeletionApprovalResult> {
    const result = await this.transportRuntime.request('memory.deletion.propose', request);
    if (!isRecord(result)) throw new Error('Gateway returned an invalid memory deletion approval result');
    assertNoUnknownKeys(
      result,
      ['status', 'proposalId', 'approvalId', 'expiresAt', 'deleteId'],
      'memory.deletion.propose result',
    );
    if (result.proposalId !== request.proposalId) {
      throw new Error('Gateway returned a malformed memory deletion approval result');
    }
    if (result.status === 'already_approved' || result.status === 'already_denied') {
      if ((result.approvalId !== undefined
          && (typeof result.approvalId !== 'string' || !result.approvalId.trim()))
        || (result.deleteId !== undefined
          && (typeof result.deleteId !== 'string' || !result.deleteId.trim()))
        || (result.status === 'already_approved'
          && (typeof result.deleteId !== 'string' || !result.deleteId.trim()))
        || (result.status === 'already_denied' && result.deleteId !== undefined)) {
        throw new Error('Gateway returned a malformed terminal memory deletion result');
      }
      return {
        status: result.status,
        proposalId: request.proposalId,
        ...(typeof result.approvalId === 'string' ? { approvalId: result.approvalId.trim() } : {}),
        ...(typeof result.deleteId === 'string' ? { deleteId: result.deleteId.trim() } : {}),
      };
    }
    if (result.status !== 'approval_required'
      || typeof result.approvalId !== 'string'
      || !result.approvalId.trim()
      || !Number.isSafeInteger(result.expiresAt)) {
      throw new Error('Gateway returned a malformed memory deletion approval result');
    }
    return {
      status: 'approval_required',
      proposalId: request.proposalId,
      approvalId: result.approvalId.trim(),
      expiresAt: result.expiresAt as number,
    };
  }

  async sessionHmacSign(entry: JournalEntry, previousHmac: string | null): Promise<JournalEntry> {
    const result = await this.transportRuntime.request('session.hmac.sign', {
      entry,
      previousHmac,
    }) as SessionHmacSignResult;
    return result.entry;
  }

  async sessionHmacVerify(
    entry: JournalEntry,
    previousHmac: string | null,
  ): Promise<JournalIntegrityVerificationResult> {
    return await this.transportRuntime.request('session.hmac.verify', {
      entry,
      previousHmac,
    }) as SessionHmacVerifyResult;
  }

  createSessionIntegrityProvider(): SessionIntegrityProvider {
    return this.sessionIntegrityRuntime.createProvider(
      <T>(method: 'session.hmac.sign' | 'session.hmac.verify', params: Record<string, unknown>) => (
        this.requestSessionIntegritySync<T>(method, params)
      ),
    );
  }

  private requestSessionIntegritySync<T>(
    method: 'session.hmac.sign' | 'session.hmac.verify',
    params: Record<string, unknown>,
  ): T {
    return this.sessionIntegrityRuntime.requestSync<T>(method, params);
  }

  // ── Notification handlers ──

  onDiscordMessage(handler: (message: SubstrateMessage) => void): () => void {
    return this.onNotification('discord.message', (params) => {
      const notification = params as DiscordMessageNotification;
      handler(notification.message);
    });
  }

  /** Coarse queue invalidation relayed from the gateway approval boundary. */
  onGardenQueueChanged(handler: (queue: GardenQueueName) => void): () => void {
    return this.onNotification('garden.queue.changed', (params) => {
      if (!isRecord(params) || !isGardenQueueName(params.queue)) {
        log.warn('Rejected invalid garden.queue.changed notification');
        return;
      }
      handler(params.queue);
    });
  }

  /** Inbound peer-companion messages (gateway `companion.message` lane, W6). */
  onCompanionMessage(handler: (message: SubstrateMessage) => void | Promise<void>): () => void {
    return this.onNotification('companion.message', (params) => {
      const notification = params as CompanionMessageNotification;
      return handler(notification.message);
    });
  }

  /** Observe-only negative acknowledgement for a companion message we sent. */
  onCompanionDeliveryFailure(
    handler: (notification: CompanionMessageDeliveryFailureNotification) => void,
  ): () => void {
    return this.onNotification('companion.message.delivery_failure', (params) => {
      handler(params as CompanionMessageDeliveryFailureNotification);
    });
  }

  onDisconnect(handler: (event: GatewayConnectionCloseEvent) => void): () => void {
    this.connectionCloseHandlers.add(handler);
    return () => {
      this.connectionCloseHandlers.delete(handler);
    };
  }

  private async requestWithAbortSignal<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    remoteCancellation?: 'llm' | 'mcp',
  ): Promise<T> {
    return await this.transportRuntime.requestWithAbortSignal<T>(
      method,
      params,
      signal,
      remoteCancellation,
      this.companionId,
    );
  }

  private onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): () => void {
    return this.transportRuntime.onNotification(method, handler);
  }

  /** Register a handler for reverse RPC calls from gateway (e.g. voice messages) */
  onHandleMessage(handler: MessageHandler): void {
    this.reverseRpcRuntime.onHandleMessage(handler);
  }

  onApiChatCompletion(handler: (params: ApiChatCompletionRpcParams) => Promise<ApiChatCompletionRpcResult>): void {
    this.reverseRpcRuntime.onApiChatCompletion(handler);
  }

  onApiChatCancel(handler: (params: ApiChatCompletionCancelRpcParams) => Promise<ApiChatCompletionCancelRpcResult>): void {
    this.reverseRpcRuntime.onApiChatCancel(handler);
  }

  onCompanionUiShardAction(handler: (params: ApiCompanionUiShardActionRpcParams) => Promise<ApiCompanionUiShardActionRpcResult>): void {
    this.reverseRpcRuntime.onCompanionUiShardAction(handler);
  }

  onShardOwner(handler: (params: ApiShardOwnerRpcParams) => Promise<ApiShardOwnerRpcResult>): void {
    this.reverseRpcRuntime.onShardOwner(handler);
  }

  onApiTelemetryIngest(handler: (params: ApiTelemetryIngestRpcParams) => Promise<ApiTelemetryIngestRpcResult>): void {
    this.reverseRpcRuntime.onApiTelemetryIngest(handler);
  }

  onApiHealth(handler: () => Promise<ApiHealthRpcResult>): void {
    this.reverseRpcRuntime.onApiHealth(handler);
  }

  onSatelliteResponseEligibility(handler: (params: SatelliteResponseEligibilityRpcParams) => Promise<SatelliteResponseEligibilityRpcResult>): void {
    this.reverseRpcRuntime.onSatelliteResponseEligibility(handler);
  }

  onTurnPerformance(handler: (event: TurnPerformanceEvent) => Promise<void>): void {
    this.reverseRpcRuntime.onTurnPerformance(handler);
  }

  onContactAuthoritySnapshot(handler: (params: ContactAuthoritySnapshotRequest) => Promise<VerifiedDiscordContactAuthoritySnapshot | undefined>): void {
    this.reverseRpcRuntime.onContactAuthoritySnapshot(handler);
  }

  onMemoryDeletionPartnerAlerted(handler: (params: MemoryDeletionPartnerAlertedParams) => Promise<MemoryDeletionPartnerAlertedResult>): void {
    this.reverseRpcRuntime.onMemoryDeletionPartnerAlerted(handler);
  }

  onMemoryDeletionProposalSnapshot(handler: (params: MemoryDeletionProposalSnapshotParams) => Promise<MemoryDeletionProposalSnapshotResult>): void {
    this.reverseRpcRuntime.onMemoryDeletionProposalSnapshot(handler);
  }

  onMemoryDeletionResolve(handler: (params: MemoryDeletionResolveParams) => Promise<MemoryDeletionResolveResult>): void {
    this.reverseRpcRuntime.onMemoryDeletionResolve(handler);
  }

  onIcpLocalPolicyAuthority(authority: IcpLocalPolicyAuthorityPort): void {
    this.reverseRpcRuntime.onIcpLocalPolicyAuthority(authority);
  }

  markIcpLocalPolicyAuthorityReady(): void {
    this.reverseRpcRuntime.markIcpLocalPolicyAuthorityReady();
  }

  notifyApiStreamDelta(requestId: string, text: string): void {
    this.reverseRpcRuntime.notifyApiStreamDelta(requestId, text);
  }

  publishCompanionEvent(params: CompanionRelayPublishParams): void {
    this.reverseRpcRuntime.publishCompanionEvent(params);
  }

  private handleChunkNotification(params: unknown): void {
    const chunk = params as LLMChunkNotification;
    const handler = chunk.requestId
      ? this.chunkHandlers.get(chunk.requestId)
      : undefined;

    if (handler) {
      handler(chunk.text);
      return;
    }

  }

  private handleFirstOutputNotification(params: unknown): void {
    if (!isRecord(params)) {
      log.warn('Ignoring malformed llm.first_output notification');
      return;
    }
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    const kind = params.kind;
    const monotonicAtMs = params.monotonicAtMs;
    const timestampMs = params.timestampMs;
    if (!requestId
      || requestId !== requestId.trim()
      || (kind !== 'text' && kind !== 'thinking' && kind !== 'tool')
      || typeof monotonicAtMs !== 'number'
      || !Number.isFinite(monotonicAtMs)
      || monotonicAtMs < 0
      || typeof timestampMs !== 'number'
      || !Number.isFinite(timestampMs)
      || timestampMs < 0) {
      log.warn('Ignoring malformed llm.first_output notification', { requestId });
      return;
    }
    const handler = this.firstOutputHandlers.get(requestId);
    if (!handler) return;
    this.firstOutputHandlers.delete(requestId);
    handler({ kind, monotonicAtMs, timestampMs });
  }

  private emitConnectionClose(event: GatewayConnectionCloseEvent): void {
    if (this.isDestroying || this.closedNotified) {
      return;
    }
    this.closedNotified = true;
    this.reverseRpcRuntime.cleanupIcpLocalPolicyHolds();
    this.transportRuntime.handleConnectionClosed();
    this.transportRuntime.rejectAllPendingRequests(
      event.source === 'error' && event.error
        ? `Gateway connection error: ${event.error.message}`
        : 'Gateway connection closed',
    );
    this.inlineImageReferenceHints.clear();
    for (const handler of this.connectionCloseHandlers) {
      try {
        handler(event);
      } catch (error) {
        log.error('Disconnect handler error', { error: toErrorMessage(error) });
      }
    }
  }

  // ── Lifecycle ──

  destroy(): void {
    if (this.isDestroying) return;
    this.isDestroying = true;
    this.reverseRpcRuntime.cleanupIcpLocalPolicyHolds();
    this.transportRuntime.handleConnectionClosed();
    this.transportRuntime.rejectAllPendingRequests('Gateway client destroyed');
    this.sessionIntegrityRuntime.destroy();
    this.inlineImageReferenceHints.clear();
    this.reverseRpcRuntime.clearVoiceStreams();
    this.connectionCloseHandlers.clear();
    this.transportRuntime.destroy();
  }

  private shouldResendInlineImages(error: unknown, usedHintKeys: readonly string[]): boolean {
    return usedHintKeys.length > 0
      && error instanceof JSONRPCErrorException
      && error.code === GatewayErrors.INLINE_IMAGE_RETENTION_MISS;
  }
}

function normalizeCorrelationText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProviderQualifiedModel(value: string): { provider: string; model: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function mergeGatewayModelHints(
  contextHint: LLMModelHint | undefined,
  optionHint: LLMModelHint | undefined,
): LLMModelHint | undefined {
  const normalizedContext = normalizeModelHint(contextHint, OPTIONAL_MODEL_HINT_NORMALIZATION);
  const normalizedOption = normalizeModelHint(optionHint, OPTIONAL_MODEL_HINT_NORMALIZATION);
  if (!normalizedContext && !normalizedOption) return undefined;
  return {
    ...(normalizedContext ?? {}),
    ...(normalizedOption ?? {}),
  };
}
