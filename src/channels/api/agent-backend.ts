import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ChannelType,
  ContextMessage,
  LLMContext,
  MessageModelOverride,
  MessagePromptOverride,
  MessageRoutingMetadata,
  AgentResponse,
  ResponseStyle,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
  SatelliteRoutingMetadata,
} from '../../shared/contracts/satellite-registry.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type {
  SubstrateAgent,
  SubstrateAgentAbortResult,
} from '../../core/agent/substrate-agent.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createEventBusSensorIngestPort, type SensorIngestPort } from '../../shared/telemetry/sensor-ingest-port.js';
import type { SessionManager } from '../../core/session/manager.js';
import { CHANNEL_PRIVACY_VALUES, isChannelPrivacy, type ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiCompanionUiShardActionRpcParams,
  ApiCompanionUiShardActionRpcResult,
  ApiHealthRpcResult,
  ApiRpcFailure,
  ApiRpcHeaders,
  ApiRuntimeChatRequest,
  ApiRuntimeError,
  ApiServerHealthChecks,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
  ApiShardOwnerRpcParams,
  ApiShardOwnerRpcResult,
  ChatCompletionRequest,
  TelemetryIngestResponse,
} from './types.js';
import {
  isHubDeviceAttachmentSnapshot,
  isHubDevicePrincipalSnapshot,
  type HubDeviceAttachmentSnapshot,
  type HubDevicePrincipalSnapshot,
} from '../../shared/contracts/hub-device-ingress.js';
import {
  getLastUserMessage as getChatLastUserMessage,
  getLastUserMessageAttachments,
  getLastUserMessageFileParts,
  getMessageTextContent,
  ingestApiDocumentFileParts,
  type ApiDocumentIngestConfig,
} from './server/session.js';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import { screenChatMessageBody } from '../../core/cogsec/intake/chat-message-screening.js';
import { buildApiHealthResponse } from './server-health.js';
import {
  type FifoChannelLease,
  FifoChannelLock,
  emitTurnContentionTelemetry,
  isBusyTurnError,
} from '../../system/lifecycle/turn-contention.js';
import { resolveApiTurnIdentity } from './external-channel-claim.js';
import type { ExternalChannelProfileConfig } from '../backplane/config.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  clampHttpHeader as clampHeaderValue,
  singleHeader as firstHeaderValue,
} from './http-policy.js';
import type { ApiAuthPrincipal } from '../backplane/http/auth.js';
import {
  emitTurnPerformance,
  monotonicEpochNowMs,
} from '../../shared/telemetry/turn-performance.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { RequestCapabilityVerifier } from '../../boundary/fleet-auth/request-capability.js';
import {
  companionUiPromptContent,
  compileCompanionUiAction,
  type CompiledCompanionUiAction,
} from '../../boundary/fleet-auth/companion-ui-action.js';
import { resolveSatelliteClaim } from '../backplane/satellite-registry.js';
import type { ShardDirectoryPort } from '../../shared/contracts/shard-directory.js';
import { classifyCompanionUiShardActionFailure } from './companion-ui-shard-action-error.js';
import {
  type ActiveApiTurnRequest,
  type ApiTurnCancellationReason,
  QueuedApiTurnCancellation,
} from './turn-cancellation.js';

const log = createComponentLogger('AgentApiBackend');

function sameHubDevicePrincipal(
  left: HubDevicePrincipalSnapshot,
  right: HubDevicePrincipalSnapshot,
): boolean {
  return left.issuer === right.issuer
    && left.keyId === right.keyId
    && left.deviceId === right.deviceId
    && left.enrollmentVersion === right.enrollmentVersion
    && left.placeId === right.placeId
    && left.audience === right.audience
    && left.companionId === right.companionId
    && left.sessionId === right.sessionId
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt
    && left.jti === right.jti;
}

const DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS = 65 * 60_000;
const IDENTITY_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const DIRECT_PROVIDER_OVERRIDE_ALLOWLIST = new Set(['anthropic', 'openai', 'google', 'openrouter']);
const MIN_CHAT_COMPLETION_TIMEOUT_MS = 1_000;

const IDENTITY_CLAIM_HEADERS = {
  canonicalContactId: 'x-canonical-contact-id',
  sourceChannel: 'x-identity-claim-channel',
  sourceUserId: 'x-identity-claim-user-id',
  nonce: 'x-identity-claim-nonce',
  expires: 'x-identity-claim-expires',
  signature: 'x-identity-claim-signature',
} as const;

interface PendingTurn {
  channelId: string;
  releaseChannel: () => void;
  substrateMsg: SubstrateMessage;
}

interface TurnRoutingOverrides {
  modelOverride?: MessageModelOverride;
  promptOverride?: MessagePromptOverride;
  responseStyle?: ResponseStyle;
}

interface ChannelPrivacyResolution {
  ok: true;
  value?: ChannelPrivacy;
}

interface ChannelPrivacyError {
  ok: false;
  error: string;
}

interface IdentityClaimHeaders {
  canonicalContactId: string;
  sourceChannel: string;
  sourceUserId: string;
  nonce?: string;
  expiresAt?: string;
  signature?: string;
}

interface ObservedTurnCompletion {
  promise: Promise<AgentResponse>;
  attachFallback(turnPromise: Promise<AgentResponse>): void;
  dispose(): void;
}

function isAbortSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface AgentApiBackendConfig {
  agentLoop: Pick<SubstrateAgent, 'handleMessage' | 'abort'>;
  eventBus: EventBus;
  sessionManager: Pick<
    SessionManager,
    'getMessageCount' | 'recordUserMessage' | 'recordAssistantMessage'
  >;
  /** Required for direct (raw) model completions that bypass the companion turn pipeline. */
  llmProvider?: LLMProviderPort;
  contactStore?: ContactStorePort;
  healthChecks?: ApiServerHealthChecks;
  schedulerHealthcheckStaleAfterMs?: number;
  externalChannelProfiles?: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  satelliteRegistry?: SatelliteRegistryConfig;
  /** This agent process's server-owned companion identity. */
  companionId?: string;
  sensorIngest?: SensorIngestPort;
  onStreamDelta?: (requestId: string, text: string) => void | Promise<void>;
  /** Shared chat-body screening and document ingestion; null when not configured. */
  documentIngest?: ApiDocumentIngestConfig | null;
  /** Agent-side verifier for linked gateway child assertions. */
  requestCapabilityVerifier?: RequestCapabilityVerifier;
  shardDirectory?: ShardDirectoryPort;
}

export class AgentApiBackend {
  private readonly agentLoop: Pick<SubstrateAgent, 'handleMessage' | 'abort'>;
  private readonly eventBus: EventBus;
  private readonly sessionManager: Pick<
    SessionManager,
    'getMessageCount' | 'recordUserMessage' | 'recordAssistantMessage'
  >;
  private readonly llmProvider: LLMProviderPort | null;
  private readonly contactStore: ContactStorePort | null;
  private readonly healthChecks: ApiServerHealthChecks;
  private readonly schedulerHealthcheckStaleAfterMs: number;
  private readonly externalChannelProfiles: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  private readonly satelliteRegistry: SatelliteRegistryConfig | undefined;
  private readonly companionId: string | undefined;
  private readonly sensorIngest: SensorIngestPort;
  private readonly documentIngest: ApiDocumentIngestConfig | null;
  private readonly onStreamDelta?: (requestId: string, text: string) => void | Promise<void>;
  private readonly requestCapabilityVerifier?: RequestCapabilityVerifier;
  private readonly shardDirectory: ShardDirectoryPort | null;
  private readonly channelTurnLock = new FifoChannelLock();
  private readonly processingChannels = new Set<string>();
  private readonly activeRequests = new Map<string, ActiveApiTurnRequest>();
  private lastSchedulerHealthcheckAtMs: number | null = null;
  private readonly unregisterSchedulerHealthcheck: () => void;

  constructor(config: AgentApiBackendConfig) {
    this.agentLoop = config.agentLoop;
    this.eventBus = config.eventBus;
    this.sessionManager = config.sessionManager;
    this.llmProvider = config.llmProvider ?? null;
    this.contactStore = config.contactStore ?? null;
    this.healthChecks = config.healthChecks ?? {};
    this.schedulerHealthcheckStaleAfterMs = this.parseSchedulerHealthcheckStaleAfterMs(
      config.schedulerHealthcheckStaleAfterMs,
    );
    this.externalChannelProfiles = config.externalChannelProfiles ?? {};
    this.satelliteRegistry = config.satelliteRegistry;
    this.companionId = config.companionId;
    this.sensorIngest = config.sensorIngest ?? createEventBusSensorIngestPort(config.eventBus);
    this.documentIngest = config.documentIngest ?? null;
    this.onStreamDelta = config.onStreamDelta;
    this.requestCapabilityVerifier = config.requestCapabilityVerifier;
    this.shardDirectory = config.shardDirectory ?? null;
    this.unregisterSchedulerHealthcheck = this.eventBus.on('schedule.healthcheck', ({ timestamp }) => {
      if (Number.isFinite(timestamp) && timestamp > 0) {
        this.lastSchedulerHealthcheckAtMs = Math.floor(timestamp);
      } else {
        this.lastSchedulerHealthcheckAtMs = Date.now();
      }
    });
  }

  dispose(): void {
    this.unregisterSchedulerHealthcheck();
  }

  async handleHealth(): Promise<ApiHealthRpcResult> {
    const result = await buildApiHealthResponse({
      healthChecks: this.healthChecks,
      lastSchedulerHealthcheckAtMs: this.lastSchedulerHealthcheckAtMs,
      schedulerHealthcheckStaleAfterMs: this.schedulerHealthcheckStaleAfterMs,
    });
    const healthAwareAgent = this.agentLoop as Partial<Pick<SubstrateAgent, 'setCompanionSubstrateHealthContext'>>;
    healthAwareAgent.setCompanionSubstrateHealthContext?.({ apiHealth: result.body });
    return result.body;
  }

  async handleTelemetryIngest(
    params: ApiTelemetryIngestRpcParams,
  ): Promise<ApiTelemetryIngestRpcResult> {
    const receipt = await this.sensorIngest.ingestTelemetry(params.event);
    return {
      ok: true,
      response: {
        ok: true,
        id: receipt.id,
        acceptedEventType: receipt.acceptedEventType,
      } satisfies TelemetryIngestResponse,
    };
  }

  async cancelChatCompletion(
    params: ApiChatCompletionCancelRpcParams,
  ): Promise<ApiChatCompletionCancelRpcResult> {
    const active = this.activeRequests.get(params.requestId);
    if (!active) {
      await this.emitCancellationOutcome(params.requestId, undefined, 'failed');
      return { cancelled: false };
    }
    const cancelled = await this.cancelActiveRequest(
      params.requestId,
      active,
      'client_disconnected',
    );
    return { cancelled };
  }

  private async cancelActiveRequest(
    requestId: string,
    active: ActiveApiTurnRequest,
    reason: ApiTurnCancellationReason,
  ): Promise<boolean> {
    let abortResult: SubstrateAgentAbortResult | null = null;
    try {
      abortResult = active.cancel(reason);
    } catch (error) {
      log.error('API turn cancellation failed', {
        requestId,
        channelId: active.channelId,
        error: toErrorMessage(error),
      });
    }
    if (abortResult?.status === 'already_aborted') {
      return false;
    }
    const cancelled = abortResult?.status === 'signaled';
    if (cancelled) {
      await this.eventBus.emit('api.turn.abort', {
        channelId: active.channelId,
        reason,
      });
    }
    await this.emitCancellationOutcome(
      requestId,
      active.channelId,
      cancelled ? 'acknowledged' : 'failed',
    );
    return cancelled;
  }

  private async emitCancellationOutcome(
    requestId: string,
    channelId: string | undefined,
    cancellationOutcome: 'acknowledged' | 'failed',
  ): Promise<void> {
    await emitTurnPerformance(this.eventBus, {
      traceId: requestId,
      requestId,
      ...(channelId ? { channelId } : {}),
      channelType: 'api',
      stage: 'cancellation_ack',
      cancellationOutcome,
    });
  }

  async handleChatCompletion(
    params: ApiChatCompletionRpcParams,
  ): Promise<ApiChatCompletionRpcResult> {
    return await this.executeChatCompletion({
      requestId: params.requestId,
      request: params.request,
      principal: params.principal,
      headers: params.headers,
      clientCert: params.clientCert,
      hubDevicePrincipal: params.hubDevicePrincipal,
      hubDeviceAttachment: params.hubDeviceAttachment,
      companionUiCapability: params.companionUiCapability,
      timeoutMs: params.timeoutMs,
      performance: params.performance,
      onDelta: params.request.stream && this.onStreamDelta
        ? (text) => this.onStreamDelta?.(params.requestId, text)
        : undefined,
    });
  }

  handleShardOwner(params: ApiShardOwnerRpcParams): ApiShardOwnerRpcResult {
    if (!this.shardDirectory || !this.companionId) return {};
    const owner = this.shardDirectory.ownerOfLiveShard(params.shardId);
    return owner === this.companionId ? { parentCompanionId: owner } : {};
  }

  async handleCompanionUiShardAction(
    params: ApiCompanionUiShardActionRpcParams,
  ): Promise<ApiCompanionUiShardActionRpcResult> {
    let compiled: CompiledCompanionUiAction | undefined;
    try {
      if (!this.shardDirectory || !this.companionId
        || !isHubDevicePrincipalSnapshot(params.hubDevicePrincipal)
        || !isHubDeviceAttachmentSnapshot(params.hubDeviceAttachment)
        || !sameHubDevicePrincipal(
          params.hubDeviceAttachment.deviceActor.principal,
          params.hubDevicePrincipal,
        )
        || params.hubDeviceAttachment.actor.kind !== 'human'
        || params.hubDeviceAttachment.actor.companionId !== this.companionId
        || params.hubDeviceAttachment.channel.companionId !== this.companionId
        || params.hubDevicePrincipal.companionId !== this.companionId) {
        throw new Error('shard action attachment denied');
      }
      compiled = this.compileVerifiedCompanionUiCapability(params);
      const parentCompanionId = this.companionId as CompanionId;
      const body = compiled.frame.body as Record<string, unknown>;
      switch (compiled.frame.resource) {
        case 'shards.list':
          return { ok: true, response: this.shardDirectory.listShards(parentCompanionId) };
        case 'shards.history':
          return {
            ok: true,
            response: this.shardDirectory.readShardChatHistory(
              parentCompanionId,
              String(body.shardId),
            ),
          };
        case 'shards.interact':
          return {
            ok: true,
            response: await this.shardDirectory.sendShardChat({
              parentCompanionId,
              shardId: String(body.shardId),
              requestId: compiled.frame.requestId,
              content: String(body.content),
              attachment: params.hubDeviceAttachment,
            }),
          };
        case 'shards.interrupt':
          return {
            ok: true,
            response: this.shardDirectory.interruptShardChat({
              parentCompanionId,
              shardId: String(body.shardId),
              interactionId: String(body.interactionId),
            }),
          };
        default:
          throw new Error('non-shard Companion UI action');
      }
    } catch (error) {
      const failure = classifyCompanionUiShardActionFailure(error);
      log.warn(failure.logMessage, {
        requestId: params.requestId,
        resource: compiled?.frame.resource ?? 'unknown',
        error: toErrorMessage(failure.logError),
      });
      return this.fail(failure.status, failure.type, failure.message);
    }
  }

  async runChatCompletion(input: ApiRuntimeChatRequest): Promise<ApiChatCompletionRpcResult> {
    return await this.executeChatCompletion({
      requestId: `api-local-${randomUUID()}`,
      request: input.request,
      principal: input.principal,
      headers: input.headers,
      clientCert: input.clientCert,
      hubDevicePrincipal: input.hubDevicePrincipal,
      hubDeviceAttachment: input.hubDeviceAttachment,
      companionUiCapability: input.companionUiCapability,
      onDelta: input.onDelta,
      signal: input.signal,
    });
  }

  private async executeChatCompletion(params: {
    requestId: string;
    request: ChatCompletionRequest;
    principal: ApiAuthPrincipal;
    headers: ApiRpcHeaders;
    clientCert?: SatelliteClientCertIdentity;
    hubDevicePrincipal?: HubDevicePrincipalSnapshot;
    hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
    companionUiCapability?: ApiChatCompletionRpcParams['companionUiCapability'];
    onDelta?: (text: string) => void | Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
    performance?: ApiChatCompletionRpcParams['performance'];
  }): Promise<ApiChatCompletionRpcResult> {
    const requestReceivedMonotonicAtMs = params.performance?.receivedMonotonicAtMs
      ?? monotonicEpochNowMs();
    if ((params.hubDevicePrincipal === undefined)
      !== (params.hubDeviceAttachment === undefined)) {
      return this.fail(
        403,
        'hub_device_attachment_missing',
        'Hub device principal and attachment contexts must be supplied together',
      );
    }
    const companionUiCapabilityFailure = this.verifyCompanionUiCapability(params);
    if (companionUiCapabilityFailure) return companionUiCapabilityFailure;
    if (params.hubDevicePrincipal && (
      params.request.provider !== undefined
      || params.request.system_prompt !== undefined
      || (params.request.system_prompt_mode !== undefined && params.request.system_prompt_mode !== 'default')
    )) {
      return this.fail(400, 'invalid_hub_device_request', 'Hub device turns may not bypass the companion prompt');
    }
    const overrides = this.parseTurnRoutingOverrides(params.request);
    if (!overrides.ok) {
      return this.fail(400, 'invalid_request', overrides.error);
    }
    // A provider/model override with system_prompt_mode none|custom is a direct
    // model conversation (model room): it must not see the companion's memory,
    // contacts, or session context. system_prompt_mode=default opts back into
    // the full companion pipeline with the overridden model.
    if (overrides.value.modelOverride && overrides.value.promptOverride) {
      return await this.executeDirectModelCompletion(params, overrides.value);
    }

    let rejectActiveTimeout: ((error: Error) => void) | null = null;
    const activeRequest = new QueuedApiTurnCancellation(
      this.deriveChannelId(params.headers, params.principal),
      channelId => this.abortActiveTurn(params.requestId, channelId),
    );
    this.activeRequests.set(params.requestId, activeRequest);
    const onAbort = () => {
      void this.cancelChatCompletion({ requestId: params.requestId });
    };
    if (params.signal) {
      if (params.signal.aborted) {
        onAbort();
      } else {
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const timeoutMs = this.normalizeChatCompletionTimeoutMs(params.timeoutMs);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== null) {
      timeoutHandle = setTimeout(() => {
        if (!activeRequest.claimTimeout()) return;
        void this.cancelActiveRequest(
          params.requestId,
          activeRequest,
          'timeout',
        ).catch(error => log.error('API timeout cancellation reporting failed', {
          requestId: params.requestId,
          channelId: activeRequest.channelId,
          error: toErrorMessage(error),
        }));
        rejectActiveTimeout?.(new Error('api_chat_completion_timeout'));
      }, timeoutMs);
      timeoutHandle.unref();
    }

    let unsubscribe = () => {};
    let turnCompletion: ObservedTurnCompletion | null = null;

    try {
      const pendingTurn = await this.prepareTurn(
        params.requestId,
        params.request,
        params.headers,
        params.principal,
        params.clientCert,
        params.hubDevicePrincipal,
        params.hubDeviceAttachment,
        activeRequest.signal,
        channelId => {
          activeRequest.setChannelId(channelId);
        },
      );
      if (!pendingTurn.ok) {
        if (activeRequest.cancellationReason === 'timeout') {
          return this.fail(504, 'request_timeout', 'Request timed out before turn started');
        }
        return pendingTurn.error;
      }
      activeRequest.setChannelId(pendingTurn.value.channelId);
      if (activeRequest.signal.aborted) {
        pendingTurn.value.releaseChannel();
        if (activeRequest.cancellationReason === 'timeout') {
          return this.fail(504, 'request_timeout', 'Request timed out before turn started');
        }
        return this.fail(499, 'request_cancelled', 'Request cancelled before turn started');
      }

      void emitTurnPerformance(this.eventBus, {
        traceId: params.requestId,
        requestId: params.requestId,
        channelId: pendingTurn.value.channelId,
        channelType: pendingTurn.value.substrateMsg.channelType,
        stage: 'transport_received',
        ...(params.performance?.receivedMonotonicAtMs !== undefined
          ? { monotonicAtMs: params.performance.receivedMonotonicAtMs }
          : {}),
        ...(params.performance?.receivedTimestampMs !== undefined
          ? { timestampMs: params.performance.receivedTimestampMs }
          : {}),
      }).catch(error => log.debug('API transport performance telemetry emit failed', {
        requestId: params.requestId,
        error: toErrorMessage(error),
      }));

      unsubscribe = params.onDelta
        ? this.eventBus.on('agent.stream.delta', (data) => {
          if (data.channelId !== pendingTurn.value.channelId) return;
          void Promise.resolve(params.onDelta?.(data.text));
        })
        : () => {};

      turnCompletion = this.observeTurnCompletion(pendingTurn.value.substrateMsg.id);
      activeRequest.markActive();
      const turnPromise = this.agentLoop.handleMessage(pendingTurn.value.substrateMsg);
      turnCompletion.attachFallback(turnPromise);
      this.attachTurnCleanup(pendingTurn.value.releaseChannel, turnPromise);
      const turnTimeoutPromise = timeoutMs === null
        ? null
        : new Promise<never>((_, reject) => {
          rejectActiveTimeout = reject;
          if (activeRequest.cancellationReason === 'timeout') {
            reject(new Error('api_chat_completion_timeout'));
          }
        });
      const response = await (
        turnTimeoutPromise
          ? Promise.race([turnCompletion.promise, turnTimeoutPromise])
          : turnCompletion.promise
      );
      const visibleCompletionAt = monotonicEpochNowMs();
      void emitTurnPerformance(this.eventBus, {
        traceId: params.requestId,
        turnId: pendingTurn.value.substrateMsg.id,
        requestId: params.requestId,
        channelId: pendingTurn.value.channelId,
        channelType: pendingTurn.value.substrateMsg.channelType,
        stage: 'visible_turn_complete',
        monotonicAtMs: visibleCompletionAt,
        durationMs: Math.max(0, visibleCompletionAt - requestReceivedMonotonicAtMs),
      }).catch(error => log.debug('API visible-completion performance telemetry emit failed', {
        requestId: params.requestId,
        channelId: pendingTurn.value.channelId,
        error: toErrorMessage(error),
      }));
      return {
        ok: true,
        response: {
          content: response.content,
          channelId: response.channelId,
          inputTokens: response.metadata.inputTokens,
          outputTokens: response.metadata.outputTokens,
          ...(response.metadata.noReply ? { noReply: response.metadata.noReply } : {}),
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'api_chat_completion_timeout') {
        return this.fail(504, 'request_timeout', 'Request timed out before turn completed');
      }
      if (isBusyTurnError(error)) {
        return this.fail(503, 'agent_busy', 'Agent is already processing another prompt');
      }
      return this.fail(500, 'internal_error', 'Internal server error', {
        cause: toErrorMessage(error),
      });
    } finally {
      if (params.signal) {
        params.signal.removeEventListener('abort', onAbort);
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      turnCompletion?.dispose();
      unsubscribe();
      this.activeRequests.delete(params.requestId);
    }
  }

  /**
   * Direct (raw) model completion for model-room participant turns.
   *
   * Bypasses the companion turn pipeline entirely: no memory retrieval, no
   * contact/trust context, no session history, no persona system prompt. The
   * request messages and the optional custom system prompt are the whole
   * context. The model hint is pinned so a provider failure surfaces as an
   * error instead of silently falling back to the companion's chat model.
   */
  private async executeDirectModelCompletion(
    params: {
      requestId: string;
      request: ChatCompletionRequest;
      headers: ApiRpcHeaders;
      onDelta?: (text: string) => void | Promise<void>;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
    overrides: TurnRoutingOverrides,
  ): Promise<ApiChatCompletionRpcResult> {
    const modelOverride = overrides.modelOverride;
    const promptOverride = overrides.promptOverride;
    if (!modelOverride || !promptOverride) {
      return this.fail(500, 'internal_error', 'Direct model completion requires model and prompt overrides');
    }
    if (!this.llmProvider) {
      return this.fail(
        503,
        'direct_model_unavailable',
        'Direct model completions are unavailable because no LLM provider port is configured',
      );
    }

    const messages: ContextMessage[] = [];
    for (const message of params.request.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') {
        return this.fail(
          400,
          'invalid_request',
          'Direct model turns only accept user and assistant messages; use system_prompt_mode=custom with system_prompt for system instructions',
        );
      }
      const text = getMessageTextContent(message).trim();
      if (!text) continue;
      messages.push({ role: message.role, content: text });
    }
    if (!messages.some(message => message.role === 'user')) {
      return this.fail(400, 'invalid_request', 'Direct model turns require at least one non-empty user message');
    }

    const channelId = this.readHeader(params.headers, 'x-channel-id', 256)
      ?? `api:model-room:${params.requestId}`;
    const context: LLMContext = {
      systemPrompt: promptOverride.mode === 'custom' ? promptOverride.systemPrompt ?? '' : '',
      messages,
      modelHint: {
        provider: modelOverride.provider,
        model: modelOverride.model,
        pin: true,
        ...(modelOverride.maxTokens !== undefined ? { maxTokens: modelOverride.maxTokens } : {}),
      },
      correlation: {
        requestId: params.requestId,
        channelId,
        callType: 'chat',
        originType: 'chat',
        originStage: 'model_room.direct',
        purpose: 'model_room.direct',
      },
    };

    if (params.signal?.aborted) {
      return this.fail(499, 'request_cancelled', 'Direct model completion cancelled');
    }

    // Direct completions must stay cancellable: register in activeRequests so
    // cancelChatCompletion can find them, and pass the per-request AbortSignal
    // into the provider so cancellation can stop provider work.
    const abortController = new AbortController();
    const activeRequest: ActiveApiTurnRequest = {
      channelId,
      cancel: () => {
        if (abortController.signal.aborted) return { status: 'already_aborted' };
        abortController.abort();
        return { status: 'signaled' };
      },
    };
    const onExternalAbort = () => {
      void this.cancelActiveRequest(
        params.requestId,
        activeRequest,
        'client_disconnected',
      ).catch(error => log.error('Direct API cancellation reporting failed', {
        requestId: params.requestId,
        channelId,
        error: toErrorMessage(error),
      }));
    };
    if (params.signal) {
      if (params.signal.aborted) {
        abortController.abort();
      } else {
        params.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    this.activeRequests.set(params.requestId, activeRequest);
    const abortPromise = new Promise<never>((_, reject) => {
      const rejectCancelled = () => reject(new Error('api_chat_completion_cancelled'));
      if (abortController.signal.aborted) {
        rejectCancelled();
      } else {
        abortController.signal.addEventListener('abort', rejectCancelled, { once: true });
      }
    });

    const timeoutMs = this.normalizeChatCompletionTimeoutMs(params.timeoutMs);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // A transient provider empty_response (no text, no tool calls) is not a
    // terminal condition: retry the same candidate once before failing closed,
    // so a one-off provider blip does not surface as an indistinguishable 502.
    // Persistent empty content still fails closed with the original diagnostic.
    const maxAttempts = 2;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const completion = this.llmProvider.complete(context, 'reasoning', {
          signal: abortController.signal,
        });
        const response = timeoutMs === null
          ? await Promise.race([completion, abortPromise])
          : await Promise.race([
            completion,
            abortPromise,
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(new Error('api_chat_completion_timeout'));
                void this.cancelActiveRequest(
                  params.requestId,
                  activeRequest,
                  'timeout',
                ).catch(error => log.error('Direct API timeout cancellation reporting failed', {
                  requestId: params.requestId,
                  channelId,
                  error: toErrorMessage(error),
                }));
              }, timeoutMs);
              timeoutHandle.unref();
            }),
          ]);
        if (response.content && response.content.trim()) {
          // Direct completions do not stream; emit the full text as one delta so
          // SSE clients still receive content.
          await params.onDelta?.(response.content);
          return {
            ok: true,
            response: {
              content: response.content,
              channelId,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
            },
          };
        }
        if (attempt < maxAttempts) {
          log.warn('Direct model returned empty content; retrying once', {
            requestId: params.requestId,
            channelId,
            provider: modelOverride.provider,
            model: modelOverride.model,
            attempt,
          });
          // Cancel the settled attempt's timeout so it cannot fire during retry.
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          continue;
        }
        return this.fail(502, 'model_error', `Direct model ${modelOverride.provider}/${modelOverride.model} returned empty content`);
      }
      // Unreachable: the loop always returns on success or on the terminal
      // final-attempt empty. Fail closed if control ever escapes it.
      return this.fail(502, 'model_error', `Direct model ${modelOverride.provider}/${modelOverride.model} returned empty content`);
    } catch (error) {
      if (error instanceof Error && error.message === 'api_chat_completion_cancelled') {
        return this.fail(499, 'request_cancelled', 'Direct model completion cancelled');
      }
      if (error instanceof Error && error.message === 'api_chat_completion_timeout') {
        return this.fail(504, 'request_timeout', 'Direct model completion timed out');
      }
      return this.fail(502, 'model_error', `Direct model ${modelOverride.provider}/${modelOverride.model} failed: ${toErrorMessage(error)}`);
    } finally {
      if (params.signal) {
        params.signal.removeEventListener('abort', onExternalAbort);
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.activeRequests.delete(params.requestId);
    }
  }

  private fail(
    status: number,
    type: string,
    message: string,
    details?: Record<string, unknown>,
  ): ApiRpcFailure {
    return {
      ok: false,
      error: {
        status,
        type,
        message,
        ...(details ? { details } : {}),
      } satisfies ApiRuntimeError,
    };
  }

  private parseSchedulerHealthcheckStaleAfterMs(value: number | undefined): number {
    if (value !== undefined && Number.isFinite(value) && value >= 1_000) {
      return Math.floor(value);
    }
    return DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS;
  }

  private normalizeChatCompletionTimeoutMs(value: number | undefined): number | null {
    if (value === undefined) {
      return null;
    }
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.max(MIN_CHAT_COMPLETION_TIMEOUT_MS, Math.floor(value));
  }

  private attachTurnCleanup(releaseChannel: () => void, turnPromise: Promise<unknown>): void {
    turnPromise
      .catch(() => undefined)
      .finally(() => {
        releaseChannel();
      });
  }

  private observeTurnCompletion(messageId: string): ObservedTurnCompletion {
    let settled = false;
    let cleanup: () => void = () => {};
    let resolveCompletion: (response: AgentResponse) => void = () => {};
    let rejectCompletion: (error: unknown) => void = () => {};

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const promise = new Promise<AgentResponse>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const unsubscribeEnd = this.eventBus.on('agent.turn.end', ({ message, response }) => {
      if (message.id !== messageId) return;
      settle(() => resolveCompletion(response));
    });
    const unsubscribeError = this.eventBus.on('agent.error', ({ message, error }) => {
      if (message.id !== messageId) return;
      settle(() => rejectCompletion(error));
    });
    cleanup = () => {
      unsubscribeEnd();
      unsubscribeError();
    };

    return {
      promise,
      attachFallback: (turnPromise) => {
        void turnPromise.then(
          response => settle(() => resolveCompletion(response)),
          error => settle(() => rejectCompletion(error)),
        );
      },
      dispose: () => {
        if (settled) return;
        settled = true;
        cleanup();
      },
    };
  }

  private emitQueueTelemetry(
    channelId: string,
    phase: 'acquired' | 'contended' | 'released',
    details: { queueDepth: number; waitMs: number; reason?: string },
  ): void {
    emitTurnContentionTelemetry(this.eventBus, {
      channelId,
      phase,
      policy: 'queue',
      source: 'api',
      queueDepth: details.queueDepth,
      waitMs: details.waitMs,
      processingChannels: this.processingChannels.size,
      ...(details.reason ? { reason: details.reason } : {}),
    });
  }

  private async acquireChannel(
    channelId: string,
    traceId: string,
    signal: AbortSignal,
  ): Promise<(() => void) | null> {
    if (isAbortSignalAborted(signal)) return null;
    const queued = this.channelTurnLock.acquire(channelId);
    if (queued.contended) {
      this.emitQueueTelemetry(channelId, 'contended', {
        queueDepth: queued.queueDepth,
        waitMs: 0,
        reason: 'active_turn',
      });
    }

    const onAbort = () => rejectQueuedLease();
    let rejectQueuedLease: () => void = () => {};
    const aborted = new Promise<null>((resolve) => {
      rejectQueuedLease = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let lease: FifoChannelLease | null;
    try {
      lease = await Promise.race([queued.lease, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (lease === null) {
      if (!queued.cancel()) {
        const acquiredLease = await queued.lease;
        acquiredLease.release();
      }
      return null;
    }
    if (isAbortSignalAborted(signal)) {
      lease.release();
      return null;
    }
    const lockStartMs = Date.now();
    this.processingChannels.add(channelId);
    this.emitQueueTelemetry(channelId, 'acquired', {
      queueDepth: Math.max(0, this.channelTurnLock.pending(channelId) - 1),
      waitMs: lease.waitMs,
    });
    void emitTurnPerformance(this.eventBus, {
      traceId,
      requestId: traceId,
      channelId,
      channelType: 'api',
      stage: 'channel_queue_wait',
      durationMs: lease.waitMs,
      queueDepth: queued.queueDepth,
    }).catch(error => log.debug('API queue performance telemetry emit failed', {
      requestId: traceId,
      error: toErrorMessage(error),
    }));

    let released = false;
    return () => {
      if (released) return;
      released = true;
      lease.release();
      this.processingChannels.delete(channelId);
      this.emitQueueTelemetry(channelId, 'released', {
        queueDepth: this.channelTurnLock.pending(channelId),
        waitMs: Math.max(0, Date.now() - lockStartMs),
      });
    };
  }

  private abortActiveTurn(requestId: string, channelId: string): SubstrateAgentAbortResult {
    const result = this.agentLoop.abort(requestId);
    if (result.status === 'not_signaled') {
      log.error('API turn cancellation did not trip the active agent signal', { channelId });
    } else if (result.status !== 'signaled') {
      log.debug('API turn cancellation found no newly abortable parent run', {
        channelId,
        status: result.status,
      });
    }
    return result;
  }

  private deriveChannelId(headers: ApiRpcHeaders, principal: ApiAuthPrincipal): string {
    const sessionId = this.readHeader(headers, 'x-session-id', 128);
    if (sessionId) {
      return `api:${principal.id}:${sessionId}`;
    }
    return `api:${principal.id}`;
  }

  private seedSession(
    channelId: string,
    messages: ChatCompletionRequest['messages'],
    authorId: string,
    authorName: string,
    channelPrivacy?: ChannelPrivacy,
  ): void {
    const count = this.sessionManager.getMessageCount(channelId);
    if (count > 0) return;

    const prior = messages.slice(0, -1);
    for (const msg of prior) {
      const content = getMessageTextContent(msg);
      if (msg.role === 'user') {
        if (channelPrivacy) {
          this.sessionManager.recordUserMessage(
            channelId,
            content,
            authorId,
            msg.name ?? authorName,
            undefined,
            undefined,
            {
              channelMeta: { privacyLevel: channelPrivacy },
            },
          );
        } else {
          this.sessionManager.recordUserMessage(channelId, content, authorId, msg.name ?? authorName);
        }
      } else if (msg.role === 'assistant') {
        if (channelPrivacy) {
          this.sessionManager.recordAssistantMessage(
            channelId,
            content,
            undefined,
            undefined,
            undefined,
            {
              channelMeta: { privacyLevel: channelPrivacy },
            },
          );
        } else {
          this.sessionManager.recordAssistantMessage(channelId, content);
        }
      }
    }
  }

  private resolveChannelPrivacy(headers: ApiRpcHeaders): ChannelPrivacyResolution | ChannelPrivacyError {
    const rawValue = this.readHeader(headers, 'x-channel-privacy', 64);
    if (!rawValue) {
      return { ok: true };
    }
    if (!isChannelPrivacy(rawValue)) {
      return {
        ok: false,
        error: `X-Channel-Privacy must be one of: ${CHANNEL_PRIVACY_VALUES.join(', ')}`,
      };
    }
    return { ok: true, value: rawValue };
  }

  private deriveAuthor(principal: ApiAuthPrincipal): { authorId: string; authorName: string } {
    return {
      authorId: principal.id,
      authorName: principal.mode === 'api_key' ? 'API Principal' : 'Local API Principal',
    };
  }

  private getLastUserMessage(messages: ChatCompletionRequest['messages']): string {
    return getChatLastUserMessage(messages);
  }

  private parseTurnRoutingOverrides(
    request: ChatCompletionRequest,
  ): { ok: true; value: TurnRoutingOverrides } | { ok: false; error: string } {
    const provider = typeof request.provider === 'string'
      ? request.provider.trim().toLowerCase()
      : '';
    const model = typeof request.model === 'string'
      ? request.model.trim()
      : '';

    let modelOverride: MessageModelOverride | undefined;
    if (provider) {
      if (!model) {
        return { ok: false, error: 'provider override requires a non-empty model field' };
      }
      if (!DIRECT_PROVIDER_OVERRIDE_ALLOWLIST.has(provider)) {
        return {
          ok: false,
          error: `provider override must be one of ${Array.from(DIRECT_PROVIDER_OVERRIDE_ALLOWLIST).join(', ')}`,
        };
      }

      const maxTokens = typeof request.max_tokens === 'number' && Number.isFinite(request.max_tokens)
        ? Math.max(1, Math.trunc(request.max_tokens))
        : undefined;

      modelOverride = {
        provider,
        model,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
    }

    const modeRaw = typeof request.system_prompt_mode === 'string'
      ? request.system_prompt_mode.trim().toLowerCase()
      : '';
    const systemPrompt = typeof request.system_prompt === 'string'
      ? request.system_prompt.trim()
      : '';

    let promptOverride: MessagePromptOverride | undefined;
    if (!modeRaw && modelOverride) {
      promptOverride = { mode: 'none' };
    } else if (modeRaw) {
      if (modeRaw !== 'default' && modeRaw !== 'none' && modeRaw !== 'custom') {
        return { ok: false, error: 'system_prompt_mode must be one of: default, none, custom' };
      }
      if (modeRaw === 'custom') {
        if (!systemPrompt) {
          return { ok: false, error: 'system_prompt is required when system_prompt_mode=custom' };
        }
        promptOverride = { mode: 'custom', systemPrompt };
      } else if (modeRaw === 'none') {
        promptOverride = { mode: 'none' };
      }
    }

    const responseStyleRaw = typeof request.response_style === 'string'
      ? request.response_style.trim().toLowerCase()
      : '';
    let responseStyle: ResponseStyle | undefined;
    if (responseStyleRaw) {
      if (responseStyleRaw !== 'concise' && responseStyleRaw !== 'expressive') {
        return { ok: false, error: 'response_style must be one of: concise, expressive' };
      }
      responseStyle = responseStyleRaw;
    }

    return {
      ok: true,
      value: {
        ...(modelOverride ? { modelOverride } : {}),
        ...(promptOverride ? { promptOverride } : {}),
        ...(responseStyle ? { responseStyle } : {}),
      },
    };
  }

  private readIdentityClaimHeaders(headers: ApiRpcHeaders): IdentityClaimHeaders | null {
    const canonicalContactId = this.readHeader(headers, IDENTITY_CLAIM_HEADERS.canonicalContactId, 128);
    if (!canonicalContactId) return null;

    return {
      canonicalContactId,
      sourceChannel: this.readHeader(headers, IDENTITY_CLAIM_HEADERS.sourceChannel, 64) ?? '',
      sourceUserId: this.readHeader(headers, IDENTITY_CLAIM_HEADERS.sourceUserId, 256) ?? '',
      nonce: this.readHeader(headers, IDENTITY_CLAIM_HEADERS.nonce, 128),
      expiresAt: this.readHeader(headers, IDENTITY_CLAIM_HEADERS.expires, 64),
      signature: this.readHeader(headers, IDENTITY_CLAIM_HEADERS.signature, 256),
    };
  }

  private challengePayload(
    claim: IdentityClaimHeaders,
    authorId: string,
    challenge: { nonce: string; expiresAt: string; signature: string },
  ): Record<string, unknown> {
    return {
      canonicalContactId: claim.canonicalContactId,
      sourceChannel: claim.sourceChannel,
      sourceUserId: claim.sourceUserId,
      targetChannel: 'api',
      targetUserId: authorId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      requiredHeaders: {
        canonicalContactId: 'X-Canonical-Contact-ID',
        sourceChannel: 'X-Identity-Claim-Channel',
        sourceUserId: 'X-Identity-Claim-User-ID',
        nonce: 'X-Identity-Claim-Nonce',
        expiresAt: 'X-Identity-Claim-Expires',
        signature: 'X-Identity-Claim-Signature',
      },
    };
  }

  private async enforceIdentityClaim(
    headers: ApiRpcHeaders,
    authorId: string,
  ): Promise<true | ApiRpcFailure> {
    const claim = this.readIdentityClaimHeaders(headers);
    if (!claim) return true;

    if (!this.contactStore) {
      return this.fail(
        503,
        'identity_claim_unavailable',
        'Identity claim verification is unavailable because contact store is not configured',
      );
    }

    if (!claim.sourceChannel || !claim.sourceUserId) {
      return this.fail(
        400,
        'invalid_identity_claim',
        'X-Identity-Claim-Channel and X-Identity-Claim-User-ID are required when claiming a canonical contact',
      );
    }

    const hasCompleteVerificationHeaders = Boolean(claim.nonce && claim.expiresAt && claim.signature);
    const existingApiIdentity = await this.contactStore.getByChannelIdentity('api', authorId);
    if (existingApiIdentity?.id === claim.canonicalContactId && !hasCompleteVerificationHeaders) {
      return true;
    }
    if (existingApiIdentity && existingApiIdentity.id !== claim.canonicalContactId) {
      return this.fail(
        409,
        'identity_claim_conflict',
        `API identity api:${authorId} is already linked to another canonical contact`,
      );
    }

    if (!claim.nonce || !claim.expiresAt || !claim.signature) {
      const challengeResult = await this.contactStore.createIdentityLinkChallenge({
        contactId: claim.canonicalContactId,
        sourceChannel: claim.sourceChannel,
        sourceUserId: claim.sourceUserId,
        targetChannel: 'api',
        targetUserId: authorId,
        ttlMs: IDENTITY_LINK_CHALLENGE_TTL_MS,
      });

      switch (challengeResult.status) {
        case 'challenge_created':
        case 'pending_exists':
          return this.fail(
            428,
            'identity_verification_required',
            'Identity claim requires challenge verification headers',
            { verification: this.challengePayload(claim, authorId, challengeResult.verification) },
          );
        case 'already_linked':
          return true;
        case 'contact_not_found':
          return this.fail(
            404,
            'identity_claim_contact_not_found',
            `Canonical contact ${claim.canonicalContactId} was not found`,
          );
        case 'source_identity_not_linked':
          return this.fail(
            403,
            'identity_claim_source_not_linked',
            `${claim.sourceChannel}:${claim.sourceUserId} is not linked to canonical contact ${claim.canonicalContactId}`,
          );
        case 'identity_conflict':
          return this.fail(
            409,
            'identity_claim_conflict',
            `API identity api:${authorId} is already linked to a different canonical contact`,
          );
        default:
          return this.fail(400, 'invalid_identity_claim', 'Unable to create identity claim challenge');
      }
    }

    const verificationResult = await this.contactStore.verifyIdentityLinkChallenge({
      contactId: claim.canonicalContactId,
      sourceChannel: claim.sourceChannel,
      sourceUserId: claim.sourceUserId,
      targetChannel: 'api',
      targetUserId: authorId,
      nonce: claim.nonce,
      expiresAt: claim.expiresAt,
      signature: claim.signature,
    });

    switch (verificationResult.status) {
      case 'linked':
      case 'already_linked':
        return true;
      case 'verification_not_found':
        return this.fail(
          428,
          'identity_verification_required',
          'Identity claim challenge not found. Request a fresh challenge and retry with the returned headers.',
        );
      case 'verification_replayed':
        return this.fail(409, 'identity_verification_replayed', 'Identity claim challenge has already been used');
      case 'verification_expired':
        return this.fail(410, 'identity_verification_expired', 'Identity claim challenge has expired');
      case 'invalid_signature':
        return this.fail(401, 'identity_verification_invalid_signature', 'Identity claim signature did not match challenge');
      case 'claim_mismatch':
        return this.fail(403, 'identity_verification_claim_mismatch', 'Identity claim payload did not match the issued challenge');
      case 'source_identity_not_linked':
        return this.fail(
          403,
          'identity_claim_source_not_linked',
          `${claim.sourceChannel}:${claim.sourceUserId} is not linked to canonical contact ${claim.canonicalContactId}`,
        );
      case 'identity_conflict':
        return this.fail(
          409,
          'identity_claim_conflict',
          `API identity api:${authorId} is already linked to a different canonical contact`,
        );
      case 'contact_not_found':
        return this.fail(
          404,
          'identity_claim_contact_not_found',
          `Canonical contact ${claim.canonicalContactId} was not found`,
        );
      default:
        return this.fail(400, 'invalid_identity_claim', 'Unable to verify identity claim');
    }
  }

  private verifyCompanionUiCapability(params: {
    request: ChatCompletionRequest;
    principal: ApiAuthPrincipal;
    headers: ApiRpcHeaders;
    clientCert?: SatelliteClientCertIdentity;
    hubDevicePrincipal?: HubDevicePrincipalSnapshot;
    hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
    companionUiCapability?: ApiChatCompletionRpcParams['companionUiCapability'];
  }): ApiRpcFailure | undefined {
    const capability = params.companionUiCapability;
    if (!capability) return undefined;
    if (!params.hubDevicePrincipal || !params.hubDeviceAttachment
      || !this.requestCapabilityVerifier || !this.companionId) {
      return this.fail(403, 'companion_ui_capability_denied', 'Companion UI child capability was denied');
    }
    try {
      const compiled = this.compileVerifiedCompanionUiCapability({
        principal: params.principal,
        headers: params.headers,
        ...(params.clientCert ? { clientCert: params.clientCert } : {}),
        companionUiCapability: capability,
      });
      if (compiled.frame.resource !== 'conversation.interact'
        && compiled.frame.resource !== 'conversation.audio'
        && compiled.frame.resource !== 'conversation.touch') {
        throw new Error('non-agent Companion UI action');
      }
      const exactContent = companionUiPromptContent(compiled.frame);
      if (typeof exactContent !== 'string'
        || params.request.messages.length !== 1
        || params.request.messages[0]?.role !== 'user'
        || params.request.messages[0].content !== exactContent
        || params.request.tools !== undefined
        || params.request.tool_choice !== undefined
        || params.request.user !== undefined) {
        throw new Error('agent prompt does not match signed UI body');
      }
    } catch {
      return this.fail(403, 'companion_ui_capability_denied', 'Companion UI child capability was denied');
    }
    return undefined;
  }

  private compileVerifiedCompanionUiCapability(params: Readonly<{
    principal: ApiAuthPrincipal;
    headers: ApiRpcHeaders;
    clientCert?: SatelliteClientCertIdentity;
    companionUiCapability: NonNullable<ApiChatCompletionRpcParams['companionUiCapability']>;
    hubDevicePrincipal?: HubDevicePrincipalSnapshot;
    hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
  }>): CompiledCompanionUiAction {
    if (!this.requestCapabilityVerifier || !this.companionId) {
      throw new Error('Companion UI verifier unavailable');
    }
    const capability = params.companionUiCapability;
    const rawBody = Buffer.from(capability.rawBodyBase64Url, 'base64url');
    if (rawBody.toString('base64url') !== capability.rawBodyBase64Url) {
      throw new Error('non-canonical body');
    }
    const satellite = resolveSatelliteClaim({
      headers: params.headers,
      principal: params.principal,
      registry: this.satelliteRegistry,
      ...(params.clientCert ? { clientCert: params.clientCert } : {}),
    });
    if (!satellite.ok) throw new Error('satellite authority denied');
    if (params.hubDevicePrincipal || params.hubDeviceAttachment) {
      const principal = params.hubDevicePrincipal;
      const attachment = params.hubDeviceAttachment;
      const enrollment = this.satelliteRegistry?.satellites
        .find(candidate => candidate.satelliteId === satellite.value.satellite.satelliteId)
        ?.endpoints.find(
          candidate => candidate.endpointId === satellite.value.satellite.endpointId,
        )?.hubDeviceEnrollment;
      if (!principal || !attachment || !enrollment
        || enrollment.enrollmentStatus !== 'active'
        || principal.deviceId !== enrollment.deviceId
        || principal.enrollmentVersion !== enrollment.enrollmentVersion
        || principal.sessionId !== satellite.value.satellite.sessionId
        || principal.placeId !== satellite.value.satellite.placeId
        || !sameHubDevicePrincipal(attachment.deviceActor.principal, principal)) {
        throw new Error('hub-device authority changed');
      }
    }
    const compiled = compileCompanionUiAction(
      rawBody,
      this.companionId as CompanionId,
      {
        capabilities: satellite.value.satellite.capabilities.effective,
        telemetryScopes: satellite.value.satellite.telemetryScopes,
      },
    );
    this.requestCapabilityVerifier.verifyAgent({
      token: capability.token,
      target: compiled.target,
      requestId: capability.requestId,
      decisionId: capability.decisionId,
      versions: capability.versions,
      parent: capability.parent,
    });
    return compiled;
  }

  private buildSubstrateMessage(params: {
    requestId: string;
    channelId: string;
    channelType: ChannelType;
    source: NonNullable<MessageRoutingMetadata['source']>;
    content: string;
    authorId: string;
    authorName: string;
    headers: ApiRpcHeaders;
    overrides: TurnRoutingOverrides;
    channelPrivacy?: ChannelPrivacy;
    canonicalContactId?: string;
    satellite?: SatelliteRoutingMetadata;
    hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
    attachments?: Attachment[];
    /** Intake-firewall snapshots for the body and screened document attachments. */
    intakeEnvelopes?: IntakeEnvelopeSnapshot[];
  }): SubstrateMessage {
    const approvalToken = this.readHeader(params.headers, 'x-broadcast-approval-token', 256);
    const requestedScope = this.readHeader(params.headers, 'x-broadcast-visibility-scope', 64);
    const visibilityScope = requestedScope === 'public_only' || requestedScope === 'approved_private_context'
      ? requestedScope
      : undefined;
    const routing: MessageRoutingMetadata = {
      source: params.source,
      ...(approvalToken || visibilityScope
        ? {
          broadcast: {
            ...(approvalToken ? { approvalToken } : {}),
            ...(visibilityScope ? { visibilityScope } : {}),
          },
        }
        : {}),
      ...(params.satellite ? { satellite: params.satellite } : {}),
      ...(params.hubDeviceAttachment ? { hubDeviceAttachment: params.hubDeviceAttachment } : {}),
      ...(params.channelPrivacy ? { channelPrivacy: params.channelPrivacy } : {}),
      ...(params.overrides.modelOverride ? { modelOverride: params.overrides.modelOverride } : {}),
      ...(params.overrides.promptOverride ? { promptOverride: params.overrides.promptOverride } : {}),
      ...(params.overrides.responseStyle ? { responseStyle: params.overrides.responseStyle } : {}),
      ...(params.canonicalContactId ? { canonicalContactId: params.canonicalContactId } : {}),
      ...(params.intakeEnvelopes && params.intakeEnvelopes.length > 0
        ? { intakeEnvelopes: params.intakeEnvelopes }
        : {}),
    };
    const hasRouting = params.source !== 'api'
      || routing.broadcast
      || routing.satellite
      || routing.hubDeviceAttachment
      || routing.channelPrivacy
      || routing.modelOverride
      || routing.promptOverride
      || routing.responseStyle
      || routing.canonicalContactId
      || routing.intakeEnvelopes;

    return {
      id: params.requestId,
      channelId: params.channelId,
      channelType: params.channelType,
      authorId: params.authorId,
      authorName: params.authorName,
      content: params.content,
      ...(params.channelPrivacy === 'public' ? { isDirectMessage: false } : {}),
      ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
      ...(hasRouting ? { routing } : {}),
      timestamp: new Date(),
    };
  }

  private async prepareTurn(
    requestId: string,
    request: ChatCompletionRequest,
    headers: ApiRpcHeaders,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
    hubDevicePrincipal: HubDevicePrincipalSnapshot | undefined,
    hubDeviceAttachment: HubDeviceAttachmentSnapshot | undefined,
    signal: AbortSignal,
    onChannelResolved: (channelId: string) => void,
  ): Promise<{ ok: true; value: PendingTurn } | { ok: false; error: ApiRpcFailure }> {
    if (isAbortSignalAborted(signal)) {
      return {
        ok: false,
        error: this.fail(499, 'request_cancelled', 'Request cancelled before turn started'),
      };
    }
    const routingOverrides = this.parseTurnRoutingOverrides(request);
    if (!routingOverrides.ok) {
      return { ok: false, error: this.fail(400, 'invalid_request', routingOverrides.error) };
    }

    const channelPrivacy = this.resolveChannelPrivacy(headers);
    if (!channelPrivacy.ok) {
      return { ok: false, error: this.fail(400, 'invalid_request', channelPrivacy.error) };
    }

    const defaultChannelId = this.deriveChannelId(headers, principal);
    const defaultAuthor = this.deriveAuthor(principal);
    const turnIdentity = resolveApiTurnIdentity({
      headers,
      principal,
      defaultChannelId,
      defaultAuthorId: defaultAuthor.authorId,
      defaultAuthorName: defaultAuthor.authorName,
      externalChannelProfiles: this.externalChannelProfiles,
      satelliteRegistry: this.satelliteRegistry,
      ...(clientCert ? { clientCert } : {}),
    });
    if (!turnIdentity.ok) {
      return {
        ok: false,
        error: this.fail(turnIdentity.status, turnIdentity.type, turnIdentity.message),
      };
    }

    let {
      channelId,
      channelType,
      authorId,
      authorName,
      source,
      channelPrivacy: claimedChannelPrivacy,
      canonicalContactId: claimedCanonicalContactId,
      satellite,
    } = turnIdentity.value;
    let hubDeviceCanonicalContactId: string | undefined;

    if (hubDevicePrincipal) {
      if (!satellite) {
        return {
          ok: false,
          error: this.fail(403, 'hub_device_principal_mismatch', 'Hub device principal did not match the server registry binding'),
        };
      }
      const currentSatellite = satellite;
      const enrollment = this.satelliteRegistry?.satellites
        .find(candidate => candidate.satelliteId === currentSatellite.satelliteId)
        ?.endpoints.find(candidate => candidate.endpointId === currentSatellite.endpointId)
        ?.hubDeviceEnrollment;
      if (!enrollment
        || !this.companionId
        || !isHubDevicePrincipalSnapshot(hubDevicePrincipal)
        || !isHubDeviceAttachmentSnapshot(hubDeviceAttachment)
        || !sameHubDevicePrincipal(hubDeviceAttachment.deviceActor.principal, hubDevicePrincipal)
        || hubDeviceAttachment.channel.companionId !== this.companionId
        || hubDeviceAttachment.actor.companionId !== this.companionId
        || enrollment.enrollmentStatus !== 'active'
        || hubDevicePrincipal.companionId !== this.companionId
        || hubDevicePrincipal.deviceId !== enrollment.deviceId
        || hubDevicePrincipal.enrollmentVersion !== enrollment.enrollmentVersion
        || hubDevicePrincipal.sessionId !== currentSatellite.sessionId
        || hubDevicePrincipal.placeId !== currentSatellite.placeId
        ) {
        return {
          ok: false,
          error: this.fail(403, 'hub_device_principal_mismatch', 'Hub device principal did not match the server registry binding'),
        };
      }
      channelId = hubDeviceAttachment.channel.id;
      // 8ora: a validated hub-device attachment is the server-side proof that
      // this turn originated from the companion-ui PWA (relayed through the
      // satellite hub). Classify it as the first-class `companion-ui` channel
      // here — origin is decided by the authenticated attachment, never by a
      // client-supplied X-PSFN-Channel-Type header (the hub is a read-only
      // vendored dependency and cannot send new headers this wave). If a future
      // hub revision emits a signed channel-type claim, it could replace this
      // attachment-derived classification without changing the downstream stamp.
      channelType = 'companion-ui';
      source = 'companion-ui';
      // Server-authored privacy for the 1:1 human↔companion surface. Sourced
      // from the operator-owned companionUi profile (channels.json), defaulting
      // to `private`; browser-supplied privacy headers are forbidden upstream.
      claimedChannelPrivacy = this.externalChannelProfiles['companion-ui']?.channelPrivacy ?? 'private';
      if (hubDeviceAttachment.actor.kind === 'human') {
        authorId = hubDeviceAttachment.actor.principalId;
        authorName = 'Authenticated cluster human';
        // A Discord-SSO'd human binds to their existing canonical contact via
        // the attachment's validated contact binding — never minted as a new
        // person or an api principal. `isHubDeviceAttachmentSnapshot` (checked
        // above) guarantees a non-empty contactId, so this is fail-closed.
        hubDeviceCanonicalContactId = hubDeviceAttachment.actor.contact.contactId;
      } else {
        authorId = `hub-device-guest:${hubDevicePrincipal.deviceId}`;
        authorName = 'Hub device guest';
      }
      claimedCanonicalContactId = hubDeviceCanonicalContactId;
      satellite = { ...satellite, hubDevicePrincipal };
    }
    onChannelResolved(channelId);

    if (!hubDevicePrincipal) {
      const identityClaim = await this.enforceIdentityClaim(headers, authorId);
      if (identityClaim !== true) {
        return { ok: false, error: identityClaim };
      }
    }

    if (isAbortSignalAborted(signal)) {
      return {
        ok: false,
        error: this.fail(499, 'request_cancelled', 'Request cancelled before turn started'),
      };
    }

    const canonicalContactId = hubDevicePrincipal
      ? hubDeviceCanonicalContactId
      : this.readHeader(headers, 'x-canonical-contact-id', 256) ?? claimedCanonicalContactId;
    const resolvedChannelPrivacy = channelPrivacy.value ?? claimedChannelPrivacy;
    if (source !== 'api' && !hubDevicePrincipal) {
      if (!canonicalContactId) {
        return {
          ok: false,
          error: this.fail(503, 'external_channel_not_configured', 'External channel claims require a canonical contact mapping'),
        };
      }
      if (!resolvedChannelPrivacy) {
        return {
          ok: false,
          error: this.fail(503, 'external_channel_not_configured', 'External channel claims require a configured channel privacy level'),
        };
      }
    }

    const lastUserAttachments = getLastUserMessageAttachments(request.messages);
    const screenedBody = await screenChatMessageBody({
      content: this.getLastUserMessage(request.messages),
      screening: this.documentIngest?.intakeScreening,
      sourceClass: source === 'api'
        ? 'primary_user'
        : resolvedChannelPrivacy === 'public' || hubDeviceAttachment?.actor.kind === 'guest'
          ? 'public_contact'
          : 'regular_contact',
      surface: 'api',
      channelId,
      messageId: requestId,
      ...(canonicalContactId ? { canonicalContactId } : {}),
    });
    // htm9.9: `file` content parts run the shared file-ingest pipeline
    // (quarantine -> parse -> intake screening) before prompt assembly.
    const ingestedFiles = await ingestApiDocumentFileParts({
      extraction: getLastUserMessageFileParts(request.messages),
      content: screenedBody.content,
      channelId,
      messageId: `api-file-${randomUUID()}`,
      authorId,
      attachmentIndexBase: lastUserAttachments.length,
      documentIngest: this.documentIngest,
    });
    if (signal.aborted) {
      return {
        ok: false,
        error: this.fail(499, 'request_cancelled', 'Request cancelled before turn started'),
      };
    }
    const substrateMsg = this.buildSubstrateMessage({
      requestId,
      channelId,
      channelType,
      source,
      content: ingestedFiles.content,
      authorId,
      authorName,
      headers,
      overrides: routingOverrides.value,
      channelPrivacy: resolvedChannelPrivacy,
      canonicalContactId,
      satellite,
      ...(hubDeviceAttachment ? { hubDeviceAttachment } : {}),
      attachments: [...lastUserAttachments, ...ingestedFiles.attachments],
      intakeEnvelopes: [
        ...(screenedBody.snapshot ? [screenedBody.snapshot] : []),
        ...ingestedFiles.intakeEnvelopes,
      ],
    });
    const releaseChannel = await this.acquireChannel(channelId, requestId, signal);
    if (!releaseChannel) {
      return {
        ok: false,
        error: this.fail(499, 'request_cancelled', 'Request cancelled before turn started'),
      };
    }
    try {
      // Session seeding is a mutation. Keep it behind queue admission so an
      // abandoned request cannot leave conversation residue while waiting for
      // another turn to finish.
      this.seedSession(channelId, request.messages, authorId, authorName, resolvedChannelPrivacy);
    } catch (error) {
      releaseChannel();
      throw error;
    }
    return {
      ok: true,
      value: {
        channelId,
        releaseChannel,
        substrateMsg,
      },
    };
  }

  private readHeader(headers: ApiRpcHeaders, name: string, maxLength: number): string | undefined {
    const direct = headers[name];
    return clampHeaderValue(
      firstHeaderValue(typeof direct === 'string' ? direct : undefined),
      maxLength,
    );
  }
}
