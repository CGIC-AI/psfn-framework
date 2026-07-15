// ── Gateway Client ──
// Agent-side typed RPC wrapper. Implements LLMProviderPort and EmbeddingProviderPort
// so it can be used as a drop-in replacement for direct clients.

import { JSONRPCServer, JSONRPCClient, JSONRPCServerAndClient, JSONRPCErrorException } from 'json-rpc-2.0';
import { Worker } from 'node:worker_threads';
import type { LLMProviderPort, EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { CHANNEL_TYPES } from '../../shared/contracts/runtime.js';
import type { AgentResponse, Attachment, CompletionPurpose, CorrelationMetadata, LLMContext, LLMModelHint, LLMResponse, ModelBudgetBlockedEvent, StreamCallbacks, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  GatewayRpcConnection,
  GatewayRpcEndpoint,
  GatewayRpcSerializedTransportStats,
} from './transport.js';
import {
  createSocketClient,
  createWebSocketRpcClient,
} from './transport.js';
import { createComponentLogger } from '../../shared/logger.js';
import { getActiveCanaryToken, CANARY_CARRIER_PARAM_KEY } from '../../core/cogsec/canary/canary-token.js';
import { isEgressCanaryMethod } from '../../core/cogsec/canary/egress-scan.js';
import { BoundedQueue, QueueOverflowError, type QueueOverflowPolicy } from './backpressure.js';
import { registerReverseGatewayMethods } from './reverse-methods.js';
const log = createComponentLogger('GatewayClient');

/**
 * htm9.18: attach the live session canary token to outbound egress requests so
 * the gateway egress guard can scan for a prompt leak. Only egress methods and
 * only when a turn-scoped canary context is active; the raw token rides in a
 * reserved param the gateway strips before the handler and never logs. LLM and
 * other non-egress calls are untouched (the canary lives in the prompt there
 * legitimately).
 */
function attachCanaryToEgressRequest<T>(request: T): T {
  const rpc = request as unknown as { method?: unknown; params?: unknown };
  if (typeof rpc.method !== 'string' || !isEgressCanaryMethod(rpc.method)) {
    return request;
  }
  const token = getActiveCanaryToken();
  if (!token) return request;
  if (!rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params)) {
    return request;
  }
  (rpc.params as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY] = token;
  return request;
}
import type { JournalIntegrityVerificationResult } from '../../persistence/journals/journal-utils.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiHealthRpcResult,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
} from '../../channels/api/types.js';
import type { SessionIntegrityProvider } from '../../persistence/sessions/store.js';
import type { VisionIntakeImageScreenResult } from './intake/vision-screener.js';
import type { JournalEntry } from '../../core/session/types.js';
import type { ConfirmationResolveResult } from '../../system/capabilities/confirmation-queue.js';
import type { CompanionRelayPublishParams } from '../../channels/backplane/companion-relay/relay.js';
import { isGardenQueueName, type GardenQueueName } from '../../shared/event-bus.js';
import { isRecord } from '../../shared/utils/types.js';
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
  WebFetchResult,
  WebFetchBinaryResult,
  WebRequestBinaryResult,
  WebSearchResult,
  WebFetchLane,
  ShellExecResult,
  ShardBackendRequestParams,
  ShardBackendRequestResult,
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
  VoiceHandleMessageResult,
  NotifyNtfyParams,
  NotifyNtfyResult,
  ConfirmationListResult,
  ConfirmationResolveParams,
  RuntimeHealthResult,
  GatewayCredentialPresenceResult,
  RpcSubstrateMessage,
  VoiceStreamChunkParams,
  VoiceStreamEndParams,
  VoiceStreamCancelParams,
  VoiceStreamAckResult,
  VoiceStreamEndResult,
  VoiceStreamCancelResult,
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
} from './protocol.js';
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
import {
  SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES,
  SESSION_INTEGRITY_VERIFY_CACHE_MAX_ENTRIES,
  SESSION_INTEGRITY_WORKER_SOURCE,
} from './session-integrity-worker-source.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { GatewayInlineImageReferenceHints } from './inline-image-reference-hints.js';
import { parseModelBudgetBlockedEvent } from '../../shared/contracts/model-budget.js';
import { parseIcpConversationCostBreakerEvent } from '../../shared/contracts/icp-conversation-cost.js';
import { IcpConversationCostBreakerError } from '../../primitives/llm/icp-conversation-cost-breaker.js';
import { resolveCorrelationMetadata } from '../../primitives/llm/correlation.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { getRunChargeSnapshot } from '../../shared/telemetry/run-charge.js';
import {
  createCompanionId,
  type CompanionId,
  type OptionalCompanionRoutingBinding,
} from '../../shared/routing/companion-id.js';
import { parseGatewayRoutingEnvelope } from '../../shared/routing/envelope.js';

const DEFAULT_VOICE_STREAM_QUEUE_SIZE = 32;
const DEFAULT_VOICE_STREAM_OVERFLOW_POLICY: QueueOverflowPolicy = 'error';
const DEFAULT_SESSION_INTEGRITY_RPC_TIMEOUT_MS = 3_000;
const DEFAULT_GATEWAY_KEEPALIVE_INTERVAL_MS = 30_000;

function assertRpcSubstrateMessage(
  value: unknown,
  options: { fieldName: string; allowEmptyContent?: boolean },
): asserts value is RpcSubstrateMessage {
  const { fieldName, allowEmptyContent = false } = options;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  for (const field of ['id', 'channelId', 'authorId', 'authorName'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`${fieldName}.${field} must be a non-empty string`);
    }
  }
  if (typeof value.content !== 'string' || (!allowEmptyContent && !value.content.trim())) {
    throw new Error(
      `${fieldName}.content must be ${allowEmptyContent ? 'a string' : 'a non-empty string'}`,
    );
  }
  if (typeof value.channelType !== 'string'
    || !CHANNEL_TYPES.some(channelType => channelType === value.channelType)) {
    throw new Error(`${fieldName}.channelType is not supported`);
  }
  const timestamp = value.timestamp;
  if (!(timestamp instanceof Date) && typeof timestamp !== 'string') {
    throw new Error(`${fieldName}.timestamp must be a Date or ISO string`);
  }
  const timestampMs = timestamp instanceof Date
    ? timestamp.getTime()
    : Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`${fieldName}.timestamp must be valid`);
  }
  if (!isRecord(value.routing)) {
    throw new Error(`${fieldName}.routing must be an object`);
  }
}

export interface GatewayClientOptions extends OptionalCompanionRoutingBinding {
  voiceStreamQueueSize?: number;
  voiceStreamOverflowPolicy?: QueueOverflowPolicy;
  sessionIntegritySocketPath?: string;
  sessionIntegrityEndpoint?: GatewayRpcEndpoint;
  sessionIntegrityRpcTimeoutMs?: number;
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

interface VoiceStreamState {
  correlationId: string;
  streamId: string;
  baseMessage: SubstrateMessage;
  expectedSequence: number;
  chunkQueue: BoundedQueue<string>;
  chunks: string[];
  droppedChunks: number;
  cancelled: boolean;
}

export interface GatewayConnectionCloseEvent {
  source: 'close' | 'error';
  error?: Error;
}

export class GatewayClient implements LLMProviderPort, EmbeddingProviderPort, GatewayModelDiscoveryTransport {
  private rpcInstance: JSONRPCServerAndClient;
  private conn: GatewayRpcConnection;
  private embeddingDims: number;
  private notificationHandlers = new Map<
    string,
    Array<(params: unknown) => void | Promise<void>>
  >();
  private connectionCloseHandlers = new Set<(event: GatewayConnectionCloseEvent) => void>();
  private chunkHandlers = new Map<string, (text: string) => void>();
  private requestCounter = 0;
  private reverseMethodsRegistered = false;
  private handleMessageHandler: ((message: SubstrateMessage) => Promise<AgentResponse>) | null = null;
  private apiChatCompletionHandler: ((params: ApiChatCompletionRpcParams) => Promise<ApiChatCompletionRpcResult>) | null = null;
  private apiChatCancelHandler: ((params: ApiChatCompletionCancelRpcParams) => Promise<ApiChatCompletionCancelRpcResult>) | null = null;
  private apiTelemetryIngestHandler: ((params: ApiTelemetryIngestRpcParams) => Promise<ApiTelemetryIngestRpcResult>) | null = null;
  private apiHealthHandler: (() => Promise<ApiHealthRpcResult>) | null = null;
  private voiceStreams = new Map<string, VoiceStreamState>();
  private readonly voiceStreamQueueSize: number;
  private readonly voiceStreamOverflowPolicy: QueueOverflowPolicy;
  private readonly sessionIntegrityEndpoint: GatewayRpcEndpoint | null;
  private readonly sessionIntegrityRpcTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private sessionIntegrityWorker: Worker | null = null;
  private sessionIntegrityRequestCounter = 0;
  private sessionIntegrityVerifyCache = new Map<string, JournalIntegrityVerificationResult>();
  private closedNotified = false;
  private isDestroying = false;
  private readonly companionId?: CompanionId;
  private readonly companionAuthToken?: string;
  private readonly sessionIntegrityAuthToken?: string;
  private readonly inlineImageReferenceHints = new GatewayInlineImageReferenceHints();
  private readonly onModelBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;

  constructor(conn: GatewayRpcConnection, embeddingDims: number, options: GatewayClientOptions = {}) {
    this.conn = conn;
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
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_GATEWAY_KEEPALIVE_INTERVAL_MS;
    this.onModelBudgetBlocked = options.onModelBudgetBlocked;

    if (!Number.isInteger(this.voiceStreamQueueSize) || this.voiceStreamQueueSize <= 0) {
      throw new Error(`voiceStreamQueueSize must be a positive integer, got ${this.voiceStreamQueueSize}`);
    }
    if (!Number.isInteger(this.sessionIntegrityRpcTimeoutMs) || this.sessionIntegrityRpcTimeoutMs <= 0) {
      throw new Error(
        `sessionIntegrityRpcTimeoutMs must be a positive integer, got ${this.sessionIntegrityRpcTimeoutMs}`,
      );
    }
    if (!Number.isInteger(this.keepaliveIntervalMs) || this.keepaliveIntervalMs <= 0) {
      throw new Error(`keepaliveIntervalMs must be a positive integer, got ${this.keepaliveIntervalMs}`);
    }

    // Create bidirectional RPC instance (client sends requests to gateway,
    // server handles incoming requests from gateway like discord.handleMessage)
    this.rpcInstance = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => { this.conn.send(attachCanaryToEgressRequest(request)); }),
    );

    // Route incoming messages
    this.conn.onMessage((message: unknown) => {
      const msg = message as Record<string, unknown>;

      // Intercept llm.chunk notifications — these use our custom routing
      if ('method' in msg && !('id' in msg)) {
        const method = msg.method as string;
        if (method === 'llm.chunk') {
          this.handleChunkNotification(msg.params);
          return;
        }
        // Other notifications (discord.message) use our handler system
        this.handleNotification(method, msg.params);
        return;
      }

      // Everything else: responses to our requests + incoming RPC requests from gateway
      // json-rpc-2.0 receiveAndSend() payload param is typed as `any`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.rpcInstance.receiveAndSend(msg as any);
    });

    this.conn.on('close', () => {
      this.emitConnectionClose({ source: 'close' });
    });
    this.conn.on('error', (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.emitConnectionClose({ source: 'error', error: normalized });
    });

    this.startKeepalive();
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
    await this.rpcInstance.request('gateway.client.identify', {
      role: 'agent',
      ...(this.companionId ? { companionId: this.companionId } : {}),
      ...(this.companionAuthToken ? { authToken: this.companionAuthToken } : {}),
    });
  }

  // ── LLMProviderPort interface ──

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    // Generate a unique per-request ID for routing streaming chunks
    const requestId = context.correlation?.requestId?.trim()
      || context.correlation?.icpCorrelation?.requestId.trim()
      || `req-${++this.requestCounter}`;
    const callType = context.correlation?.callType
      ?? context.correlation?.originType
      ?? 'chat';
    const purpose = context.correlation?.purpose
      ?? context.correlation?.originStage
      ?? 'chat';
    const usageCorrelation = buildOutboundUsageCorrelation(this.companionId, {
      ...(context.correlation ?? {}),
      requestId,
      callType,
      purpose,
    });
    const modelHint = normalizeGatewayModelHint(context.modelHint);
    const hintedModel = normalizeCorrelationText(modelHint?.model);
    const hintedProvider = normalizeCorrelationText(modelHint?.provider);
    const qualifiedHint = hintedModel ? parseProviderQualifiedModel(hintedModel) : null;
    const model = qualifiedHint?.model ?? hintedModel ?? '';
    const provider = (hintedProvider ?? qualifiedHint?.provider ?? '').trim().toLowerCase();

    // Register chunk handler before sending the RPC so no chunks are missed
    if (callbacks?.onText) {
      this.chunkHandlers.set(requestId, callbacks.onText);
    }

    try {
      const referencedMessages = this.inlineImageReferenceHints.referenceMessages(
        context.messages,
        context.correlation?.turnId,
      );
      const requestParams = {
        model,  // gateway resolves roster defaults when hint fields are unset
        provider,
        ...usageCorrelation,
        ...(modelHint?.pin !== undefined ? { pin: modelHint.pin } : {}),
        messages: referencedMessages.messages,
        systemPrompt: context.systemPrompt,
        ...(context.promptCacheBoundaries ? { promptCacheBoundaries: context.promptCacheBoundaries } : {}),
        stream: !!callbacks?.onText,
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
        ...(context.accounting ? { accounting: context.accounting } : {}),
      };
      let result: LLMChatResult;
      try {
        result = await this.rpcInstance.request('llm.chat', requestParams) as LLMChatResult;
      } catch (error) {
        if (!this.shouldResendInlineImages(error, referencedMessages.usedHintKeys)) throw error;
        this.inlineImageReferenceHints.invalidate(referencedMessages.usedHintKeys);
        log.warn('Gateway retained image unavailable; resending explicit inline bytes once', {
          requestId,
          imageCount: referencedMessages.usedHintKeys.length,
        });
        result = await this.rpcInstance.request('llm.chat', {
          ...requestParams,
          messages: context.messages,
        }) as LLMChatResult;
      }

      const response: LLMResponse = {
        content: result.content,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.providerObservability ? { providerObservability: result.providerObservability } : {}),
        toolCalls: result.toolCalls,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ...(result.usageDetails ? { usageDetails: result.usageDetails } : {}),
        stopReason: result.stopReason,
      };

      callbacks?.onDone?.(response);
      return response;
    } catch (error) {
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
      this.chunkHandlers.delete(requestId);
    }
  }

  async complete(
    context: LLMContext,
    purpose: CompletionPurpose,
    options: {
      signal?: AbortSignal;
      modelHint?: LLMModelHint;
      correlation?: Partial<CorrelationMetadata>;
    } = {},
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

    const referencedMessages = this.inlineImageReferenceHints.referenceMessages(
      context.messages,
      correlation.turnId,
    );
    const requestParams = {
      model,
      provider,
      ...usageCorrelation,
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
    };
    let result: LLMCompleteResult;
    try {
      try {
        result = await this.requestWithAbortSignal<LLMCompleteResult>(
          'llm.complete',
          requestParams,
          options.signal,
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
        );
      }
    } catch (error) {
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
    return this.conn.serializedTransportStats;
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
        ...buildOutboundUsageCorrelation(this.companionId, getRequestContext()),
      },
      options.signal,
    );

    return result.embeddings.map(e => new Float32Array(e));
  }

  async getAvailableModels(): Promise<DiscoveredModel[]> {
    const result = await this.rpcInstance.request('llm.discover_models', {}) as LLMDiscoverModelsResult;
    return result.models;
  }

  async invalidateModelDiscoveryCache(): Promise<void> {
    await this.rpcInstance.request('llm.invalidate_model_discovery', {}) as LLMInvalidateModelDiscoveryResult;
  }

  // ── Discord methods ──

  async discordSend(channelId: string, content: string): Promise<void> {
    await this.rpcInstance.request('discord.send', {
      channelId,
      content,
    }) as DiscordSendResult;
  }

  async discordSendMedia(channelId: string, media: Attachment): Promise<void> {
    await this.rpcInstance.request('discord.sendMedia', {
      channelId,
      media,
    }) as DiscordSendMediaResult;
  }

  async discordTyping(channelId: string): Promise<void> {
    await this.rpcInstance.request('discord.typing', { channelId });
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
    return await this.rpcInstance.request('companion.message.send', {
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
    return await this.rpcInstance.request('companion.message.send', {
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
    return await this.rpcInstance.request('companion.message.report_failure', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as CompanionMessageFailureReportResult;
  }

  // ── ICP autonomy control plane (s10mc.6.2) ──

  async companionPublishAvailability(
    params: Omit<IcpAvailabilityPublishParams, 'companionId'>,
  ): Promise<IcpAvailabilityLease> {
    return await this.rpcInstance.request('companion.availability.publish', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpAvailabilityLease;
  }

  async companionClearAvailability(
    params: Omit<IcpAvailabilityClearParams, 'companionId'>,
  ): Promise<{ cleared: boolean }> {
    return await this.rpcInstance.request('companion.availability.clear', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as { cleared: boolean };
  }

  async companionReadPeerAvailability(
    params: Omit<IcpPeerAvailabilityReadParams, 'companionId'>,
  ): Promise<IcpPeerAvailabilityResult> {
    return await this.rpcInstance.request('companion.availability.read_peer', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpPeerAvailabilityResult;
  }

  async companionReadOwnAvailability(): Promise<IcpOwnAvailabilityResult> {
    const params: IcpOwnAvailabilityReadParams = {
      ...(this.companionId ? { companionId: this.companionId } : {}),
    };
    return await this.rpcInstance.request('companion.availability.read_self', params) as
      IcpOwnAvailabilityResult;
  }

  async companionInitiationPreflight(
    params: Omit<IcpInitiationPreflightParams, 'companionId'>,
  ): Promise<IcpInitiationGateDecision> {
    return await this.rpcInstance.request('companion.initiation.preflight', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpInitiationGateDecision;
  }

  async companionIssueInitiationPermit(
    params: Omit<IcpInitiationPermitIssueParams, 'companionId'>,
  ): Promise<IcpInitiationPermitIssueResult> {
    return await this.rpcInstance.request('companion.initiation.permit.issue', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpInitiationPermitIssueResult;
  }

  async companionPrepareInitiationHandoff(
    params: Omit<IcpInitiationHandoffPrepareParams, 'companionId'>,
  ): Promise<IcpInitiationHandoffPrepareResult> {
    return await this.rpcInstance.request('companion.initiation.permit.prepare_handoff', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpInitiationHandoffPrepareResult;
  }

  async companionConsumeInitiationPermit(
    params: Omit<IcpPermitConsumeParams, 'companionId'>,
  ): Promise<IcpPermitConsumeResult> {
    return await this.rpcInstance.request('companion.initiation.permit.consume', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpPermitConsumeResult;
  }

  async companionRevokeInitiationPermit(
    params: Omit<IcpPermitRevokeParams, 'companionId'>,
  ): Promise<IcpPermitRevokeResult> {
    return await this.rpcInstance.request('companion.initiation.permit.revoke', {
      ...params,
      ...(this.companionId ? { companionId: this.companionId } : {}),
    }) as IcpPermitRevokeResult;
  }

  /** Fence and revoke pending permits while linearizing a companion contact block. */
  async invalidatePendingInitiationPermitsForBlock(
    params: Omit<IcpPermitInvalidateSelfParams, 'companionId'> = { reasonCode: 'peer_blocked' },
  ): Promise<{ revokedCount: number }> {
    return await this.rpcInstance.request('companion.initiation.permit.invalidate_for_self', {
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
    const result = await this.rpcInstance.request('web.fetch', {
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
    return await this.rpcInstance.request('web.search', {
      query,
      ...(typeof maxResults === 'number' && Number.isFinite(maxResults)
        ? { maxResults: Math.max(1, Math.floor(maxResults)) }
        : {}),
    }) as WebSearchResult;
  }

  async webFetchBinary(
    url: string,
    options: {
      lane?: WebFetchLane;
      maxBytes?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<WebFetchBinaryResult> {
    return await this.rpcInstance.request('web.fetch_binary', {
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
    const result = await this.rpcInstance.request('intake.screen_image', {
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
    return await this.rpcInstance.request('web.request_binary', {
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
    return await this.rpcInstance.request('shell.exec', {
      command,
      args,
      ...options,
    }) as ShellExecResult;
  }

  async shardBackendRequest(
    params: ShardBackendRequestParams,
  ): Promise<ShardBackendRequestResult> {
    return await this.rpcInstance.request('shard.backend.request', params) as ShardBackendRequestResult;
  }

  async vaultWrite(
    name: string,
    content: string,
    options: {
      folder?: string;
      mode?: 'create' | 'append' | 'prepend';
    } = {},
  ): Promise<VaultWriteResult> {
    return await this.rpcInstance.request('vault.write', {
      name,
      content,
      ...options,
    }) as VaultWriteResult;
  }

  async vaultRead(name: string): Promise<VaultReadResult> {
    return await this.rpcInstance.request('vault.read', { name }) as VaultReadResult;
  }

  async vaultSearch(query: string, limit?: number): Promise<VaultSearchResult> {
    return await this.rpcInstance.request('vault.search', {
      query,
      ...(typeof limit === 'number' && Number.isFinite(limit)
        ? { limit: Math.max(1, Math.floor(limit)) }
        : {}),
    }) as VaultSearchResult;
  }

  async vaultDaily(content?: string): Promise<VaultDailyResult> {
    return await this.rpcInstance.request('vault.daily', {
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

  async fsReadDetailed(path: string, options?: { maxBytes?: number }): Promise<FsReadResult> {
    return await this.rpcInstance.request('fs.read', {
      path,
      ...(typeof options?.maxBytes === 'number' ? { maxBytes: options.maxBytes } : {}),
    }) as FsReadResult;
  }

  async fsRead(path: string, options?: { maxBytes?: number }): Promise<string> {
    const result = await this.fsReadDetailed(path, options);
    return result.content;
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.rpcInstance.request('fs.write', { path, content }) as FsWriteResult;
  }

  async fsList(
    glob?: string,
    maxEntries = 200,
    options?: { path?: string; maxScannedEntries?: number },
  ): Promise<FsListResult> {
    return await this.rpcInstance.request('fs.list', {
      ...(typeof options?.path === 'string' ? { path: options.path } : {}),
      ...(typeof glob === 'string' ? { glob } : {}),
      ...(typeof options?.maxScannedEntries === 'number' ? { maxScannedEntries: options.maxScannedEntries } : {}),
      maxEntries,
    }) as FsListResult;
  }

  async fsSearch(params: FsSearchParams): Promise<FsSearchResult> {
    return await this.rpcInstance.request('fs.search', params) as FsSearchResult;
  }

  async fsEdit(params: FsEditParams): Promise<FsEditResult> {
    return await this.rpcInstance.request('fs.edit', params) as FsEditResult;
  }

  // ── Git operations ──

  async gitStatus(): Promise<GitStatusResult> {
    return await this.rpcInstance.request('git.status', {}) as GitStatusResult;
  }

  async gitDiff(opts: GitDiffParams = {}): Promise<GitDiffResult> {
    return await this.rpcInstance.request('git.diff', opts) as GitDiffResult;
  }

  async gitCreateBranch(name: string, startPoint?: string): Promise<string> {
    const result = await this.rpcInstance.request('git.create_branch', {
      name,
      startPoint,
    }) as GitCreateBranchResult;
    return result.name;
  }

  async gitApplyPatch(filePath: string, content: string): Promise<void> {
    await this.rpcInstance.request('git.apply_patch', { filePath, content }) as GitApplyPatchResult;
  }

  async gitCommit(message: string, intent: string, scope?: string): Promise<GitCommitResult> {
    return await this.rpcInstance.request('git.commit', { message, intent, scope }) as GitCommitResult;
  }

  async gitOpenPR(title: string, body: string, base?: string): Promise<string> {
    const result = await this.rpcInstance.request('git.open_pr', { title, body, base }) as GitOpenPRResult;
    return result.url;
  }

  // ── Beads issue management ──

  async beadsReady(params: BeadsReadyParams = {}): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.ready', params) as BeadsActionResult;
  }

  async beadsShow(params: BeadsShowParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.show', params) as BeadsActionResult;
  }

  async beadsCreate(params: BeadsCreateParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.create', params) as BeadsActionResult;
  }

  async beadsUpdate(params: BeadsUpdateParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.update', params) as BeadsActionResult;
  }

  async beadsClose(params: BeadsCloseParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.close', params) as BeadsActionResult;
  }

  async beadsSync(params: BeadsSyncParams = {}): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.sync', params) as BeadsActionResult;
  }

  // ── Home Assistant world control (Sprint 10, bead .8 gateway method) ──

  async homeAssistantGetStates(
    params: HomeAssistantGetStatesParams = {},
  ): Promise<HomeAssistantGetStatesResult> {
    return await this.rpcInstance.request('home_assistant.get_states', params) as HomeAssistantGetStatesResult;
  }

  async homeAssistantCallService(
    params: HomeAssistantCallServiceParams,
  ): Promise<HomeAssistantCallServiceResult> {
    return await this.rpcInstance.request('home_assistant.call_service', params) as HomeAssistantCallServiceResult;
  }

  async imageCreate(params: ImageCreateParams): Promise<ImageGenerationRpcResult> {
    return await this.rpcInstance.request('image.create', {
      ...params,
      ...buildOutboundUsageCorrelation(this.companionId, getRequestContext()),
    }) as ImageGenerationRpcResult;
  }

  async imageEdit(params: ImageEditParams): Promise<ImageGenerationRpcResult> {
    return await this.rpcInstance.request('image.edit', {
      ...params,
      ...buildOutboundUsageCorrelation(this.companionId, getRequestContext()),
    }) as ImageGenerationRpcResult;
  }

  async notifyNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    return await this.rpcInstance.request('notify.ntfy', params) as NotifyNtfyResult;
  }

  async runtimeHealth(): Promise<RuntimeHealthResult> {
    return await this.rpcInstance.request('runtime.health', {}) as RuntimeHealthResult;
  }

  async getCredentialPresence(): Promise<GatewayCredentialPresenceResult> {
    return await this.rpcInstance.request(
      'runtime.credential_presence',
      {},
    ) as GatewayCredentialPresenceResult;
  }

  async listConfirmationQueue(): Promise<ConfirmationListResult> {
    return await this.rpcInstance.request('confirmation.list', {}) as ConfirmationListResult;
  }

  async resolveConfirmationQueue(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult> {
    return await this.rpcInstance.request('confirmation.resolve', params) as ConfirmationResolveResult;
  }

  async sessionHmacSign(entry: JournalEntry, previousHmac: string | null): Promise<JournalEntry> {
    const result = await this.rpcInstance.request('session.hmac.sign', {
      entry,
      previousHmac,
    }) as SessionHmacSignResult;
    return result.entry;
  }

  async sessionHmacVerify(
    entry: JournalEntry,
    previousHmac: string | null,
  ): Promise<JournalIntegrityVerificationResult> {
    return await this.rpcInstance.request('session.hmac.verify', {
      entry,
      previousHmac,
    }) as SessionHmacVerifyResult;
  }

  createSessionIntegrityProvider(): SessionIntegrityProvider {
    return {
      sign: (entry, previousHmac) => {
        const result = this.requestSessionIntegritySync<SessionHmacSignResult>('session.hmac.sign', {
          entry,
          previousHmac,
        });
        return result.entry;
      },
      verify: (entry, previousHmac) => {
        const cacheKey = this.buildSessionIntegrityVerifyCacheKey(entry, previousHmac);
        const cached = this.sessionIntegrityVerifyCache.get(cacheKey);
        if (cached) {
          this.sessionIntegrityVerifyCache.delete(cacheKey);
          this.sessionIntegrityVerifyCache.set(cacheKey, cached);
          return { ...cached };
        }

        const result = this.requestSessionIntegritySync<SessionHmacVerifyResult>(
          'session.hmac.verify',
          {
            entry,
            previousHmac,
          },
        );
        this.sessionIntegrityVerifyCache.set(cacheKey, { ...result });
        while (this.sessionIntegrityVerifyCache.size > SESSION_INTEGRITY_VERIFY_CACHE_MAX_ENTRIES) {
          const oldestKey = this.sessionIntegrityVerifyCache.keys().next().value;
          if (oldestKey === undefined) break;
          this.sessionIntegrityVerifyCache.delete(oldestKey);
        }
        return result;
      },
    };
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
  ): Promise<T> {
    if (!signal) {
      return await this.rpcInstance.request(method, params) as T;
    }

    if (signal.aborted) {
      throw createAbortError(signal.reason);
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;

      const finalize = (kind: 'resolve' | 'reject', value: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (kind === 'resolve') {
          resolve(value as T);
        } else {
          reject(value);
        }
      };

      const onAbort = () => {
        finalize('reject', createAbortError(signal.reason));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      this.rpcInstance.request(method, params).then(
        (result) => finalize('resolve', result),
        (error) => finalize('reject', error),
      );
    });
  }

  private onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): () => void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    };
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer || this.isDestroying) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      this.sendKeepalive();
    }, this.keepaliveIntervalMs);
    this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) {
      return;
    }
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private sendKeepalive(): void {
    if (this.isDestroying) {
      return;
    }
    if (!this.conn.sendHeartbeat()) {
      log.debug('Gateway transport heartbeat failed; closing connection');
      this.conn.destroy();
    }
  }

  /** Register a handler for reverse RPC calls from gateway (e.g. voice messages) */
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void {
    this.handleMessageHandler = handler;
    this.registerReverseMethods();
  }

  onApiChatCompletion(handler: (params: ApiChatCompletionRpcParams) => Promise<ApiChatCompletionRpcResult>): void {
    this.apiChatCompletionHandler = handler;
    this.registerReverseMethods();
  }

  onApiChatCancel(handler: (params: ApiChatCompletionCancelRpcParams) => Promise<ApiChatCompletionCancelRpcResult>): void {
    this.apiChatCancelHandler = handler;
    this.registerReverseMethods();
  }

  onApiTelemetryIngest(handler: (params: ApiTelemetryIngestRpcParams) => Promise<ApiTelemetryIngestRpcResult>): void {
    this.apiTelemetryIngestHandler = handler;
    this.registerReverseMethods();
  }

  onApiHealth(handler: () => Promise<ApiHealthRpcResult>): void {
    this.apiHealthHandler = handler;
    this.registerReverseMethods();
  }

  notifyApiStreamDelta(requestId: string, text: string): void {
    this.conn.send({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId, text },
    });
  }

  /**
   * Forwards a REDACTED companion event (tool activity / artifact created)
   * to the gateway relay (w9hj.1). Payloads must already have passed through
   * `channels/backplane/companion-relay/redaction.ts`; the gateway re-validates
   * and reconstructs them at the process boundary.
   */
  publishCompanionEvent(params: CompanionRelayPublishParams): void {
    this.conn.send({
      jsonrpc: '2.0',
      method: 'companion.event.publish',
      params,
    });
  }

  private registerReverseMethods(): void {
    if (this.reverseMethodsRegistered) return;
    this.reverseMethodsRegistered = true;

    registerReverseGatewayMethods({
      target: this.rpcInstance,
      dispatchHandleMessage: (message) => this.dispatchHandleMessage(message),
      handleVoiceStreamStart: (params) => this.handleVoiceStreamStart(params),
      handleVoiceStreamChunk: (params) => this.handleVoiceStreamChunk(params),
      handleVoiceStreamEnd: (params) => this.handleVoiceStreamEnd(params),
      handleVoiceStreamCancel: (params) => this.handleVoiceStreamCancel(params),
      handleApiChatCompletion: (params) => this.handleApiChatCompletion(params),
      handleApiChatCancel: (params) => this.handleApiChatCancel(params),
      handleApiTelemetryIngest: (params) => this.handleApiTelemetryIngest(params),
      handleApiHealth: () => this.handleApiHealth(),
    });
  }

  private async dispatchHandleMessage(message: unknown): Promise<VoiceHandleMessageResult> {
    if (!this.handleMessageHandler) {
      throw new Error('No voice.handleMessage handler registered');
    }

    const substrateMessage = this.deserializeMessage(message);
    const response = await this.handleMessageHandler(substrateMessage);
    return {
      content: response.content,
      channelId: response.channelId,
      ...(response.attachments ? { attachments: response.attachments } : {}),
      model: response.metadata.model,
      durationMs: response.metadata.durationMs,
    } satisfies VoiceHandleMessageResult;
  }

  private async handleApiChatCompletion(
    params: ApiChatCompletionRpcParams,
  ): Promise<ApiChatCompletionRpcResult> {
    if (!this.apiChatCompletionHandler) {
      throw new Error('No api.chat.completion handler registered');
    }
    return await this.apiChatCompletionHandler(params);
  }

  private async handleApiChatCancel(
    params: ApiChatCompletionCancelRpcParams,
  ): Promise<ApiChatCompletionCancelRpcResult> {
    if (!this.apiChatCancelHandler) {
      throw new Error('No api.chat.cancel handler registered');
    }
    return await this.apiChatCancelHandler(params);
  }

  private async handleApiTelemetryIngest(
    params: ApiTelemetryIngestRpcParams,
  ): Promise<ApiTelemetryIngestRpcResult> {
    if (!this.apiTelemetryIngestHandler) {
      throw new Error('No api.telemetry.ingest handler registered');
    }
    return await this.apiTelemetryIngestHandler(params);
  }

  private async handleApiHealth(): Promise<ApiHealthRpcResult> {
    if (!this.apiHealthHandler) {
      throw new Error('No api.health handler registered');
    }
    return await this.apiHealthHandler();
  }

  private handleVoiceStreamStart(params: unknown): VoiceStreamAckResult {
    if (!isRecord(params)) {
      throw new Error('voice.stream.start params must be an object');
    }
    const correlationId = typeof params.correlationId === 'string'
      ? params.correlationId.trim()
      : '';
    const streamId = typeof params.streamId === 'string' ? params.streamId.trim() : '';
    if (!correlationId || correlationId !== params.correlationId) {
      throw new Error('voice.stream.start params.correlationId must be a canonical non-empty string');
    }
    if (!streamId || streamId !== params.streamId) {
      throw new Error('voice.stream.start params.streamId must be a canonical non-empty string');
    }
    if (typeof params.sequence !== 'number'
      || !Number.isSafeInteger(params.sequence)
      || params.sequence < 0) {
      throw new Error('voice.stream.start params.sequence must be a non-negative safe integer');
    }
    if (params.metadata !== undefined && !isRecord(params.metadata)) {
      throw new Error('voice.stream.start params.metadata must be an object when provided');
    }
    if (!Object.hasOwn(params, 'message')) {
      throw new Error('voice.stream.start params.message is required');
    }
    const message = this.deserializeMessage(params.message, {
      fieldName: 'voice.stream.start params.message',
      allowEmptyContent: true,
    });
    const sequence = params.sequence;
    const key = this.voiceStreamKey(correlationId, streamId);
    if (this.voiceStreams.has(key)) {
      throw this.rpcError('Voice stream already exists', GatewayErrors.VOICE_STREAM_SEQUENCE);
    }

    const state: VoiceStreamState = {
      correlationId,
      streamId,
      baseMessage: message,
      expectedSequence: sequence + 1,
      chunkQueue: new BoundedQueue<string>({
        maxSize: this.voiceStreamQueueSize,
        overflowPolicy: this.voiceStreamOverflowPolicy,
      }),
      chunks: [],
      droppedChunks: 0,
      cancelled: false,
    };
    this.voiceStreams.set(key, state);

    return this.streamAck(state, sequence, true);
  }

  private handleVoiceStreamChunk(params: VoiceStreamChunkParams): VoiceStreamAckResult {
    const state = this.requireVoiceStream(params.correlationId, params.streamId);
    this.assertSequence(state, params.sequence);
    if (state.cancelled) {
      throw this.rpcError('Voice stream cancelled', GatewayErrors.VOICE_STREAM_CANCELLED);
    }

    let accepted = true;
    try {
      const result = state.chunkQueue.enqueue(params.text);
      accepted = result.accepted;
      if (result.droppedReason) {
        state.droppedChunks += 1;
      }
    } catch (error) {
      if (error instanceof QueueOverflowError) {
        throw this.rpcError(error.message, GatewayErrors.VOICE_STREAM_OVERFLOW);
      }
      throw error;
    }

    state.expectedSequence = params.sequence + 1;
    return this.streamAck(state, params.sequence, accepted);
  }

  private async handleVoiceStreamEnd(
    params: VoiceStreamEndParams,
  ): Promise<VoiceStreamEndResult> {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    const state = this.requireVoiceStream(params.correlationId, params.streamId);
    if (state.cancelled) {
      this.voiceStreams.delete(key);
      throw this.rpcError('Voice stream cancelled', GatewayErrors.VOICE_STREAM_CANCELLED);
    }
    this.assertSequence(state, params.sequence);
    state.expectedSequence = params.sequence + 1;
    this.drainQueuedChunks(state);

    try {
      const result = await this.dispatchHandleMessage({
        ...state.baseMessage,
        content: state.baseMessage.content + state.chunks.join(''),
      });
      return {
        ...result,
        correlationId: state.correlationId,
        streamId: state.streamId,
        droppedChunks: state.droppedChunks,
      };
    } finally {
      this.voiceStreams.delete(key);
    }
  }

  private async handleVoiceStreamCancel(
    params: VoiceStreamCancelParams,
  ): Promise<VoiceStreamCancelResult> {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    const state = this.voiceStreams.get(key);
    if (!state) {
      return {
        correlationId: params.correlationId,
        streamId: params.streamId,
        cancelled: false,
      };
    }

    state.cancelled = true;
    state.chunkQueue.clear();
    this.voiceStreams.delete(key);

    return {
      correlationId: params.correlationId,
      streamId: params.streamId,
      cancelled: true,
    };
  }

  private streamAck(
    state: VoiceStreamState,
    sequence: number,
    accepted: boolean,
  ): VoiceStreamAckResult {
    return {
      correlationId: state.correlationId,
      streamId: state.streamId,
      sequence,
      accepted,
      queueDepth: state.chunkQueue.size,
      droppedChunks: state.droppedChunks,
    };
  }

  private requireVoiceStream(correlationId: string, streamId: string): VoiceStreamState {
    const state = this.voiceStreams.get(this.voiceStreamKey(correlationId, streamId));
    if (!state) {
      throw this.rpcError('Voice stream not found', GatewayErrors.VOICE_STREAM_NOT_FOUND);
    }
    return state;
  }

  private assertSequence(state: VoiceStreamState, sequence: number): void {
    if (sequence !== state.expectedSequence) {
      throw this.rpcError(
        `Unexpected voice stream sequence: expected ${state.expectedSequence}, got ${sequence}`,
        GatewayErrors.VOICE_STREAM_SEQUENCE,
      );
    }
  }

  private drainQueuedChunks(state: VoiceStreamState): void {
    while (state.chunkQueue.size > 0) {
      const chunk = state.chunkQueue.dequeue();
      if (chunk !== undefined) {
        state.chunks.push(chunk);
      }
    }
  }

  private deserializeMessage(
    message: unknown,
    options: { fieldName?: string; allowEmptyContent?: boolean } = {},
  ): SubstrateMessage {
    const fieldName = options.fieldName ?? 'voice.handleMessage params.message';
    assertRpcSubstrateMessage(message, {
      fieldName,
      ...(options.allowEmptyContent ? { allowEmptyContent: true } : {}),
    });
    const gatewayRouting = parseGatewayRoutingEnvelope(
      message.routing?.gateway,
      `${fieldName}.routing.gateway`,
    );
    if (this.companionId && gatewayRouting.companionId !== this.companionId) {
      throw new Error(
        `${fieldName} routing companionId does not match this gateway client binding: `
        + `expected ${JSON.stringify(this.companionId)}, got ${JSON.stringify(gatewayRouting.companionId)}`,
      );
    }
    return {
      ...message,
      routing: {
        ...message.routing,
        gateway: gatewayRouting,
      },
      timestamp: typeof message.timestamp === 'string'
        ? new Date(message.timestamp)
        : message.timestamp,
    };
  }

  private voiceStreamKey(correlationId: string, streamId: string): string {
    return `${correlationId}::${streamId}`;
  }

  private rpcError(message: string, code: number): Error {
    return new JSONRPCErrorException(message, code);
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

  private handleNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const lifecycle = handler(params);
          if (lifecycle) {
            void lifecycle.catch((err: unknown) => {
              log.error(`Async notification handler error for ${method}`, {
                error: String(err),
              });
            });
          }
        } catch (err) {
          log.error(`Notification handler error for ${method}`, { error: String(err) });
        }
      }
    }
  }

  private emitConnectionClose(event: GatewayConnectionCloseEvent): void {
    if (this.isDestroying || this.closedNotified) {
      return;
    }
    this.closedNotified = true;
    this.stopKeepalive();
    this.inlineImageReferenceHints.clear();
    for (const handler of this.connectionCloseHandlers) {
      try {
        handler(event);
      } catch (error) {
        log.error('Disconnect handler error', { error: toErrorMessage(error) });
      }
    }
  }

  private ensureSessionIntegrityWorker(): Worker {
    if (this.sessionIntegrityWorker) return this.sessionIntegrityWorker;
    if (!this.sessionIntegrityEndpoint) {
      throw new Error('Session integrity provider requires a gateway socket path or gateway RPC endpoint');
    }

    const worker = new Worker(SESSION_INTEGRITY_WORKER_SOURCE, { eval: true });
    worker.on('error', (error) => {
      log.error('Session integrity worker error', { error: error.message });
    });
    this.sessionIntegrityWorker = worker;
    return worker;
  }

  private requestSessionIntegritySync<T>(
    method: 'session.hmac.sign' | 'session.hmac.verify',
    params: Record<string, unknown>,
  ): T {
    const worker = this.ensureSessionIntegrityWorker();
    const stateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const payloadBuffer = new SharedArrayBuffer(SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES);
    const state = new Int32Array(stateBuffer);
    const requestId = ++this.sessionIntegrityRequestCounter;

    worker.postMessage({
      stateBuffer,
      payloadBuffer,
      endpoint: this.sessionIntegrityEndpoint,
      method,
      params,
      companionId: this.companionId,
      companionAuthToken: this.sessionIntegrityAuthToken,
      requestId,
      timeoutMs: this.sessionIntegrityRpcTimeoutMs,
    });

    const wait = Atomics.wait(state, 0, 0, this.sessionIntegrityRpcTimeoutMs + 250);
    if (wait === 'timed-out') {
      throw new Error(`Session integrity RPC timed out for ${method}`);
    }

    const payloadSize = Atomics.load(state, 1);
    if (!Number.isInteger(payloadSize) || payloadSize <= 0 || payloadSize > SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES) {
      throw new Error('Session integrity RPC returned an invalid payload');
    }

    const raw = Buffer.from(new Uint8Array(payloadBuffer, 0, payloadSize)).toString('utf8');
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      response?: { result?: unknown; error?: { code: number; message: string } };
      error?: string;
    };

    if (!parsed.ok) {
      throw new Error(parsed.error ?? `Session integrity RPC failed for ${method}`);
    }

    const rpcResponse = parsed.response;
    if (!rpcResponse) {
      throw new Error(`Session integrity RPC missing response for ${method}`);
    }

    if (rpcResponse.error) {
      throw new JSONRPCErrorException(rpcResponse.error.message, rpcResponse.error.code);
    }

    return rpcResponse.result as T;
  }

  private buildSessionIntegrityVerifyCacheKey(
    entry: JournalEntry,
    previousHmac: string | null,
  ): string {
    return JSON.stringify({
      previousHmac,
      type: entry.type,
      id: entry.id,
      channelId: entry.channelId,
      role: entry.role ?? null,
      content: entry.content ?? null,
      authorId: entry.authorId ?? null,
      authorName: entry.authorName ?? null,
      timestamp: entry.timestamp,
      discordMessageId: entry.discordMessageId ?? null,
      metadata: entry.metadata ?? null,
      originChannelId: entry.originChannelId ?? null,
      channelVisibility: entry.channelVisibility ?? null,
      summary: entry.summary ?? null,
      coveredUpTo: entry.coveredUpTo ?? null,
      marker: entry.marker ?? null,
      tombstoneTargetType: entry.tombstoneTargetType ?? null,
      tombstoneTargetId: entry.tombstoneTargetId ?? null,
      tombstoneAction: entry.tombstoneAction ?? null,
      tombstoneActor: entry.tombstoneActor ?? null,
      tombstoneReason: entry.tombstoneReason ?? null,
      _hmac: entry._hmac ?? null,
      _hmacKeyVersion: entry._hmacKeyVersion ?? null,
    });
  }

  // ── Lifecycle ──

  destroy(): void {
    if (this.isDestroying) return;
    this.isDestroying = true;
    this.stopKeepalive();
    this.sessionIntegrityVerifyCache.clear();
    this.inlineImageReferenceHints.clear();
    this.voiceStreams.clear();
    this.connectionCloseHandlers.clear();
    if (this.sessionIntegrityWorker) {
      void this.sessionIntegrityWorker.terminate();
      this.sessionIntegrityWorker = null;
    }
    this.conn.destroy();
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

function normalizeGatewayModelHint(modelHint: LLMModelHint | undefined): LLMModelHint | undefined {
  if (!modelHint) return undefined;
  const model = normalizeCorrelationText(modelHint.model);
  const provider = normalizeCorrelationText(modelHint.provider)?.toLowerCase();
  const pin = typeof modelHint.pin === 'boolean' ? modelHint.pin : undefined;
  const maxTokens = toPositiveInteger(modelHint.maxTokens);
  const contextWindow = toPositiveInteger(modelHint.contextWindow);
  const thinkingEnabled = typeof modelHint.thinkingEnabled === 'boolean'
    ? modelHint.thinkingEnabled
    : undefined;
  const thinkingEffort = toThinkingEffort(modelHint.thinkingEffort);
  const temperature = toFiniteNumber(modelHint.temperature);
  const topP = toUnitInterval(modelHint.topP);
  const topK = toPositiveInteger(modelHint.topK);
  const frequencyPenalty = toFiniteNumber(modelHint.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(modelHint.repetitionPenalty);
  if (
    !model
    && !provider
    && pin === undefined
    && maxTokens === undefined
    && contextWindow === undefined
    && thinkingEnabled === undefined
    && thinkingEffort === undefined
    && temperature === undefined
    && topP === undefined
    && topK === undefined
    && frequencyPenalty === undefined
    && repetitionPenalty === undefined
  ) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(pin !== undefined ? { pin } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
  };
}

function mergeGatewayModelHints(
  contextHint: LLMModelHint | undefined,
  optionHint: LLMModelHint | undefined,
): LLMModelHint | undefined {
  const normalizedContext = normalizeGatewayModelHint(contextHint);
  const normalizedOption = normalizeGatewayModelHint(optionHint);
  if (!normalizedContext && !normalizedOption) return undefined;
  return {
    ...(normalizedContext ?? {}),
    ...(normalizedOption ?? {}),
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toThinkingEffort(value: unknown): LLMModelHint['thinkingEffort'] | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    reason.name = reason.name || 'AbortError';
    return reason;
  }
  const message = typeof reason === 'string' && reason.trim().length > 0
    ? reason
    : 'Request aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
