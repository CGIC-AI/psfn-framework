// ── OpenAI-compatible API Server ──
// Exposes GET /v1/models and POST /v1/chat/completions.
// Uses Node.js built-in http module — no framework dependency.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
  SatelliteTelemetryAuthContext,
} from '../../shared/contracts/satellite-registry.js';
import { validateSatelliteApiKeys, type ApiAuthPrincipal } from '../backplane/http/auth.js';
import {
  deriveClientCertIdentity,
  parseTrustedProxyClientCertToken,
  stripClientCertHeaders,
} from '../backplane/http/client-cert.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { EventBus, ExternalTelemetryEvent } from '../../shared/event-bus.js';
import {
  createEventBusSensorIngestPort,
  type SensorIngestPort,
} from '../../shared/telemetry/sensor-ingest-port.js';
import type { SessionManager } from '../../core/session/manager.js';
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
  ApiServerHealthChecks,
  ApiServerRuntime,
  TelemetryIngestRequest,
  TelemetryIngestResponse,
} from './types.js';
import { API_CONTINUITY_WATCHDOG_CHECKS, API_HEALTH_SUBSYSTEMS } from './types.js';
import { createComponentLogger } from '../../shared/logger.js';
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
  clampHttpHeader as clampHeaderValue,
  normalizeCorsAllowedOrigins,
} from './http-policy.js';
import type { ExternalChannelProfileConfig } from '../backplane/config.js';
import { resolveCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import { ApiChatCompletionsHandler } from './server/chat-completions.js';
import {
  applyApiCorsPolicy,
  canWriteResponse,
  createApiHttpServer,
  listenApiHttpServer,
  MAX_BODY_SIZE,
  parseChatRequestTimeoutMs,
  parseSchedulerHealthcheckStaleAfterMs,
  sendApiError,
  stopApiHttpServer,
  type ApiHttpServer,
  type ApiHttpServerTlsConfig,
} from './server/http.js';
import {
  resolveApiServerRequestPrincipal,
  validateApiServerAuthConfig,
} from './server/auth.js';
import { handleModelsEndpoint } from './server/models.js';
import { resolveSatelliteConfigPull } from '../backplane/satellite-registry.js';

const log = createComponentLogger('ApiServer');
const API_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;
const TELEMETRY_MAX_SKEW_MS = 5 * 60_000;
const TELEMETRY_NONCE_TTL_MS = 10 * 60_000;
const TELEMETRY_EVENT_TYPE_ALLOWLIST = new Set([
  'external.telemetry.heartbeat',
  'external.telemetry.status',
  'external.telemetry.incident',
]);

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

// ── Sprint-10 H5: telemetry payload screening at the ingest boundary ──
// Raw biometrics (face vectors/embeddings/descriptors, iris/retina templates,
// image blobs) must NOT cross the door. The ingest schema deliberately accepts
// an open `payload` object, but before that payload is copied verbatim into the
// emitted `external.telemetry.ingested` event (and thence onto every Garden
// admin WebSocket client), we fail closed on:
//   - biometric-shaped keys anywhere in the object graph,
//   - raw-media/blob keys,
//   - value shapes that look like embeddings (long numeric arrays) or raw media
//     (very long strings),
//   - oversized / over-deep / over-wide structures,
//   - top-level keys outside the per-eventType allowlist.
const TELEMETRY_PAYLOAD_MAX_BYTES = 16 * 1024;
const TELEMETRY_PAYLOAD_MAX_DEPTH = 6;
const TELEMETRY_PAYLOAD_MAX_KEYS = 64;
const TELEMETRY_PAYLOAD_MAX_ARRAY_LENGTH = 16;
const TELEMETRY_PAYLOAD_MAX_STRING_LENGTH = 2_048;
// A numeric array this long or longer is treated as an embedding/descriptor,
// regardless of the (possibly innocuous) key it hides behind.
const TELEMETRY_PAYLOAD_NUMERIC_VECTOR_THRESHOLD = 8;

const TELEMETRY_BIOMETRIC_KEY_PATTERNS: readonly RegExp[] = [
  /vector/i,
  /embedding/i,
  /descriptor/i,
  /template/i,
  /biometric/i,
  /faceprint/i,
  /faceid/i,
  /landmark/i,
  /iris/i,
  /retina/i,
  /fingerprint/i,
  /minutiae/i,
];
const TELEMETRY_RAW_MEDIA_KEY_PATTERNS: readonly RegExp[] = [
  /^image$/i,
  /image[_-]?bytes/i,
  /^frame$/i,
  /^photo$/i,
  /photo[_-]?bytes/i,
  /raw[_-]?image/i,
  /^jpe?g$/i,
  /^png$/i,
  /^bytes$/i,
  /^blob$/i,
  /pixels/i,
];

// Origin-binding and event-descriptor fields shared by every accepted event
// type. These are also the fields the sensor-cognition bridge reads to resolve
// a satellite/place origin and normalize presence/identity-claim perceptions.
const TELEMETRY_COMMON_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'satelliteId', 'satellite_id',
  'placeId', 'place_id',
  'siteId', 'site_id',
  'affordanceId', 'affordance_id',
  'origin', 'satellite', 'site', 'sensor',
  'channelId',
  'type', 'kind', 'event', 'eventType', 'action', 'state', 'status',
  'timestamp', 'ts', 'sequence', 'seq',
]);

const TELEMETRY_PAYLOAD_KEYS_BY_EVENT_TYPE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['external.telemetry.heartbeat', new Set([
    'uptime', 'uptimeMs', 'uptime_ms', 'load', 'cpu', 'cpuLoad',
    'memory', 'memoryMb', 'battery', 'batteryPct', 'rssi', 'signal',
    'firmware', 'version', 'online', 'healthy',
  ])],
  ['external.telemetry.status', new Set([
    // presence + identity-claim perceptions ride the status event type
    'present', 'detected', 'occupied', 'presence',
    'confidence', 'score', 'probability',
    'occupancyCount', 'occupancy_count', 'count',
    'identityClaim', 'identity_claim', 'claim',
    'hubIdentityId', 'hub_identity_id',
    'load', 'battery', 'online', 'healthy', 'detail', 'message',
  ])],
  ['external.telemetry.incident', new Set([
    'severity', 'level', 'code', 'category',
    'message', 'detail', 'reason', 'error',
    'count', 'confidence',
  ])],
]);

export interface TelemetryPayloadScreenFailure {
  ok: false;
  errorType: string;
  message: string;
}

export type TelemetryPayloadScreenResult = { ok: true } | TelemetryPayloadScreenFailure;

function keyMatchesAny(key: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(key));
}

function screenTelemetryPayloadNode(
  value: unknown,
  depth: number,
): TelemetryPayloadScreenFailure | undefined {
  if (depth > TELEMETRY_PAYLOAD_MAX_DEPTH) {
    return {
      ok: false,
      errorType: 'payload_shape_invalid',
      message: `payload nesting exceeds ${TELEMETRY_PAYLOAD_MAX_DEPTH} levels`,
    };
  }

  if (typeof value === 'string') {
    if (value.length > TELEMETRY_PAYLOAD_MAX_STRING_LENGTH) {
      return {
        ok: false,
        errorType: 'biometric_payload_rejected',
        message: 'payload contains an oversized string (possible raw media/biometric blob)',
      };
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    if (value.length > TELEMETRY_PAYLOAD_MAX_ARRAY_LENGTH) {
      return {
        ok: false,
        errorType: 'payload_shape_invalid',
        message: `payload array exceeds ${TELEMETRY_PAYLOAD_MAX_ARRAY_LENGTH} elements`,
      };
    }
    if (
      value.length >= TELEMETRY_PAYLOAD_NUMERIC_VECTOR_THRESHOLD
      && value.every((entry) => typeof entry === 'number')
    ) {
      return {
        ok: false,
        errorType: 'biometric_payload_rejected',
        message: 'payload contains a numeric vector (possible embedding/descriptor)',
      };
    }
    for (const entry of value) {
      const failure = screenTelemetryPayloadNode(entry, depth + 1);
      if (failure) return failure;
    }
    return undefined;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (keyMatchesAny(key, TELEMETRY_BIOMETRIC_KEY_PATTERNS)) {
        return {
          ok: false,
          errorType: 'biometric_payload_rejected',
          message: `payload key "${key}" is a raw-biometric-shaped field and is not accepted`,
        };
      }
      if (keyMatchesAny(key, TELEMETRY_RAW_MEDIA_KEY_PATTERNS)) {
        return {
          ok: false,
          errorType: 'biometric_payload_rejected',
          message: `payload key "${key}" is a raw-media/blob field and is not accepted`,
        };
      }
      const failure = screenTelemetryPayloadNode(nested, depth + 1);
      if (failure) return failure;
    }
    return undefined;
  }

  return undefined;
}

function countTelemetryPayloadKeys(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((total, entry) => total + countTelemetryPayloadKeys(entry), 0);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.reduce<number>(
      (total, [, nested]) => total + 1 + countTelemetryPayloadKeys(nested),
      0,
    );
  }
  return 0;
}

export function screenTelemetryIngestPayload(
  eventType: string,
  payload: Record<string, unknown>,
): TelemetryPayloadScreenResult {
  // Size ceiling (well under the 1MB body limit): telemetry heartbeats/status/
  // incidents are small. Anything larger is an exfiltration/blob vector.
  const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (serializedBytes > TELEMETRY_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      errorType: 'payload_too_large',
      message: `payload exceeds ${TELEMETRY_PAYLOAD_MAX_BYTES} bytes`,
    };
  }
  if (countTelemetryPayloadKeys(payload) > TELEMETRY_PAYLOAD_MAX_KEYS) {
    return {
      ok: false,
      errorType: 'payload_shape_invalid',
      message: `payload exceeds ${TELEMETRY_PAYLOAD_MAX_KEYS} keys`,
    };
  }

  // Biometric / raw-media / vector screening across the whole object graph.
  const structuralFailure = screenTelemetryPayloadNode(payload, 0);
  if (structuralFailure) return structuralFailure;

  // Per-eventType top-level shape allowlist (fail closed on unknown fields).
  const allowedForEventType = TELEMETRY_PAYLOAD_KEYS_BY_EVENT_TYPE.get(eventType);
  if (!allowedForEventType) {
    return {
      ok: false,
      errorType: 'event_type_not_allowed',
      message: `no payload shape is defined for eventType ${eventType}`,
    };
  }
  for (const key of Object.keys(payload)) {
    if (TELEMETRY_COMMON_PAYLOAD_KEYS.has(key)) continue;
    if (allowedForEventType.has(key)) continue;
    return {
      ok: false,
      errorType: 'payload_field_not_allowed',
      message: `payload key "${key}" is not allowed for eventType ${eventType}`,
    };
  }

  return { ok: true };
}

export interface ApiServerConfig {
  port: number;
  host?: string;
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  sessionManager: SessionManager;
  companionId?: string;
  companionName?: string;
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
  satelliteRegistry?: SatelliteRegistryConfig;
  sensorIngest?: SensorIngestPort;
  /**
   * Per-satellite bearer credentials (`API_SATELLITE_KEYS`), each yielding a
   * distinct satellite-scoped principal (Sprint-10 finding H4).
   */
  satelliteApiKeys?: string[];
  /**
   * Shared secret a TLS-terminating proxy must present in
   * `X-PSFN-Trusted-Proxy-Token` for its `X-PSFN-Client-Cert-*` headers to be
   * honored (`API_TRUSTED_PROXY_CLIENT_CERT_TOKEN`). Unset means
   * header-asserted client certificates are never accepted.
   */
  trustedProxyClientCertToken?: string;
  /** Direct-TLS listener config (`API_TLS_CERT_PATH`/`API_TLS_KEY_PATH`/`API_TLS_CLIENT_CA_PATH`). */
  tls?: ApiHttpServerTlsConfig;
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

  private server: ApiHttpServer;
  private port: number;
  private host: string;
  private eventBus: EventBus;
  private sensorIngest: SensorIngestPort;
  private sessionManager: SessionManager;
  private runtime: ApiServerRuntime | null;
  private apiKey?: string;
  private adminToken?: string;
  private satelliteApiKeys: string[];
  private trustedProxyClientCertToken?: string;
  private allowInsecureWithoutAuth: boolean;
  private corsAllowedOrigins: ReturnType<typeof normalizeCorsAllowedOrigins>;
  private modelName: string;
  private companionName: string;
  private requestTimeoutMs: number;
  private seenTelemetryNonces = new Map<string, number>();
  private voiceWebSocket: ApiVoiceWebSocketAdapter;
  private chatCompletions: ApiChatCompletionsHandler;
  private satelliteRegistry?: SatelliteRegistryConfig;
  private healthChecks: ApiServerHealthChecks;
  private schedulerHealthcheckStaleAfterMs: number;
  private lastSchedulerHealthcheckAtMs: number | null = null;
  private unregisterSchedulerHealthcheck: (() => void) | null = null;

  constructor(config: ApiServerConfig) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.eventBus = config.eventBus;
    this.sensorIngest = config.sensorIngest ?? createEventBusSensorIngestPort(this.eventBus);
    this.sessionManager = config.sessionManager;
    this.runtime = config.runtime ?? null;
    this.apiKey = clampHeaderValue(config.apiKey, 512);
    this.adminToken = clampHeaderValue(config.adminToken, 512);
    // Re-validate satellite keys at the trust boundary (fail closed on weak
    // keys or collisions with the shared credentials), even when the caller
    // already parsed them from env.
    this.satelliteApiKeys = validateSatelliteApiKeys(config.satelliteApiKeys ?? [], {
      reservedTokens: [this.apiKey, this.adminToken],
    });
    this.trustedProxyClientCertToken = parseTrustedProxyClientCertToken(config.trustedProxyClientCertToken);
    this.allowInsecureWithoutAuth = config.allowInsecureWithoutAuth === true;
    this.corsAllowedOrigins = normalizeCorsAllowedOrigins(config.corsAllowedOrigins);
    this.modelName = config.modelName ?? resolveCompanionIdFromConfig(config);
    this.companionName = config.companionName?.trim() || this.modelName;
    this.requestTimeoutMs = parseChatRequestTimeoutMs(config.requestTimeoutMs);
    this.healthChecks = config.healthChecks ?? {};
    this.satelliteRegistry = config.satelliteRegistry;
    this.schedulerHealthcheckStaleAfterMs = parseSchedulerHealthcheckStaleAfterMs(
      config.schedulerHealthcheckStaleAfterMs,
    );
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
    this.chatCompletions = new ApiChatCompletionsHandler({
      agentLoop: config.agentLoop,
      eventBus: this.eventBus,
      sessionManager: this.sessionManager,
      contactStore: config.contactStore ?? null,
      runtime: this.runtime,
      modelName: this.modelName,
      requestTimeoutMs: this.requestTimeoutMs,
      externalChannelProfiles: config.externalChannelProfiles ?? {},
      satelliteRegistry: config.satelliteRegistry,
      logger: log,
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
    this.server = createApiHttpServer({
      handleRequest: (req, res) => this.handleRequest(req, res),
      handleUpgrade: (req, socket, head) => this.handleUpgrade(req, socket, head),
    }, config.tls);
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async init(): Promise<void> {}

  async start(): Promise<void> {
    validateApiServerAuthConfig({
      host: this.host,
      port: this.port,
      apiKey: this.apiKey,
      allowInsecureWithoutAuth: this.allowInsecureWithoutAuth,
      logger: log,
    });

    return listenApiHttpServer({
      server: this.server,
      host: this.host,
      port: this.port,
      apiKey: this.apiKey,
      corsAllowedOrigins: this.corsAllowedOrigins,
      logger: log,
    });
  }

  async stop(): Promise<void> {
    this.unregisterSchedulerHealthcheck?.();
    this.unregisterSchedulerHealthcheck = null;
    await this.voiceWebSocket.stop();
    return stopApiHttpServer(this.server);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const handled = this.voiceWebSocket.handleUpgrade(req, socket, head);
    if (!handled) {
      this.voiceWebSocket.rejectUnknownUpgrade(socket);
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!applyApiCorsPolicy(req, res, this.corsAllowedOrigins)) return;

    if (req.method === 'OPTIONS') {
      sendEmpty(res, 204);
      return;
    }

    // Sprint-10 C1: derive the client-certificate identity from the ONLY
    // trusted sources (real TLS peer cert, or a proxy that authenticated
    // itself with the trusted-proxy token), then unconditionally strip the
    // inbound X-PSFN-Client-Cert-* headers so nothing downstream can trust
    // caller-supplied certificate assertions.
    const clientCert = deriveClientCertIdentity(req, {
      ...(this.trustedProxyClientCertToken ? { trustedProxyToken: this.trustedProxyClientCertToken } : {}),
    });
    stripClientCertHeaders(req.headers);

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const isTelemetryIngest = req.method === 'POST' && path === '/v1/telemetry/ingest';
    const principal = resolveApiServerRequestPrincipal(req, res, {
      apiKey: this.apiKey,
      adminToken: this.adminToken,
      ...(this.satelliteApiKeys.length > 0 ? { satelliteApiKeys: this.satelliteApiKeys } : {}),
      allowInsecureWithoutAuth: this.allowInsecureWithoutAuth,
      isTelemetryIngest,
    });
    if (!principal) return;

    // Satellite-scoped credentials are only valid on satellite surfaces
    // (fail closed): claims-bearing chat turns, config pulls, and telemetry.
    if (principal.scope === 'satellite') {
      const satelliteSurface = (req.method === 'GET' && path === '/v1/satellites/config')
        || (req.method === 'POST' && path === '/v1/chat/completions')
        || isTelemetryIngest;
      if (!satelliteSurface) {
        sendApiError(
          res,
          403,
          'satellite_scoped_principal_not_allowed',
          'Satellite-scoped API keys may only access satellite surfaces',
        );
        return;
      }
    }

    if (req.method === 'GET' && path === '/v1/models') {
      handleModelsEndpoint(res, this.modelName);
    } else if (req.method === 'GET' && path === '/v1/identity') {
      this.handleIdentity(res);
    } else if (req.method === 'GET' && path === '/v1/satellites/config') {
      this.handleSatelliteConfigPull(res, url, principal, clientCert);
    } else if (req.method === 'GET' && path === '/health') {
      void this.handleHealth(res);
    } else if (req.method === 'POST' && path === '/v1/chat/completions') {
      void this.chatCompletions.handle(req, res, principal, clientCert);
    } else if (isTelemetryIngest) {
      void this.handleTelemetryIngest(req, res, principal, clientCert);
    } else {
      sendApiError(res, 404, 'not_found', `No route for ${req.method} ${path}`);
    }
  }

  private handleIdentity(res: ServerResponse): void {
    const psfnAmica = this.chatCompletions.externalChannelProfile('psfn-amica');
    sendJson(res, 200, {
      object: 'psfn.identity',
      companion: {
        id: this.modelName,
        name: this.companionName,
      },
      channels: {
        ...(psfnAmica
          ? {
            'psfn-amica': {
              ...(psfnAmica.authorId || psfnAmica.authorName
                ? {
                  user: {
                    ...(psfnAmica.authorId ? { id: psfnAmica.authorId } : {}),
                    ...(psfnAmica.authorName ? { name: psfnAmica.authorName } : {}),
                  },
                }
                : {}),
              ...(psfnAmica.canonicalContactId ? { canonicalContactId: psfnAmica.canonicalContactId } : {}),
              ...(psfnAmica.channelPrivacy ? { channelPrivacy: psfnAmica.channelPrivacy } : {}),
            },
          }
          : {}),
      },
    });
  }

  private handleSatelliteConfigPull(
    res: ServerResponse,
    url: URL,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
  ): void {
    const resolution = resolveSatelliteConfigPull({
      principal,
      registry: this.satelliteRegistry,
      satelliteId: url.searchParams.get('satelliteId') ?? undefined,
      endpointId: url.searchParams.get('endpointId') ?? undefined,
      claimType: url.searchParams.get('claimType') ?? undefined,
      ...(clientCert ? { clientCert } : {}),
    });
    if (!resolution.ok) {
      sendApiError(res, resolution.status, resolution.type, resolution.message);
      return;
    }
    sendJson(res, 200, resolution.value, API_DYNAMIC_JSON_HEADERS);
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

  private async handleTelemetryIngest(
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
  ): Promise<void> {
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
        if (canWriteResponse(res)) {
          sendApiError(res, 500, 'internal_error', 'Internal server error');
        }
        return;
      }
      sendApiError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }

    await this.ingestTelemetryPayload(parsedBody.value, res, principal, clientCert);
  }

  private async ingestTelemetryPayload(
    parsed: unknown,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
  ): Promise<void> {
    if (!Value.Check(telemetryIngestSchema, parsed)) {
      sendApiError(
        res,
        400,
        'invalid_request',
        'Telemetry payload failed schema validation',
      );
      return;
    }

    const telemetry: TelemetryIngestRequest = parsed as TelemetryIngestInput;

    if (!TELEMETRY_EVENT_TYPE_ALLOWLIST.has(telemetry.eventType)) {
      sendApiError(
        res,
        403,
        'event_type_not_allowed',
        `eventType must be one of: ${Array.from(TELEMETRY_EVENT_TYPE_ALLOWLIST).join(', ')}`,
      );
      return;
    }

    // Sprint-10 H5: screen the open payload for raw biometrics, oversized/blob
    // shapes, and out-of-allowlist fields BEFORE it is copied verbatim into the
    // emitted event. Biometrics must not cross the ingest door. Fail closed.
    const payloadScreen = screenTelemetryIngestPayload(telemetry.eventType, telemetry.payload);
    if (!payloadScreen.ok) {
      const status = payloadScreen.errorType === 'payload_too_large' ? 413 : 400;
      sendApiError(res, status, payloadScreen.errorType, payloadScreen.message);
      return;
    }

    const occurredAtMs = Date.parse(telemetry.timestamp);
    if (!Number.isFinite(occurredAtMs)) {
      sendApiError(res, 400, 'invalid_request', 'timestamp must be a valid ISO-8601 string');
      return;
    }

    const now = Date.now();
    if (Math.abs(now - occurredAtMs) > TELEMETRY_MAX_SKEW_MS) {
      sendApiError(
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
      sendApiError(res, 409, 'replay_detected', 'Duplicate nonce detected');
      return;
    }
    this.seenTelemetryNonces.set(nonceKey, now);

    // Sprint-10 04-M1: stamp the authenticated origin so downstream
    // consumers (perception bridge) can bind any payload-claimed satelliteId
    // to the credential that actually authenticated this request.
    const authContext: SatelliteTelemetryAuthContext = {
      principalId: principal.id,
      principalMode: principal.mode,
      satelliteScoped: principal.scope === 'satellite',
      ...(clientCert ? { clientCert } : {}),
    };
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
      auth: authContext,
    };

    if (this.runtime) {
      const result = await this.runtime.handleTelemetryIngest(normalizedEvent);
      if (!result.ok) {
        if (canWriteResponse(res)) {
          sendApiError(
            res,
            result.error.status,
            result.error.type,
            result.error.message,
            result.error.details,
          );
        }
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
}
