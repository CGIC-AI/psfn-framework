// ── OpenAI-compatible API Server ──
// Exposes GET /v1/models and POST /v1/chat/completions.
// Uses Node.js built-in http module — no framework dependency.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ChannelType, MessageModelOverride, MessagePromptOverride, MessageRoutingMetadata, ResponseStyle, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { EventBus, ExternalTelemetryEvent } from '../../shared/event-bus.js';
import {
  createEventBusSensorIngestPort,
  type SensorIngestPort,
} from '../../shared/telemetry/sensor-ingest-port.js';
import type { SessionManager } from '../../core/session/manager.js';
import { isChannelVisibility, type ChannelVisibility } from '../../system/trust/types.js';
import type {
  ChannelAdapterPort,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  OutboundContext,
} from '../backplane/types.js';
import type {
  ApiContinuityWatchdogCheck,
  ApiHealthResponse,
  ApiHealthSubsystem,
  ApiHealthSubsystemStatus,
  ApiRuntimeChatRequest,
  ApiServerHealthChecks,
  ApiServerRuntime,
  ChatCompletionRequest,
  ChatCompletionChunk,
  TelemetryIngestRequest,
  TelemetryIngestResponse,
} from './types.js';
import { API_CONTINUITY_WATCHDOG_CHECKS, API_HEALTH_SUBSYSTEMS } from './types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { type ApiAuthPrincipal } from '../backplane/http/auth.js';
import {
  ApiVoiceWebSocketAdapter,
  type VoiceWebSocketRuntime,
  type VoiceWebSocketRuntimeHooks,
} from './voice-websocket.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  readJsonBodyWithLimit,
  sendEmpty,
  sendJson,
} from '../backplane/http/primitives.js';
import {
  type FifoChannelLease,
  FifoChannelLock,
  emitTurnContentionTelemetry,
  isBusyTurnError,
} from '../../system/lifecycle/turn-contention.js';
import {
  clampHttpHeader as clampHeaderValue,
  corsAllowlistIsEmpty,
  evaluateCorsPolicy,
  isLoopbackHost,
  normalizeCorsAllowedOrigins,
  resolveApiRequestPrincipal,
  singleHeader as firstHeaderValue,
} from './http-policy.js';
import {
  SSE_RESPONSE_HEADERS,
  buildApiErrorEnvelope,
  buildChatCompletionResponse,
  buildModelListResponse,
  buildStreamingContentChunk,
  buildStreamingErrorChunk,
  buildStreamingFinishChunk,
  buildStreamingRoleChunk,
  formatSseDataEvent,
  formatSseDoneEvent,
} from './response-format.js';
import { resolveApiTurnIdentity } from './external-channel-claim.js';
import type { ExternalChannelProfileConfig } from '../backplane/config.js';
import { resolveCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';

const log = createComponentLogger('ApiServer');
const MAX_BODY_SIZE = 1_048_576; // 1MB
const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS = 65 * 60_000;
const TELEMETRY_MAX_SKEW_MS = 5 * 60_000;
const TELEMETRY_NONCE_TTL_MS = 10 * 60_000;
const IDENTITY_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const TELEMETRY_EVENT_TYPE_ALLOWLIST = new Set([
  'external.telemetry.heartbeat',
  'external.telemetry.status',
  'external.telemetry.incident',
]);
const DIRECT_PROVIDER_OVERRIDE_ALLOWLIST = new Set(['anthropic', 'openai', 'google']);

const IDENTITY_CLAIM_HEADERS = {
  canonicalContactId: 'x-canonical-contact-id',
  sourceChannel: 'x-identity-claim-channel',
  sourceUserId: 'x-identity-claim-user-id',
  nonce: 'x-identity-claim-nonce',
  expires: 'x-identity-claim-expires',
  signature: 'x-identity-claim-signature',
} as const;

type LifecycleInterrupt = 'timeout' | 'client_disconnected';

class RequestLifecycleError extends Error {
  readonly reason: LifecycleInterrupt;

  constructor(reason: LifecycleInterrupt) {
    super(reason);
    this.reason = reason;
  }
}

const telemetryIngestSchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 128 }),
  eventType: Type.String({ minLength: 1, maxLength: 128 }),
  timestamp: Type.String({ minLength: 1, maxLength: 64 }),
  nonce: Type.String({ minLength: 8, maxLength: 128 }),
  payload: Type.Object({}, { additionalProperties: true }),
  channelId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

type TelemetryIngestInput = Static<typeof telemetryIngestSchema>;
type AgentTurnResult = Awaited<ReturnType<SubstrateAgent['handleMessage']>>;

interface PendingTurn {
  channelId: string;
  releaseChannel: () => void;
  substrateMsg: SubstrateMessage;
}

interface PreparedTurn {
  channelId: string;
  turnPromise: Promise<AgentTurnResult>;
}

interface TurnRoutingOverrides {
  modelOverride?: MessageModelOverride;
  promptOverride?: MessagePromptOverride;
  responseStyle?: ResponseStyle;
}

interface ChannelPrivacyResolution {
  ok: true;
  value?: ChannelVisibility;
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

export interface ApiServerConfig {
  port: number;
  host?: string;
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  sessionManager: SessionManager;
  companionId?: string;
  contactStore?: ContactStorePort;
  apiKey?: string;
  adminToken?: string;
  modelName?: string;
  requestTimeoutMs?: number;
  voiceWebSocketPath?: string;
  voiceWebSocketRuntime?: VoiceWebSocketRuntime;
  voiceWebSocketHooks?: VoiceWebSocketRuntimeHooks;
  runtime?: ApiServerRuntime;
  allowInsecureWithoutAuth?: boolean;
  corsAllowedOrigins?: string[];
  healthChecks?: ApiServerHealthChecks;
  schedulerHealthcheckStaleAfterMs?: number;
  externalChannelProfiles?: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  sensorIngest?: SensorIngestPort;
}

export class ApiServer implements ChannelAdapterPort {
  readonly id = 'api';
  readonly name = this.id;
  readonly meta = {
    label: 'API Server',
    emoji: ':globe_with_meridians:',
  };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['direct'],
    media: false,
    reactions: false,
    threads: false,
    streaming: true,
    promptChannelType: 'api',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly prompt: ChannelPromptAdapter;

  private server: Server;
  private port: number;
  private host: string;
  private agentLoop: SubstrateAgent;
  private eventBus: EventBus;
  private sensorIngest: SensorIngestPort;
  private sessionManager: SessionManager;
  private contactStore: ContactStorePort | null;
  private runtime: ApiServerRuntime | null;
  private apiKey?: string;
  private adminToken?: string;
  private allowInsecureWithoutAuth: boolean;
  private corsAllowedOrigins: ReturnType<typeof normalizeCorsAllowedOrigins>;
  private modelName: string;
  private requestTimeoutMs: number;
  private seenTelemetryNonces = new Map<string, number>();
  private channelTurnLock = new FifoChannelLock();
  private processingChannels = new Set<string>();
  private voiceWebSocket: ApiVoiceWebSocketAdapter;
  private healthChecks: ApiServerHealthChecks;
  private schedulerHealthcheckStaleAfterMs: number;
  private externalChannelProfiles: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  private lastSchedulerHealthcheckAtMs: number | null = null;
  private unregisterSchedulerHealthcheck: (() => void) | null = null;

  constructor(config: ApiServerConfig) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.agentLoop = config.agentLoop;
    this.eventBus = config.eventBus;
    this.sensorIngest = config.sensorIngest ?? createEventBusSensorIngestPort(this.eventBus);
    this.sessionManager = config.sessionManager;
    this.contactStore = config.contactStore ?? null;
    this.runtime = config.runtime ?? null;
    this.apiKey = clampHeaderValue(config.apiKey, 512);
    this.adminToken = clampHeaderValue(config.adminToken, 512);
    this.allowInsecureWithoutAuth = config.allowInsecureWithoutAuth === true;
    this.corsAllowedOrigins = normalizeCorsAllowedOrigins(config.corsAllowedOrigins);
    this.modelName = config.modelName ?? resolveCompanionIdFromConfig(config);
    this.requestTimeoutMs = this.parseTimeoutMs(config.requestTimeoutMs);
    this.healthChecks = config.healthChecks ?? {};
    this.schedulerHealthcheckStaleAfterMs = this.parseSchedulerHealthcheckStaleAfterMs(
      config.schedulerHealthcheckStaleAfterMs,
    );
    this.externalChannelProfiles = config.externalChannelProfiles ?? {};
    this.unregisterSchedulerHealthcheck = this.eventBus.on('schedule.healthcheck', ({ timestamp }) => {
      if (Number.isFinite(timestamp) && timestamp > 0) {
        this.lastSchedulerHealthcheckAtMs = Math.floor(timestamp);
      } else {
        this.lastSchedulerHealthcheckAtMs = Date.now();
      }
    });
    this.voiceWebSocket = new ApiVoiceWebSocketAdapter({
      apiKey: this.apiKey,
      path: config.voiceWebSocketPath,
      runtime: config.voiceWebSocketRuntime,
      runtimeHooks: config.voiceWebSocketHooks,
    });
    this.config = {
      enabled: true,
      connectionLabel: `${this.host}:${this.port}`,
    };
    this.outbound = {
      textChunkLimit: Number.MAX_SAFE_INTEGER,
      sendText: async (ctx: OutboundContext, text: string): Promise<void> => {
        const normalized = text.trim();
        if (!normalized) return;
        this.sessionManager.recordAssistantMessage(ctx.channelId, normalized);
      },
    };
    this.gateway = this;
    this.prompt = {
      resolveChannelType: (): string => 'api',
    };
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async init(): Promise<void> {}

  async start(): Promise<void> {
    if (!this.apiKey && !this.allowInsecureWithoutAuth) {
      const err = new Error('API_KEY is required unless ALLOW_INSECURE_LOCAL_API=true');
      log.error('Refusing to start API server without authentication', {
        host: this.host,
        port: this.port,
        requiredEnv: 'API_KEY or ALLOW_INSECURE_LOCAL_API=true',
      });
      throw err;
    }

    if (!this.apiKey && !isLoopbackHost(this.host)) {
      const err = new Error(
        'ALLOW_INSECURE_LOCAL_API=true requires API_HOST to be loopback (127.0.0.1, ::1, or localhost)',
      );
      log.error('Refusing to start insecure API server on non-loopback host', {
        host: this.host,
        port: this.port,
      });
      throw err;
    }

    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        log.error('API server failed to start', {
          host: this.host,
          port: this.port,
          code: err.code,
          errno: err.errno,
          syscall: err.syscall,
          error: err.message,
        });
        reject(err);
      };

      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        log.info(`Listening on ${this.host}:${this.port}`);
        if (!this.apiKey) {
          log.warn('API authentication disabled by explicit ALLOW_INSECURE_LOCAL_API=true');
        }
        if (corsAllowlistIsEmpty(this.corsAllowedOrigins)) {
          log.warn('API CORS allowlist is empty; cross-origin browser requests are denied by default');
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.unregisterSchedulerHealthcheck?.();
    this.unregisterSchedulerHealthcheck = null;
    await this.voiceWebSocket.stop();
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const handled = this.voiceWebSocket.handleUpgrade(req, socket, head);
    if (!handled) {
      this.voiceWebSocket.rejectUnknownUpgrade(socket);
    }
  }

  private parseTimeoutMs(value: number | undefined): number {
    if (value === undefined) return DEFAULT_CHAT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_CHAT_REQUEST_TIMEOUT_MS;
    }
    return Math.floor(value);
  }

  private parseSchedulerHealthcheckStaleAfterMs(value: number | undefined): number {
    if (value !== undefined && Number.isFinite(value) && value >= 1_000) {
      return Math.floor(value);
    }

    const envValue = process.env.API_HEALTH_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS;
    if (envValue) {
      const parsed = Number.parseInt(envValue, 10);
      if (Number.isFinite(parsed) && parsed >= 1_000) {
        return parsed;
      }
    }

    return DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS;
  }

  private applyCorsPolicy(req: IncomingMessage, res: ServerResponse): boolean {
    const policy = evaluateCorsPolicy(req, this.corsAllowedOrigins, res.getHeader('Vary'));
    if (!policy.ok) {
      this.sendError(res, policy.error.status, policy.error.type, policy.error.message);
      return false;
    }

    if (!policy.headers) return true;
    for (const [key, value] of Object.entries(policy.headers)) {
      res.setHeader(key, value);
    }
    return true;
  }

  private attachTurnCleanup(
    releaseChannel: () => void,
    turnPromise: Promise<unknown>,
  ): void {
    turnPromise
      .catch((err) => { log.debug('Turn promise rejected during cleanup', { error: String(err) }); })
      .finally(() => {
        releaseChannel();
      });
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

  private async waitForQueueLeaseOrInterrupt<T>(
    req: IncomingMessage,
    res: ServerResponse,
    leasePromise: Promise<T>,
  ): Promise<T> {
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const lease = await Promise.race([leasePromise, interruptionPromise]);
      settled = true;
      return lease;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private async acquireChannel(
    channelId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<(() => void) | null> {
    const queued = this.channelTurnLock.acquire(channelId);
    if (queued.contended) {
      this.emitQueueTelemetry(channelId, 'contended', {
        queueDepth: queued.queueDepth,
        waitMs: 0,
        reason: 'active_turn',
      });
    }

    let lease: FifoChannelLease;
    try {
      lease = await this.waitForQueueLeaseOrInterrupt(req, res, queued.lease);
    } catch (err) {
      queued.lease.then((lateLease) => {
        lateLease.release();
      }).catch((leaseErr) => { log.debug('Late lease release failed', { error: String(leaseErr) }); });

      if (err instanceof RequestLifecycleError && err.reason === 'timeout' && this.canWriteResponse(res)) {
        this.sendError(res, 504, 'request_timeout', 'Request timed out before turn started');
      }
      return null;
    }

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

  private isAgentBusyError(err: unknown): boolean {
    return isBusyTurnError(err);
  }

  private abortActiveTurn(channelId: string, reason: LifecycleInterrupt): void {
    const maybeAbortable = this.agentLoop as unknown as { abort?: () => void };
    if (typeof maybeAbortable.abort !== 'function') return;
    try {
      maybeAbortable.abort();
      log.warn('Aborted active turn due to request lifecycle interruption', {
        channelId,
        reason,
      });
    } catch (err) {
      log.error('Failed to abort active turn', {
        channelId,
        reason,
        error: toErrorMessage(err),
      });
    }
  }

  private canWriteResponse(res: ServerResponse): boolean {
    return !res.writableEnded && !res.destroyed;
  }

  private async awaitTurnOrInterrupt<T>(
    channelId: string,
    req: IncomingMessage,
    res: ServerResponse,
    turnPromise: Promise<T>,
  ): Promise<T> {
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        this.abortActiveTurn(channelId, reason);
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const result = await Promise.race([turnPromise, interruptionPromise]);
      settled = true;
      return result;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private async awaitRuntimeOrInterrupt<T>(
    req: IncomingMessage,
    res: ServerResponse,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const result = await Promise.race([operation(controller.signal), interruptionPromise]);
      settled = true;
      return result;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private extractRpcHeaders(req: IncomingMessage): ApiRuntimeChatRequest['headers'] {
    const headers: ApiRuntimeChatRequest['headers'] = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = this.singleHeader(value);
    }
    return headers;
  }

  private sendRuntimeError(
    res: ServerResponse,
    status: number,
    type: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.canWriteResponse(res)) return;
    this.sendError(res, status, type, message, details);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.applyCorsPolicy(req, res)) return;

    if (req.method === 'OPTIONS') {
      sendEmpty(res, 204);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const isTelemetryIngest = req.method === 'POST' && path === '/v1/telemetry/ingest';
    const principal = this.resolveRequestPrincipal(req, res, isTelemetryIngest);
    if (!principal) return;

    if (req.method === 'GET' && path === '/v1/models') {
      this.handleModels(res);
    } else if (req.method === 'GET' && path === '/health') {
      void this.handleHealth(res);
    } else if (req.method === 'POST' && path === '/v1/chat/completions') {
      void this.handleChatCompletions(req, res, principal);
    } else if (isTelemetryIngest) {
      void this.handleTelemetryIngest(req, res);
    } else {
      this.sendError(res, 404, 'not_found', `No route for ${req.method} ${path}`);
    }
  }

  private resolveRequestPrincipal(
    req: IncomingMessage,
    res: ServerResponse,
    isTelemetryIngest: boolean,
  ): ApiAuthPrincipal | null {
    const resolution = resolveApiRequestPrincipal(req, {
      apiKey: this.apiKey,
      alternateApiToken: this.adminToken,
      alternateCookieTokenNames: this.adminToken ? ['psfn_token'] : [],
      allowInsecureWithoutAuth: this.allowInsecureWithoutAuth,
      isTelemetryIngest,
    });

    if (resolution.ok) {
      return resolution.principal;
    }
    this.sendError(res, resolution.error.status, resolution.error.type, resolution.error.message);
    return null;
  }

  private handleModels(res: ServerResponse): void {
    const body = buildModelListResponse(this.modelName, Math.floor(Date.now() / 1000));
    sendJson(res, 200, body);
  }

  private async handleHealth(res: ServerResponse): Promise<void> {
    if (this.runtime) {
      const body = await this.runtime.handleHealth();
      sendJson(res, body.status === 'healthy' ? 200 : 503, body);
      return;
    }

    const subsystemEntries = await Promise.all(
      API_HEALTH_SUBSYSTEMS.map(async (subsystem) => {
        const status = await this.evaluateSubsystemHealth(subsystem);
        return [subsystem, status] as const;
      }),
    );
    const checkedAtMs = Date.now();

    const subsystems = Object.fromEntries(subsystemEntries) as ApiHealthResponse['subsystems'];
    const subsystemStatus: ApiHealthResponse['status'] = API_HEALTH_SUBSYSTEMS.every(
      (subsystem) => subsystems[subsystem].status === 'healthy',
    )
      ? 'healthy'
      : 'degraded';
    const continuity = this.evaluateContinuityWatchdogHealth(subsystems, checkedAtMs);
    const status: ApiHealthResponse['status'] = (
      subsystemStatus === 'healthy'
      && continuity.status === 'healthy'
    )
      ? 'healthy'
      : 'degraded';

    const body: ApiHealthResponse = {
      status,
      checkedAt: new Date(checkedAtMs).toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      subsystems,
      continuity,
    };

    sendJson(res, status === 'healthy' ? 200 : 503, body);
  }

  private evaluateContinuityWatchdogHealth(
    subsystems: ApiHealthResponse['subsystems'],
    checkedAtMs: number,
  ): ApiHealthResponse['continuity'] {
    const checks: Record<ApiContinuityWatchdogCheck, ApiHealthSubsystemStatus> = {
      database: this.mapSubsystemToContinuityCheck(
        subsystems.memory,
        'memory',
        'Database-backed memory subsystem is degraded',
      ),
      gatewayLink: this.evaluateGatewayLinkHealth(subsystems),
      schedulerHealthcheck: this.evaluateSchedulerHealthcheckHealth(subsystems.scheduler, checkedAtMs),
    };

    const status: ApiHealthResponse['continuity']['status'] = API_CONTINUITY_WATCHDOG_CHECKS.every(
      (check) => checks[check].status === 'healthy',
    )
      ? 'healthy'
      : 'degraded';

    return {
      status,
      checks,
    };
  }

  private mapSubsystemToContinuityCheck(
    source: ApiHealthSubsystemStatus,
    sourceSubsystem: ApiHealthSubsystem,
    degradedFallbackDetail: string,
  ): ApiHealthSubsystemStatus {
    const detail = source.detail?.trim();
    return {
      status: source.status === 'healthy' ? 'healthy' : 'degraded',
      ...(source.status === 'degraded'
        ? { detail: detail || degradedFallbackDetail }
        : {}),
      meta: {
        ...(source.meta ?? {}),
        sourceSubsystem,
      },
    };
  }

  private evaluateGatewayLinkHealth(
    subsystems: ApiHealthResponse['subsystems'],
  ): ApiHealthSubsystemStatus {
    const llmHealthy = subsystems.llm.status === 'healthy';
    const embeddingsHealthy = subsystems.embeddings.status === 'healthy';
    if (llmHealthy || embeddingsHealthy) {
      return {
        status: 'healthy',
        meta: {
          sourceSubsystems: ['llm', 'embeddings'],
          llmStatus: subsystems.llm.status,
          embeddingsStatus: subsystems.embeddings.status,
        },
      };
    }

    const llmDetail = subsystems.llm.detail?.trim();
    const embeddingsDetail = subsystems.embeddings.detail?.trim();
    const detailParts = [llmDetail, embeddingsDetail].filter((value): value is string => Boolean(value));
    return {
      status: 'degraded',
      detail: detailParts.join(' | ') || 'Gateway-linked LLM and embeddings checks are degraded',
      meta: {
        sourceSubsystems: ['llm', 'embeddings'],
        llmStatus: subsystems.llm.status,
        embeddingsStatus: subsystems.embeddings.status,
      },
    };
  }

  private evaluateSchedulerHealthcheckHealth(
    schedulerSubsystem: ApiHealthSubsystemStatus,
    checkedAtMs: number,
  ): ApiHealthSubsystemStatus {
    const schedulerDetail = schedulerSubsystem.detail?.trim();
    const healthcheckObservedAtMs = this.lastSchedulerHealthcheckAtMs;
    const uptimeMs = Math.max(0, Math.floor(process.uptime() * 1_000));
    const healthcheckAgeMs = healthcheckObservedAtMs === null
      ? null
      : Math.max(0, checkedAtMs - healthcheckObservedAtMs);

    const baseMeta: Record<string, unknown> = {
      ...(schedulerSubsystem.meta ?? {}),
      sourceSubsystem: 'scheduler',
      schedulerHealthcheckStaleAfterMs: this.schedulerHealthcheckStaleAfterMs,
      ...(healthcheckObservedAtMs === null
        ? { healthcheckObserved: false }
        : {
          healthcheckObserved: true,
          schedulerHealthcheckAt: new Date(healthcheckObservedAtMs).toISOString(),
          schedulerHealthcheckAgeMs: healthcheckAgeMs,
        }),
    };

    if (schedulerSubsystem.status !== 'healthy') {
      return {
        status: 'degraded',
        detail: schedulerDetail || 'Scheduler subsystem is degraded',
        meta: baseMeta,
      };
    }

    if (healthcheckObservedAtMs === null) {
      if (uptimeMs <= this.schedulerHealthcheckStaleAfterMs) {
        return {
          status: 'healthy',
          meta: {
            ...baseMeta,
            schedulerHealthcheckGraceMsRemaining: Math.max(
              0,
              this.schedulerHealthcheckStaleAfterMs - uptimeMs,
            ),
          },
        };
      }
      return {
        status: 'degraded',
        detail: `No scheduler healthcheck observed within ${this.schedulerHealthcheckStaleAfterMs}ms`,
        meta: baseMeta,
      };
    }

    if (healthcheckAgeMs !== null && healthcheckAgeMs > this.schedulerHealthcheckStaleAfterMs) {
      return {
        status: 'degraded',
        detail: `Scheduler healthcheck stale: ${healthcheckAgeMs}ms since last pulse (limit ${this.schedulerHealthcheckStaleAfterMs}ms)`,
        meta: baseMeta,
      };
    }

    return {
      status: 'healthy',
      meta: baseMeta,
    };
  }

  private async evaluateSubsystemHealth(
    subsystem: ApiHealthSubsystem,
  ): Promise<ApiHealthSubsystemStatus> {
    const startedAt = Date.now();
    const check = this.healthChecks[subsystem];
    if (!check) {
      return this.normalizeSubsystemHealth({
        status: 'degraded',
        detail: 'Health check not configured',
      }, 0);
    }

    try {
      const result = await Promise.resolve(check());
      return this.normalizeSubsystemHealth(result, Date.now() - startedAt);
    } catch (error) {
      return this.normalizeSubsystemHealth({
        status: 'degraded',
        detail: toErrorMessage(error),
      }, Date.now() - startedAt);
    }
  }

  private normalizeSubsystemHealth(
    result: ApiHealthSubsystemStatus,
    checkLatencyMs: number,
  ): ApiHealthSubsystemStatus {
    const detail = result.detail?.trim();
    return {
      status: result.status === 'healthy' ? 'healthy' : 'degraded',
      ...(detail ? { detail } : {}),
      meta: {
        ...(result.meta ?? {}),
        checkLatencyMs: Math.max(0, Math.round(checkLatencyMs)),
      },
    };
  }

  private async handleChatCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
  ): Promise<void> {
    const parsedBody = await readJsonBodyWithLimit<ChatCompletionRequest>(req, res, {
      maxBytes: MAX_BODY_SIZE,
      logger: log,
    });
    if (!parsedBody.ok) {
      if (parsedBody.errorCode === 'payload_too_large') return;
      if (parsedBody.errorCode === 'read_error') {
        log.error('Failed reading request body', {
          path: req.url ?? '/v1/chat/completions',
          error: parsedBody.error.message,
        });
        if (this.canWriteResponse(res)) {
          this.sendError(res, 500, 'internal_error', 'Internal server error');
        }
        return;
      }

      log.warn('Rejected request with invalid JSON body', {
        path: req.url ?? '/v1/chat/completions',
        bodySize: Buffer.byteLength(parsedBody.rawBody),
        contentType: req.headers['content-type'],
        remoteAddress: req.socket.remoteAddress,
        error: parsedBody.error.message,
      });
      this.sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }

    const parsed = parsedBody.value;
    if (this.hasCallerProvidedPrimaryTrust(parsed)) {
      log.warn('Rejected caller-provided primary trust field in API payload', {
        path: req.url ?? '/v1/chat/completions',
        remoteAddress: req.socket.remoteAddress,
      });
      this.sendError(
        res,
        400,
        'invalid_request',
        'Caller-provided primary trust level is not allowed',
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation of untrusted JSON
    if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      this.sendError(res, 400, 'invalid_request', 'messages field is required and must be a non-empty array');
      return;
    }

    if (parsed.stream) {
      await this.handleStreaming(parsed, req, res, principal);
    } else {
      await this.handleNonStreaming(parsed, req, res, principal);
    }
  }

  private isPrimaryTrustLevelValue(value: unknown): boolean {
    return typeof value === 'string' && value.trim().toLowerCase() === 'primary';
  }

  private hasCallerProvidedPrimaryTrust(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const record = payload as Record<string, unknown>;
    if (this.isPrimaryTrustLevelValue(record.trustLevel) || this.isPrimaryTrustLevelValue(record.trust_level)) {
      return true;
    }

    const contact = record.contact;
    if (!contact || typeof contact !== 'object') return false;
    const contactRecord = contact as Record<string, unknown>;
    return this.isPrimaryTrustLevelValue(contactRecord.trustLevel)
      || this.isPrimaryTrustLevelValue(contactRecord.trust_level);
  }

  private async handleTelemetryIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedBody = await readJsonBodyWithLimit(req, res, {
      maxBytes: MAX_BODY_SIZE,
      logger: log,
    });
    if (!parsedBody.ok) {
      if (parsedBody.errorCode === 'payload_too_large') return;
      if (parsedBody.errorCode === 'read_error') {
        log.error('Failed reading telemetry body', {
          error: parsedBody.error.message,
        });
        if (this.canWriteResponse(res)) {
          this.sendError(res, 500, 'internal_error', 'Internal server error');
        }
        return;
      }
      this.sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }

    await this.ingestTelemetryPayload(parsedBody.value, res);
  }

  private async ingestTelemetryPayload(parsed: unknown, res: ServerResponse): Promise<void> {
    if (!Value.Check(telemetryIngestSchema, parsed)) {
      this.sendError(
        res,
        400,
        'invalid_request',
        'Telemetry payload failed schema validation',
      );
      return;
    }

    const telemetry: TelemetryIngestRequest = parsed as TelemetryIngestInput;

    if (!TELEMETRY_EVENT_TYPE_ALLOWLIST.has(telemetry.eventType)) {
      this.sendError(
        res,
        403,
        'event_type_not_allowed',
        `eventType must be one of: ${Array.from(TELEMETRY_EVENT_TYPE_ALLOWLIST).join(', ')}`,
      );
      return;
    }

    const occurredAtMs = Date.parse(telemetry.timestamp);
    if (!Number.isFinite(occurredAtMs)) {
      this.sendError(res, 400, 'invalid_request', 'timestamp must be a valid ISO-8601 string');
      return;
    }

    const now = Date.now();
    if (Math.abs(now - occurredAtMs) > TELEMETRY_MAX_SKEW_MS) {
      this.sendError(
        res,
        400,
        'stale_request',
        `timestamp must be within ${TELEMETRY_MAX_SKEW_MS / 1000} seconds of server time`,
      );
      return;
    }

    this.pruneTelemetryNonces(now);
    const nonceKey = `${telemetry.source}:${telemetry.nonce}`;
    if (this.seenTelemetryNonces.has(nonceKey)) {
      this.sendError(res, 409, 'replay_detected', 'Duplicate nonce detected');
      return;
    }
    this.seenTelemetryNonces.set(nonceKey, now);

    const normalizedEvent: ExternalTelemetryEvent = {
      id: `ext-${randomUUID()}`,
      source: telemetry.source,
      eventType: telemetry.eventType,
      payload: telemetry.payload,
      occurredAt: new Date(occurredAtMs).toISOString(),
      receivedAt: new Date(now).toISOString(),
      nonce: telemetry.nonce,
      channelId: telemetry.channelId,
      scope: telemetry.scope,
    };

    if (this.runtime) {
      const result = await this.runtime.handleTelemetryIngest(normalizedEvent);
      if (!result.ok) {
        this.sendRuntimeError(
          res,
          result.error.status,
          result.error.type,
          result.error.message,
          result.error.details,
        );
        return;
      }
      sendJson(res, 202, result.response);
      return;
    }

    const receipt = await this.sensorIngest.ingestTelemetry(normalizedEvent);

    const response: TelemetryIngestResponse = {
      ok: true,
      id: receipt.id,
      acceptedEventType: receipt.acceptedEventType,
    };
    sendJson(res, 202, response);
  }

  private pruneTelemetryNonces(now: number): void {
    for (const [nonceKey, seenAt] of this.seenTelemetryNonces.entries()) {
      if (now - seenAt > TELEMETRY_NONCE_TTL_MS) {
        this.seenTelemetryNonces.delete(nonceKey);
      }
    }
  }

  private buildSubstrateMessage(params: {
    channelId: string;
    channelType: ChannelType;
    source: NonNullable<MessageRoutingMetadata['source']>;
    content: string;
    authorId: string;
    authorName: string;
    req: IncomingMessage;
    overrides: TurnRoutingOverrides;
    channelPrivacy?: ChannelVisibility;
    canonicalContactId?: string;
  }): SubstrateMessage {
    const {
      channelId,
      channelType,
      source,
      content,
      authorId,
      authorName,
      req,
      overrides,
      channelPrivacy,
      canonicalContactId,
    } = params;
    const approvalToken = this.clampHeader(
      this.singleHeader(req.headers['x-broadcast-approval-token']),
      256,
    );
    const requestedScope = this.clampHeader(
      this.singleHeader(req.headers['x-broadcast-visibility-scope']),
      64,
    );
    const visibilityScope = requestedScope === 'public_only' || requestedScope === 'approved_private_context'
      ? requestedScope
      : undefined;
    const routing: MessageRoutingMetadata = {
      source,
      ...(approvalToken || visibilityScope
        ? {
          broadcast: {
            ...(approvalToken ? { approvalToken } : {}),
            ...(visibilityScope ? { visibilityScope } : {}),
          },
        }
        : {}),
      ...(channelPrivacy ? { channelPrivacy } : {}),
      ...(overrides.modelOverride ? { modelOverride: overrides.modelOverride } : {}),
      ...(overrides.promptOverride ? { promptOverride: overrides.promptOverride } : {}),
      ...(overrides.responseStyle ? { responseStyle: overrides.responseStyle } : {}),
      ...(canonicalContactId ? { canonicalContactId } : {}),
    };
    const hasRouting = source !== 'api'
      || routing.broadcast
      || routing.channelPrivacy
      || routing.modelOverride
      || routing.promptOverride
      || routing.responseStyle
      || routing.canonicalContactId;

    return {
      id: `api-${randomUUID()}`,
      channelId,
      channelType,
      authorId,
      authorName,
      content,
      ...(hasRouting ? { routing } : {}),
      timestamp: new Date(),
    };
  }

  private deriveChannelId(req: IncomingMessage, principal: ApiAuthPrincipal): string {
    const sessionId = this.clampHeader(
      this.singleHeader(req.headers['x-session-id']),
      128,
    );
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
    channelPrivacy?: ChannelVisibility,
  ): void {
    // Only seed if this session has no prior messages
    const count = this.sessionManager.getMessageCount(channelId);
    if (count > 0) return;

    // Seed all messages except the last user message (which handleMessage will record)
    const prior = messages.slice(0, -1);
    for (const msg of prior) {
      if (msg.role === 'user') {
        if (channelPrivacy) {
          this.sessionManager.recordUserMessage(
            channelId,
            msg.content,
            authorId,
            msg.name ?? authorName,
            undefined,
            undefined,
            {
              channelMeta: { privacyLevel: channelPrivacy },
            },
          );
          continue;
        }
        this.sessionManager.recordUserMessage(channelId, msg.content, authorId, msg.name ?? authorName);
      } else if (msg.role === 'assistant') {
        if (channelPrivacy) {
          this.sessionManager.recordAssistantMessage(
            channelId,
            msg.content,
            undefined,
            undefined,
            undefined,
            {
              channelMeta: { privacyLevel: channelPrivacy },
            },
          );
          continue;
        }
        this.sessionManager.recordAssistantMessage(channelId, msg.content);
      }
      // system messages are handled via systemPrompt, skip
    }
  }

  private resolveChannelPrivacy(req: IncomingMessage): ChannelPrivacyResolution | ChannelPrivacyError {
    const rawValue = this.clampHeader(
      this.singleHeader(req.headers['x-channel-privacy']),
      64,
    );
    if (!rawValue) {
      return { ok: true };
    }
    if (!isChannelVisibility(rawValue)) {
      return {
        ok: false,
        error: 'X-Channel-Privacy must be one of: private, semi_private, public, broadcast',
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

  private singleHeader(value: string | string[] | undefined): string | undefined {
    return firstHeaderValue(value);
  }

  private clampHeader(value: string | undefined, maxLength: number): string | undefined {
    return clampHeaderValue(value, maxLength);
  }

  private getLastUserMessage(messages: ChatCompletionRequest['messages']): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return messages[messages.length - 1].content;
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
        return {
          ok: false,
          error: 'provider override requires a non-empty model field',
        };
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
        return {
          ok: false,
          error: 'system_prompt_mode must be one of: default, none, custom',
        };
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
        return {
          ok: false,
          error: 'response_style must be one of: concise, expressive',
        };
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

  private readIdentityClaimHeaders(req: IncomingMessage): IdentityClaimHeaders | null {
    const canonicalContactId = this.clampHeader(
      this.singleHeader(req.headers[IDENTITY_CLAIM_HEADERS.canonicalContactId]),
      128,
    );
    if (!canonicalContactId) return null;

    return {
      canonicalContactId,
      sourceChannel: this.clampHeader(
        this.singleHeader(req.headers[IDENTITY_CLAIM_HEADERS.sourceChannel]),
        64,
      ) ?? '',
      sourceUserId: this.clampHeader(
        this.singleHeader(req.headers[IDENTITY_CLAIM_HEADERS.sourceUserId]),
        256,
      ) ?? '',
      nonce: this.clampHeader(
        this.singleHeader(req.headers[IDENTITY_CLAIM_HEADERS.nonce]),
        128,
      ),
      expiresAt: this.clampHeader(
        this.singleHeader(req.headers[IDENTITY_CLAIM_HEADERS.expires]),
        64,
      ),
      signature: this.clampHeader(
        this.singleHeader(req.headers[IDENTITY_CLAIM_HEADERS.signature]),
        256,
      ),
    };
  }

  private challengePayload(
    claim: IdentityClaimHeaders,
    authorId: string,
    challenge: {
      nonce: string;
      expiresAt: string;
      signature: string;
    },
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
    req: IncomingMessage,
    res: ServerResponse,
    authorId: string,
  ): Promise<boolean> {
    const claim = this.readIdentityClaimHeaders(req);
    if (!claim) return true;

    if (!this.contactStore) {
      this.sendError(
        res,
        503,
        'identity_claim_unavailable',
        'Identity claim verification is unavailable because contact store is not configured',
      );
      return false;
    }

    if (!claim.sourceChannel || !claim.sourceUserId) {
      this.sendError(
        res,
        400,
        'invalid_identity_claim',
        'X-Identity-Claim-Channel and X-Identity-Claim-User-ID are required when claiming a canonical contact',
      );
      return false;
    }

    const hasCompleteVerificationHeaders = Boolean(claim.nonce && claim.expiresAt && claim.signature);
    const existingApiIdentity = await this.contactStore.getByChannelIdentity('api', authorId);
    if (existingApiIdentity?.id === claim.canonicalContactId && !hasCompleteVerificationHeaders) {
      return true;
    }
    if (existingApiIdentity && existingApiIdentity.id !== claim.canonicalContactId) {
      this.sendError(
        res,
        409,
        'identity_claim_conflict',
        `API identity api:${authorId} is already linked to another canonical contact`,
      );
      return false;
    }

    const requiresChallenge = !claim.nonce || !claim.expiresAt || !claim.signature;
    if (requiresChallenge) {
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
        case 'pending_exists': {
          const payload = this.challengePayload(claim, authorId, challengeResult.verification);
          this.sendError(
            res,
            428,
            'identity_verification_required',
            'Identity claim requires challenge verification headers',
            { verification: payload },
          );
          return false;
        }
        case 'already_linked':
          return true;
        case 'contact_not_found':
          this.sendError(
            res,
            404,
            'identity_claim_contact_not_found',
            `Canonical contact ${claim.canonicalContactId} was not found`,
          );
          return false;
        case 'source_identity_not_linked':
          this.sendError(
            res,
            403,
            'identity_claim_source_not_linked',
            `${claim.sourceChannel}:${claim.sourceUserId} is not linked to canonical contact ${claim.canonicalContactId}`,
          );
          return false;
        case 'identity_conflict':
          this.sendError(
            res,
            409,
            'identity_claim_conflict',
            `API identity api:${authorId} is already linked to a different canonical contact`,
          );
          return false;
        default:
          this.sendError(res, 400, 'invalid_identity_claim', 'Unable to create identity claim challenge');
          return false;
      }
    }

    const nonce = claim.nonce;
    const expiresAt = claim.expiresAt;
    const signature = claim.signature;
    if (!nonce || !expiresAt || !signature) {
      this.sendError(res, 400, 'invalid_identity_claim', 'Identity claim verification headers were incomplete');
      return false;
    }

    const verificationResult = await this.contactStore.verifyIdentityLinkChallenge({
      contactId: claim.canonicalContactId,
      sourceChannel: claim.sourceChannel,
      sourceUserId: claim.sourceUserId,
      targetChannel: 'api',
      targetUserId: authorId,
      nonce,
      expiresAt,
      signature,
    });

    switch (verificationResult.status) {
      case 'linked':
      case 'already_linked':
        return true;
      case 'verification_not_found':
        this.sendError(
          res,
          428,
          'identity_verification_required',
          'Identity claim challenge not found. Request a fresh challenge and retry with the returned headers.',
        );
        return false;
      case 'verification_replayed':
        this.sendError(res, 409, 'identity_verification_replayed', 'Identity claim challenge has already been used');
        return false;
      case 'verification_expired':
        this.sendError(res, 410, 'identity_verification_expired', 'Identity claim challenge has expired');
        return false;
      case 'invalid_signature':
        this.sendError(res, 401, 'identity_verification_invalid_signature', 'Identity claim signature did not match challenge');
        return false;
      case 'claim_mismatch':
        this.sendError(
          res,
          403,
          'identity_verification_claim_mismatch',
          'Identity claim payload did not match the issued challenge',
        );
        return false;
      case 'source_identity_not_linked':
        this.sendError(
          res,
          403,
          'identity_claim_source_not_linked',
          `${claim.sourceChannel}:${claim.sourceUserId} is not linked to canonical contact ${claim.canonicalContactId}`,
        );
        return false;
      case 'identity_conflict':
        this.sendError(
          res,
          409,
          'identity_claim_conflict',
          `API identity api:${authorId} is already linked to a different canonical contact`,
        );
        return false;
      case 'contact_not_found':
        this.sendError(
          res,
          404,
          'identity_claim_contact_not_found',
          `Canonical contact ${claim.canonicalContactId} was not found`,
        );
        return false;
      default:
        this.sendError(res, 400, 'invalid_identity_claim', 'Unable to verify identity claim');
        return false;
    }
  }

  private async prepareTurn(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
  ): Promise<PendingTurn | null> {
    const routingOverrides = this.parseTurnRoutingOverrides(request);
    if (!routingOverrides.ok) {
      this.sendError(res, 400, 'invalid_request', routingOverrides.error);
      return null;
    }
    const channelPrivacy = this.resolveChannelPrivacy(req);
    if (!channelPrivacy.ok) {
      this.sendError(res, 400, 'invalid_request', channelPrivacy.error);
      return null;
    }

    const defaultChannelId = this.deriveChannelId(req, principal);
    const defaultAuthor = this.deriveAuthor(principal);
    const turnIdentity = resolveApiTurnIdentity({
      headers: req.headers,
      principal,
      defaultChannelId,
      defaultAuthorId: defaultAuthor.authorId,
      defaultAuthorName: defaultAuthor.authorName,
      externalChannelProfiles: this.externalChannelProfiles,
    });
    if (!turnIdentity.ok) {
      this.sendError(res, turnIdentity.status, turnIdentity.type, turnIdentity.message);
      return null;
    }
    const {
      channelId,
      channelType,
      authorId,
      authorName,
      source,
      channelPrivacy: claimedChannelPrivacy,
      canonicalContactId: claimedCanonicalContactId,
    } = turnIdentity.value;
    if (!(await this.enforceIdentityClaim(req, res, authorId))) {
      return null;
    }

    const canonicalContactId = this.clampHeader(
      this.singleHeader(req.headers['x-canonical-contact-id']),
      256,
    ) ?? claimedCanonicalContactId;
    const resolvedChannelPrivacy = channelPrivacy.value ?? claimedChannelPrivacy;
    if (channelType === 'psfn-amica') {
      if (!canonicalContactId) {
        this.sendError(
          res,
          503,
          'external_channel_not_configured',
          'PSFN Amica claims require a canonical contact mapping',
        );
        return null;
      }
      if (!resolvedChannelPrivacy) {
        this.sendError(
          res,
          503,
          'external_channel_not_configured',
          'PSFN Amica claims require a configured channel privacy level',
        );
        return null;
      }
    }
    const lastUserMsg = this.getLastUserMessage(request.messages);
    const substrateMsg = this.buildSubstrateMessage({
      channelId,
      channelType,
      source,
      content: lastUserMsg,
      authorId,
      authorName,
      req,
      overrides: routingOverrides.value,
      channelPrivacy: resolvedChannelPrivacy,
      canonicalContactId,
    });

    const releaseChannel = await this.acquireChannel(channelId, req, res);
    if (!releaseChannel) return null;

    this.seedSession(channelId, request.messages, authorId, authorName, resolvedChannelPrivacy);

    return { channelId, releaseChannel, substrateMsg };
  }

  private beginPreparedTurn(turn: PendingTurn): PreparedTurn {
    const turnPromise = this.agentLoop.handleMessage(turn.substrateMsg);
    this.attachTurnCleanup(turn.releaseChannel, turnPromise);
    return {
      channelId: turn.channelId,
      turnPromise,
    };
  }

  private async startTurn(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
  ): Promise<PreparedTurn | null> {
    const pending = await this.prepareTurn(request, req, res, principal);
    if (!pending) return null;
    return this.beginPreparedTurn(pending);
  }

  private handleNonStreamingTurnError(res: ServerResponse, err: unknown): void {
    if (!this.canWriteResponse(res)) return;
    if (err instanceof RequestLifecycleError) {
      if (err.reason === 'timeout') {
        this.sendError(res, 504, 'request_timeout', 'Request timed out before turn completed');
      }
      return;
    }
    if (this.isAgentBusyError(err)) {
      res.setHeader('Retry-After', '1');
      this.sendError(res, 503, 'agent_busy', 'Agent is already processing another prompt');
      return;
    }
    log.error('Non-streaming completion error', { error: String(err) });
    this.sendError(res, 500, 'internal_error', 'Internal server error');
  }

  private writeStreamingChunk(res: ServerResponse, chunk: ChatCompletionChunk): void {
    res.write(formatSseDataEvent(chunk));
  }

  private writeStreamingDone(res: ServerResponse): void {
    res.write(formatSseDoneEvent());
  }

  private writeStreamingErrorAndDone(
    res: ServerResponse,
    completionId: string,
    created: number,
    content: string,
  ): void {
    const errorChunk = buildStreamingErrorChunk({
      completionId,
      created,
      model: this.modelName,
    }, content);
    this.writeStreamingChunk(res, errorChunk);
    this.writeStreamingDone(res);
  }

  private handleStreamingTurnError(
    res: ServerResponse,
    err: unknown,
    completionId: string,
    created: number,
  ): void {
    if (err instanceof RequestLifecycleError) {
      if (err.reason === 'timeout' && this.canWriteResponse(res)) {
        this.writeStreamingErrorAndDone(
          res,
          completionId,
          created,
          '\n[Error: Request timed out]',
        );
      }
      return;
    }

    if (this.isAgentBusyError(err)) {
      if (this.canWriteResponse(res)) {
        this.writeStreamingErrorAndDone(res, completionId, created, '\n[Error: Agent busy]');
      }
      return;
    }

    log.error('Streaming completion error', { error: String(err) });
    if (this.canWriteResponse(res)) {
      this.writeStreamingErrorAndDone(
        res,
        completionId,
        created,
        '\n[Error: Internal server error]',
      );
    }
  }

  private async handleNonStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
  ): Promise<void> {
    if (this.runtime) {
      try {
        const result = await this.awaitRuntimeOrInterrupt(
          req,
          res,
          (signal) => this.runtime!.handleChatCompletion({
            request,
            principal,
            headers: this.extractRpcHeaders(req),
            signal,
          }),
        );
        if (!this.canWriteResponse(res)) return;
        if (!result.ok) {
          this.sendRuntimeError(
            res,
            result.error.status,
            result.error.type,
            result.error.message,
            result.error.details,
          );
          return;
        }

        const response = buildChatCompletionResponse({
          id: `chatcmpl-${randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          model: this.modelName,
          content: result.response.content,
          inputTokens: result.response.inputTokens,
          outputTokens: result.response.outputTokens,
        });

        sendJson(res, 200, response);
      } catch (err) {
        this.handleNonStreamingTurnError(res, err);
      }
      return;
    }

    const turn = await this.startTurn(request, req, res, principal);
    if (!turn) return;

    try {
      const agentResponse = await this.awaitTurnOrInterrupt(
        turn.channelId,
        req,
        res,
        turn.turnPromise,
      );
      if (!this.canWriteResponse(res)) return;

      const response = buildChatCompletionResponse({
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: this.modelName,
        content: agentResponse.content,
        inputTokens: agentResponse.metadata.inputTokens,
        outputTokens: agentResponse.metadata.outputTokens,
      });

      sendJson(res, 200, response);
    } catch (err) {
      this.handleNonStreamingTurnError(res, err);
    }
  }
  private async handleStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
  ): Promise<void> {
    if (this.runtime) {
      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      res.writeHead(200, SSE_RESPONSE_HEADERS);
      const roleChunk = buildStreamingRoleChunk({
        completionId,
        created,
        model: this.modelName,
      });
      this.writeStreamingChunk(res, roleChunk);

      try {
        const result = await this.awaitRuntimeOrInterrupt(
          req,
          res,
          (signal) => this.runtime!.handleChatCompletion({
            request,
            principal,
            headers: this.extractRpcHeaders(req),
            signal,
            onDelta: (text) => {
              const chunk = buildStreamingContentChunk({
                completionId,
                created,
                model: this.modelName,
              }, text);
              this.writeStreamingChunk(res, chunk);
            },
          }),
        );
        if (!this.canWriteResponse(res)) return;
        if (!result.ok) {
          this.writeStreamingErrorAndDone(
            res,
            completionId,
            created,
            `\n[Error: ${result.error.message}]`,
          );
          return;
        }

        const finishChunk = buildStreamingFinishChunk({
          completionId,
          created,
          model: this.modelName,
        });
        this.writeStreamingChunk(res, finishChunk);
        this.writeStreamingDone(res);
      } catch (err) {
        this.handleStreamingTurnError(res, err, completionId, created);
      } finally {
        if (this.canWriteResponse(res)) {
          res.end();
        }
      }
      return;
    }

    const pendingTurn = await this.prepareTurn(request, req, res, principal);
    if (!pendingTurn) return;

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Set SSE headers
    res.writeHead(200, SSE_RESPONSE_HEADERS);

    // Send initial role chunk
    const roleChunk = buildStreamingRoleChunk({
      completionId,
      created,
      model: this.modelName,
    });
    this.writeStreamingChunk(res, roleChunk);

    // Subscribe to stream deltas for this channelId
    const unsubscribe = this.eventBus.on('agent.stream.delta', (data) => {
      if (data.channelId !== pendingTurn.channelId) return;
      const chunk = buildStreamingContentChunk({
        completionId,
        created,
        model: this.modelName,
      }, data.text);
      this.writeStreamingChunk(res, chunk);
    });
    const turn = this.beginPreparedTurn(pendingTurn);

    try {
      await this.awaitTurnOrInterrupt(turn.channelId, req, res, turn.turnPromise);
      if (!this.canWriteResponse(res)) return;

      // Send finish chunk
      const finishChunk = buildStreamingFinishChunk({
        completionId,
        created,
        model: this.modelName,
      });
      this.writeStreamingChunk(res, finishChunk);
      this.writeStreamingDone(res);
    } catch (err) {
      this.handleStreamingTurnError(res, err, completionId, created);
    } finally {
      unsubscribe();
      if (this.canWriteResponse(res)) {
        res.end();
      }
    }
  }

  private sendError(
    res: ServerResponse,
    status: number,
    type: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    sendJson(res, status, buildApiErrorEnvelope(type, message, details));
  }
}
