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
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createEventBusSensorIngestPort, type SensorIngestPort } from '../../shared/telemetry/sensor-ingest-port.js';
import type { SessionManager } from '../../core/session/manager.js';
import { isChannelPrivacy, type ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiHealthRpcResult,
  ApiRpcFailure,
  ApiRpcHeaders,
  ApiRuntimeChatRequest,
  ApiRuntimeError,
  ApiServerHealthChecks,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
  ChatCompletionRequest,
  TelemetryIngestResponse,
} from './types.js';
import {
  getLastUserMessage as getChatLastUserMessage,
  getLastUserMessageAttachments,
  getMessageTextContent,
} from './server/session.js';
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

const DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS = 65 * 60_000;
const IDENTITY_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const DIRECT_PROVIDER_OVERRIDE_ALLOWLIST = new Set(['anthropic', 'openai', 'google']);
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

interface ActiveRequestState {
  channelId: string;
  /** Direct model-room completions abort via their own controller instead of the agent loop. */
  abort?: () => void;
}

interface ObservedTurnCompletion {
  promise: Promise<AgentResponse>;
  attachFallback(turnPromise: Promise<AgentResponse>): void;
  dispose(): void;
}

export interface AgentApiBackendConfig {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  sessionManager: SessionManager;
  /** Required for direct (raw) model completions that bypass the companion turn pipeline. */
  llmProvider?: LLMProviderPort;
  contactStore?: ContactStorePort;
  healthChecks?: ApiServerHealthChecks;
  schedulerHealthcheckStaleAfterMs?: number;
  externalChannelProfiles?: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  satelliteRegistry?: SatelliteRegistryConfig;
  sensorIngest?: SensorIngestPort;
  onStreamDelta?: (requestId: string, text: string) => void | Promise<void>;
}

export class AgentApiBackend {
  private readonly agentLoop: SubstrateAgent;
  private readonly eventBus: EventBus;
  private readonly sessionManager: SessionManager;
  private readonly llmProvider: LLMProviderPort | null;
  private readonly contactStore: ContactStorePort | null;
  private readonly healthChecks: ApiServerHealthChecks;
  private readonly schedulerHealthcheckStaleAfterMs: number;
  private readonly externalChannelProfiles: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  private readonly satelliteRegistry: SatelliteRegistryConfig | undefined;
  private readonly sensorIngest: SensorIngestPort;
  private readonly onStreamDelta?: (requestId: string, text: string) => void | Promise<void>;
  private readonly channelTurnLock = new FifoChannelLock();
  private readonly processingChannels = new Set<string>();
  private readonly activeRequests = new Map<string, ActiveRequestState>();
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
    this.sensorIngest = config.sensorIngest ?? createEventBusSensorIngestPort(config.eventBus);
    this.onStreamDelta = config.onStreamDelta;
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
      return { cancelled: false };
    }
    if (active.abort) {
      active.abort();
      this.eventBus.emit('api.turn.abort', {
        channelId: active.channelId,
        reason: 'client_disconnected',
      }).catch(() => undefined);
      return { cancelled: true };
    }
    this.abortActiveTurn(active.channelId, 'client_disconnected');
    return { cancelled: true };
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
      timeoutMs: params.timeoutMs,
      onDelta: params.request.stream && this.onStreamDelta
        ? (text) => this.onStreamDelta?.(params.requestId, text)
        : undefined,
    });
  }

  async runChatCompletion(input: ApiRuntimeChatRequest): Promise<ApiChatCompletionRpcResult> {
    return await this.executeChatCompletion({
      requestId: `api-local-${randomUUID()}`,
      request: input.request,
      principal: input.principal,
      headers: input.headers,
      clientCert: input.clientCert,
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
    onDelta?: (text: string) => void | Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<ApiChatCompletionRpcResult> {
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

    const pendingTurn = await this.prepareTurn(
      params.request,
      params.headers,
      params.principal,
      params.clientCert,
    );
    if (!pendingTurn.ok) {
      return pendingTurn.error;
    }

    this.activeRequests.set(params.requestId, { channelId: pendingTurn.value.channelId });
    const unsubscribe = params.onDelta
      ? this.eventBus.on('agent.stream.delta', (data) => {
        if (data.channelId !== pendingTurn.value.channelId) return;
        void Promise.resolve(params.onDelta?.(data.text));
      })
      : () => {};

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

    const turnCompletion = this.observeTurnCompletion(pendingTurn.value.substrateMsg.id);
    const turnPromise = this.agentLoop.handleMessage(pendingTurn.value.substrateMsg);
    turnCompletion.attachFallback(turnPromise);
    this.attachTurnCleanup(pendingTurn.value.releaseChannel, turnPromise);
    const timeoutMs = this.normalizeChatCompletionTimeoutMs(params.timeoutMs);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const turnTimeoutPromise = timeoutMs === null
      ? null
      : new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          this.abortActiveTurn(pendingTurn.value.channelId, 'timeout');
          reject(new Error('api_chat_completion_timeout'));
        }, timeoutMs);
        timeoutHandle.unref();
      });

    try {
      const response = await (
        turnTimeoutPromise
          ? Promise.race([turnCompletion.promise, turnTimeoutPromise])
          : turnCompletion.promise
      );
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
      turnCompletion.dispose();
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
    const onExternalAbort = () => abortController.abort();
    if (params.signal) {
      if (params.signal.aborted) {
        abortController.abort();
      } else {
        params.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    this.activeRequests.set(params.requestId, {
      channelId,
      abort: () => abortController.abort(),
    });
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
    try {
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
            }, timeoutMs);
            timeoutHandle.unref();
          }),
        ]);
      if (!response.content || !response.content.trim()) {
        return this.fail(502, 'model_error', `Direct model ${modelOverride.provider}/${modelOverride.model} returned empty content`);
      }
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

  private async acquireChannel(channelId: string): Promise<() => void> {
    const queued = this.channelTurnLock.acquire(channelId);
    if (queued.contended) {
      this.emitQueueTelemetry(channelId, 'contended', {
        queueDepth: queued.queueDepth,
        waitMs: 0,
        reason: 'active_turn',
      });
    }

    const lease: FifoChannelLease = await queued.lease;
    const lockStartMs = Date.now();
    this.processingChannels.add(channelId);
    this.emitQueueTelemetry(channelId, 'acquired', {
      queueDepth: Math.max(0, this.channelTurnLock.pending(channelId) - 1),
      waitMs: lease.waitMs,
    });

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

  private abortActiveTurn(channelId: string, reason: 'timeout' | 'client_disconnected'): void {
    const maybeAbortable = this.agentLoop as unknown as { abort?: () => void };
    if (typeof maybeAbortable.abort !== 'function') return;
    try {
      maybeAbortable.abort();
      this.eventBus.emit('api.turn.abort', { channelId, reason }).catch(() => undefined);
    } catch {
      // Best-effort abort only.
    }
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
        error: 'X-Channel-Privacy must be one of: private, invite_only, public, broadcast',
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

  private buildSubstrateMessage(params: {
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
    attachments?: Attachment[];
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
      ...(params.channelPrivacy ? { channelPrivacy: params.channelPrivacy } : {}),
      ...(params.overrides.modelOverride ? { modelOverride: params.overrides.modelOverride } : {}),
      ...(params.overrides.promptOverride ? { promptOverride: params.overrides.promptOverride } : {}),
      ...(params.overrides.responseStyle ? { responseStyle: params.overrides.responseStyle } : {}),
      ...(params.canonicalContactId ? { canonicalContactId: params.canonicalContactId } : {}),
    };
    const hasRouting = params.source !== 'api'
      || routing.broadcast
      || routing.satellite
      || routing.channelPrivacy
      || routing.modelOverride
      || routing.promptOverride
      || routing.responseStyle
      || routing.canonicalContactId;

    return {
      id: `api-${randomUUID()}`,
      channelId: params.channelId,
      channelType: params.channelType,
      authorId: params.authorId,
      authorName: params.authorName,
      content: params.content,
      ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
      ...(hasRouting ? { routing } : {}),
      timestamp: new Date(),
    };
  }

  private async prepareTurn(
    request: ChatCompletionRequest,
    headers: ApiRpcHeaders,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
  ): Promise<{ ok: true; value: PendingTurn } | { ok: false; error: ApiRpcFailure }> {
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

    const {
      channelId,
      channelType,
      authorId,
      authorName,
      source,
      channelPrivacy: claimedChannelPrivacy,
      canonicalContactId: claimedCanonicalContactId,
      satellite,
    } = turnIdentity.value;

    const identityClaim = await this.enforceIdentityClaim(headers, authorId);
    if (identityClaim !== true) {
      return { ok: false, error: identityClaim };
    }

    const canonicalContactId = this.readHeader(headers, 'x-canonical-contact-id', 256) ?? claimedCanonicalContactId;
    const resolvedChannelPrivacy = channelPrivacy.value ?? claimedChannelPrivacy;
    if (source !== 'api') {
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

    const substrateMsg = this.buildSubstrateMessage({
      channelId,
      channelType,
      source,
      content: this.getLastUserMessage(request.messages),
      authorId,
      authorName,
      headers,
      overrides: routingOverrides.value,
      channelPrivacy: resolvedChannelPrivacy,
      canonicalContactId,
      satellite,
      attachments: getLastUserMessageAttachments(request.messages),
    });
    this.seedSession(channelId, request.messages, authorId, authorName, resolvedChannelPrivacy);

    const releaseChannel = await this.acquireChannel(channelId);
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
