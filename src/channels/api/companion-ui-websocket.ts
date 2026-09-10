import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type {
  SatelliteCapability,
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
  SatelliteTelemetryScope,
} from '../../shared/contracts/satellite-registry.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { GatewayHubDeviceIngressService } from '../../boundary/fleet-auth/hub-device-ingress.js';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import type {
  CompanionUiActionBrokerInput,
  GatewayCompanionUiActionBroker,
} from '../../boundary/gateway/companion-ui-action-broker.js';
import type { CompanionUiAudioIngressPort } from '../../boundary/gateway/companion-ui-audio-ingress.js';
import {
  parseCompanionUiActionFrame,
  parseCompanionUiSessionConfigureFrame,
} from '../../boundary/fleet-auth/companion-ui-action.js';
import {
  COMPANION_APPROVALS_V2_CAPABILITY,
  companionEventKindsForScopes,
  type CompanionApprovalRequestedPayload,
  type CompanionApprovalResolvedPayload,
  type CompanionEventEnvelope,
  type CompanionEventKind,
} from '../../shared/contracts/companion-relay.js';
import type { CompanionEventRelay } from '../backplane/companion-relay/relay.js';
import {
  getBearerToken,
  isExpectedApiToken,
  principalFromApiKeyToken,
  principalFromSatelliteApiKeyToken,
  type UnscopedApiAuthPrincipal,
} from '../backplane/http/auth.js';
import { isLoopbackHost } from '../../shared/net/hosts.js';
import {
  deriveClientCertIdentity,
  stripClientCertHeaders,
} from '../backplane/http/client-cert.js';
import { resolveSatelliteClaim, SATELLITE_CLAIM_HEADERS } from '../backplane/satellite-registry.js';
import {
  extractCanonicalHubDeviceAssertion,
  resolveAuthenticatedHubDeviceConnection,
} from './server/hub-device-ingress.js';
import { readExclusiveFleetSessionCookie } from './server/fleet-auth-cookie.js';
import { REQUEST_CAPABILITY_ASSERTION_HEADERS } from '../../boundary/fleet-auth/request-capability-transport.js';
import { CompanionUiAudioSocketSession } from './companion-ui-audio-socket.js';
import type { CompanionUiAudioOutputRelay } from '../backplane/companion-ui-audio-output-relay.js';
import type { CompanionUiAudioOutputBinding } from '../../shared/contracts/companion-ui-audio-output.js';
import {
  CompanionUiSessionAuthority,
  parseCompanionUiSessionRenewal,
} from './companion-ui-session-renewal.js';
import { proxyCompanionUiBrowserUpgrade } from './companion-ui-hub-proxy.js';

const log = createComponentLogger('CompanionUiWebSocket');
const PATH_PATTERN = /^\/companion-ui\/companions\/([0-9a-f-]+)\/ws$/u;
const CLOSE = Object.freeze({ denied: 4403, authorityChanged: 4401, shutdown: 1012 });
const RUNTIME_LIMITS = Object.freeze({
  maxPayloadBytes: 1_048_576,
  maxRequestIdsPerSocket: 4_096,
  authorityPollMs: 5_000,
  maxPendingAudioFrames: 32,
});
/**
 * Ceiling advertised to a key-authenticated (ADMIN_TOKEN / API_KEY) session.
 * There is no Hub device behind it, so the ceiling is the operator's own: every
 * relay scope, and the audio input capabilities only when STT is composed.
 * `audio_output` is deliberately absent: Hub audio brackets are bound to a
 * satellite endpoint and a key session has none.
 */
const OPERATOR_KEY_CEILING = Object.freeze({
  capabilities: Object.freeze<SatelliteCapability[]>(['text', 'vision', 'image_upload', 'touch']),
  audioCapabilities: Object.freeze<SatelliteCapability[]>(['audio_input', 'speech_to_text']),
  telemetryScopes: Object.freeze<SatelliteTelemetryScope[]>([
    'status', 'approvals', 'artifacts', 'tool_activity', 'emotion',
  ]),
});
const OPERATOR_KEY_DEVICE = Object.freeze({ id: 'operator-key', label: 'Operator key' });
const FORBIDDEN_BROWSER_AUTHORITY_HEADERS = new Set([
  'x-author-id', 'x-author-name', 'x-canonical-contact-id', 'x-channel-id', 'x-channel-type',
  'x-companion-id', 'x-device-id', 'x-place-id', 'x-psfn-action', 'x-psfn-author',
  'x-psfn-author-id', 'x-psfn-author-name', 'x-psfn-capability', 'x-psfn-channel-id',
  'x-psfn-companion-id', 'x-psfn-request-capability', 'x-psfn-resource',
  ...REQUEST_CAPABILITY_ASSERTION_HEADERS,
]);

/**
 * Key-path action broker (psfn-framework-7oh9y). A session admitted with an
 * ADMIN_TOKEN / API_KEY bearer carries no Hub device attachment and no fleet
 * authorization context; the gateway dispatches its frames with the key
 * principal exactly as the REST API would.
 */
export interface CompanionUiOperatorActionBroker {
  execute(input: Readonly<{
    rawBody: Uint8Array;
    companionId: CompanionId;
    principal: UnscopedApiAuthPrincipal;
    physicalCeiling: Readonly<{
      capabilities: readonly SatelliteCapability[];
      telemetryScopes: readonly SatelliteTelemetryScope[];
    }>;
    /** Server-owned cancellation only; never parsed from the browser frame. */
    signal?: AbortSignal;
  }>): Promise<unknown>;
}

export interface CompanionUiWebSocketConfig {
  readonly browserHubOrigin?: string;
  readonly browserHubTimeoutMs?: number;
  /**
   * Exact origin the socket is pinned to. HTTPS, or plain HTTP on a loopback
   * host only (the same transport policy the key-authenticated REST API has).
   */
  readonly canonicalOrigin: string;
  /**
   * Hub path: a Satellite Hub backchannel (satellite key + Hub device
   * assertion) relaying a browser that carries a fleet SSO session cookie, or
   * an explicit guest. Composed whenever a Hub device verifier exists.
   */
  readonly satelliteApiKeys?: readonly string[];
  readonly satelliteRegistry?: SatelliteRegistryConfig;
  readonly trustedProxyClientCertToken?: string;
  readonly hubDeviceIngress?: GatewayHubDeviceIngressService;
  /** SSO composition; without it cookie-bearing Hub upgrades are denied. */
  readonly actionBroker?: GatewayCompanionUiActionBroker;
  /**
   * Key path (psfn-framework-7oh9y): ADMIN_TOKEN / API_KEY bearers admitted
   * directly on the upgrade, with no Hub, device assertion, or SSO session.
   * Fleet auth adds SSO; it is never a precondition for this surface.
   */
  readonly operatorKeys?: readonly string[];
  readonly operatorActionBroker?: CompanionUiOperatorActionBroker;
  readonly audioIngress?: CompanionUiAudioIngressPort;
  readonly screenAudioTranscript?: (
    input: Readonly<{
      companionId: CompanionId;
      /** Absent on the key path: there is no Hub device attachment. */
      attachment?: HubDeviceAttachmentSnapshot;
      requestId: string;
      transcript: string;
    }>,
  ) => Promise<string>;
  readonly cancelAudioInteraction?: (
    input: Readonly<{
      companionId: CompanionId;
      attachment?: HubDeviceAttachmentSnapshot;
      interactionId: string;
    }>,
  ) => Promise<void>;
  readonly eventRelay: CompanionEventRelay;
  readonly audioOutputRelay?: CompanionUiAudioOutputRelay;
  readonly guestMode?: 'disabled' | 'explicit';
  readonly guestActionBroker?: Readonly<{
    execute(input: Omit<Parameters<GatewayCompanionUiActionBroker['execute']>[0], 'sessionToken'>): Promise<unknown>;
  }>;
  readonly authorityPollMs?: number;
  readonly maxPendingAudioFrames?: number;
  readonly createWebSocketServer?: () => WebSocketServer;
}

interface OperatorUpgradeAuthority {
  readonly kind: 'operator_key';
  readonly companionId: CompanionId;
  readonly principal: UnscopedApiAuthPrincipal;
  readonly physicalCeiling: Readonly<{
    capabilities: readonly SatelliteCapability[];
    telemetryScopes: readonly SatelliteTelemetryScope[];
  }>;
}

interface UpgradeAuthority {
  readonly companionId: CompanionId;
  readonly sessionToken?: string;
  readonly assertion: string;
  readonly clientCert?: SatelliteClientCertIdentity;
  readonly principal: ReturnType<typeof principalFromSatelliteApiKeyToken>;
  readonly connection: ReturnType<typeof resolveAuthenticatedHubDeviceConnection>;
  readonly physicalCeiling: Readonly<{
    capabilities: readonly SatelliteCapability[];
    telemetryScopes: readonly SatelliteTelemetryScope[];
  }>;
  readonly deviceTransport: Readonly<{
    principal: ReturnType<typeof principalFromSatelliteApiKeyToken>;
    headers: Readonly<Record<string, string>>;
    clientCert?: SatelliteClientCertIdentity;
  }>;
  readonly presentation: Readonly<{
    device: Readonly<{ id: string; label: string }>;
    place?: Readonly<{ id: string; label: string }>;
  }>;
  readonly audioOutputBinding: CompanionUiAudioOutputBinding;
}

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function hasForbiddenAuthorityHeader(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (FORBIDDEN_BROWSER_AUTHORITY_HEADERS.has(request.rawHeaders[index]?.toLowerCase() ?? '')) return true;
  }
  return false;
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 404): void {
  if (socket.destroyed) return;
  const text = status === 400 ? 'Bad Request'
    : status === 401 ? 'Unauthorized'
      : status === 403 ? 'Forbidden'
        : 'Not Found';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function rawDataBytes(raw: RawData): Uint8Array {
  if (raw instanceof Buffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function projectCompanionEventFrame(
  envelope: CompanionEventEnvelope,
  eventCapabilities: readonly string[],
): Readonly<{
  schemaVersion: 1;
  type: 'event';
  event: Readonly<{ type: CompanionEventKind; data: unknown }>;
}> {
  if (envelope.kind === 'approval.requested') {
    if (!eventCapabilities.includes(COMPANION_APPROVALS_V2_CAPABILITY)) {
      throw new Error('Companion UI approval event requires approvals.v2');
    }
    const payload = envelope.payload as CompanionApprovalRequestedPayload;
    if (!payload.sourceSystem || !payload.attribution || !payload.action
      || !payload.scope || !payload.reason || !payload.grantMode
      || payload.attribution.parentId !== envelope.companionId
      || payload.attribution.shardId !== envelope.shardId) {
      throw new Error('Companion UI approval event is missing required v2 fields');
    }
  } else if (envelope.kind === 'approval.resolved') {
    const payload = envelope.payload as CompanionApprovalResolvedPayload;
    if (!envelope.companionId || payload.shardId !== envelope.shardId) {
      throw new Error('Companion UI approval resolution has mismatched routing metadata');
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    type: 'event',
    event: Object.freeze({ type: envelope.kind, data: envelope.payload }),
  });
}

export class CompanionUiWebSocketAdapter {
  private readonly expectedOrigin: string;
  private readonly expectedHost: string;
  private readonly authorityPollMs: number;
  private readonly maxPendingAudioFrames: number;
  private readonly webSocketServer: WebSocketServer;
  private readonly activeSockets = new Set<WebSocket>();
  private stopped = false;

  private readonly hubPath: boolean;
  private readonly keyPath: boolean;

  constructor(private readonly config: CompanionUiWebSocketConfig) {
    const origin = new URL(config.canonicalOrigin);
    const loopbackHttp = origin.protocol === 'http:' && isLoopbackHost(origin.hostname);
    if ((origin.protocol !== 'https:' && !loopbackHttp) || origin.origin !== config.canonicalOrigin) {
      throw new Error('Companion UI canonical origin must be an exact HTTPS origin (or HTTP on loopback)');
    }
    this.hubPath = (config.satelliteApiKeys?.length ?? 0) > 0
      && config.satelliteRegistry?.enabled === true
      && config.hubDeviceIngress !== undefined;
    this.keyPath = (config.operatorKeys?.length ?? 0) > 0
      && config.operatorActionBroker !== undefined;
    if (!this.hubPath && !this.keyPath) {
      throw new Error(
        'Companion UI requires authenticated Satellite Hub registry authority or an operator key',
      );
    }
    if (this.hubPath && (config.satelliteApiKeys ?? []).some(
      key => (config.operatorKeys ?? []).some(operatorKey => isExpectedApiToken(key, operatorKey)),
    )) {
      throw new Error('Companion UI operator keys must be distinct from satellite keys');
    }
    if (Boolean(config.audioIngress) !== Boolean(config.screenAudioTranscript)
      || Boolean(config.audioIngress) !== Boolean(config.cancelAudioInteraction)) {
      throw new Error('Companion UI audio ingress requires screening and interruption');
    }
    this.expectedOrigin = origin.origin;
    if (config.browserHubOrigin) {
      const hubOrigin = new URL(config.browserHubOrigin);
      if (!['http:', 'https:'].includes(hubOrigin.protocol)
        || hubOrigin.origin !== config.browserHubOrigin
        || hubOrigin.username || hubOrigin.password || hubOrigin.origin === origin.origin
        || !Number.isSafeInteger(config.browserHubTimeoutMs) || Number(config.browserHubTimeoutMs) < 1) {
        throw new Error('Companion UI Hub origin must be an exact separate internal origin');
      }
    }
    this.expectedHost = origin.host;
    this.authorityPollMs = config.authorityPollMs ?? RUNTIME_LIMITS.authorityPollMs;
    if (!Number.isSafeInteger(this.authorityPollMs) || this.authorityPollMs < 250) {
      throw new Error('Companion UI authority poll interval is invalid');
    }
    this.maxPendingAudioFrames = config.maxPendingAudioFrames
      ?? RUNTIME_LIMITS.maxPendingAudioFrames;
    if (!Number.isSafeInteger(this.maxPendingAudioFrames)
      || this.maxPendingAudioFrames < 1) {
      throw new Error('Companion UI audio backpressure limit is invalid');
    }
    this.webSocketServer = config.createWebSocketServer?.()
      ?? new WebSocketServer({ noServer: true, maxPayload: RUNTIME_LIMITS.maxPayloadBytes });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const rawTarget = request.url ?? '';
    const path = rawTarget.split('?', 1)[0] ?? '';
    if (!path.startsWith('/companion-ui/')) return false;
    const match = PATH_PATTERN.exec(path);
    if (!match || rawTarget !== path || !isRfc4122Uuid(match[1])) {
      rejectUpgrade(socket, 404);
      return true;
    }
    if (this.hubPath && this.config.browserHubOrigin && rawHeaderCount(request, 'authorization') === 0) {
      proxyCompanionUiBrowserUpgrade({ request, socket, head,
        hubOrigin: this.config.browserHubOrigin, canonicalOrigin: this.expectedOrigin,
        timeoutMs: this.config.browserHubTimeoutMs!, allowGuest: this.config.guestMode === 'explicit' });
    } else {
      void this.admitUpgrade(request, socket, head, match[1] as CompanionId);
    }
    return true;
  }

  rejectUnknownUpgrade(socket: Duplex): void {
    rejectUpgrade(socket, 404);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const socket of this.activeSockets) socket.close(CLOSE.shutdown, 'server shutdown');
    this.activeSockets.clear();
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close(error => {
        if (error && error.message !== 'The server is not running') reject(error);
        else resolve();
      });
    });
  }

  private async admitUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    companionId: CompanionId,
  ): Promise<void> {
    let authority: UpgradeAuthority;
    try {
      this.assertUpgradeMetadata(request);
      const operatorKey = this.keyPath
        ? this.config.operatorKeys!.find(key => isExpectedApiToken(getBearerToken(request), key))
        : undefined;
      if (operatorKey !== undefined) {
        const operator = this.resolveOperatorUpgradeAuthority(request, companionId, operatorKey);
        this.webSocketServer.handleUpgrade(request, socket, head, webSocket => {
          this.attachOperatorSocket(webSocket, operator);
        });
        return;
      }
      if (!this.hubPath) throw new Error('authenticated Hub backchannel required');
      authority = this.resolveUpgradeAuthority(request, companionId);
      const admission = await this.config.hubDeviceIngress!.admit({
        assertion: authority.assertion,
        connection: authority.connection,
        human: authority.sessionToken
          ? { kind: 'fleet_browser_session', sessionToken: authority.sessionToken }
          : { kind: 'guest' },
      });
      if (authority.sessionToken && admission.attachment.actor.kind !== 'human') {
        throw new Error('current human attachment required');
      }
      if (!authority.sessionToken && admission.attachment.actor.kind !== 'guest') {
        throw new Error('guest attachment required');
      }
      this.webSocketServer.handleUpgrade(request, socket, head, webSocket => {
        this.attachSocket(webSocket, authority, admission.attachment);
      });
    } catch {
      rejectUpgrade(socket, 403);
    }
  }

  private assertUpgradeMetadata(request: IncomingMessage): void {
    if (this.stopped
      || rawHeaderCount(request, 'host') !== 1
      || rawHeaderCount(request, 'origin') !== 1
      || rawHeaderCount(request, 'authorization') !== 1
      || rawHeaderCount(request, 'sec-websocket-protocol') !== 0
      || request.headers.host !== this.expectedHost
      || request.headers.origin !== this.expectedOrigin
      || hasForbiddenAuthorityHeader(request)) throw new Error('invalid upgrade metadata');
  }

  /**
   * Key path: the bearer IS the human authority. No cookie, no Hub claim, no
   * device assertion, no proxied client certificate may ride along — a key
   * session never borrows Hub or SSO provenance.
   */
  private resolveOperatorUpgradeAuthority(
    request: IncomingMessage,
    companionId: CompanionId,
    operatorKey: string,
  ): OperatorUpgradeAuthority {
    if (rawHeaderCount(request, 'cookie') !== 0) throw new Error('operator key sessions carry no cookie');
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]?.toLowerCase() ?? '';
      if (name.startsWith('x-psfn-') || name.startsWith('x-identity-claim-')) {
        throw new Error('operator key sessions carry no Hub or identity claims');
      }
    }
    delete request.headers.authorization;
    const audio = this.config.audioIngress !== undefined
      && this.config.screenAudioTranscript !== undefined
      && this.config.cancelAudioInteraction !== undefined;
    return Object.freeze({
      kind: 'operator_key' as const,
      companionId,
      principal: principalFromApiKeyToken(operatorKey),
      physicalCeiling: Object.freeze({
        capabilities: Object.freeze([
          ...OPERATOR_KEY_CEILING.capabilities,
          ...(audio ? OPERATOR_KEY_CEILING.audioCapabilities : []),
        ]),
        telemetryScopes: OPERATOR_KEY_CEILING.telemetryScopes,
      }),
    });
  }

  private resolveUpgradeAuthority(request: IncomingMessage, companionId: CompanionId): UpgradeAuthority {
    const sessionToken = readExclusiveFleetSessionCookie(request);
    const cookieCount = rawHeaderCount(request, 'cookie');
    if (sessionToken ? cookieCount !== 1 : cookieCount !== 0) throw new Error('invalid fleet session cookie');
    if (!sessionToken && this.config.guestMode !== 'explicit') throw new Error('fleet session required');
    if (sessionToken && !this.config.actionBroker) throw new Error('fleet SSO is not composed');
    const bearer = getBearerToken(request);
    const satelliteKey = this.config.satelliteApiKeys!.find(key => isExpectedApiToken(bearer, key));
    if (!satelliteKey) throw new Error('authenticated Hub backchannel required');
    const principal = principalFromSatelliteApiKeyToken(satelliteKey);
    const clientCert = deriveClientCertIdentity(request, {
      ...(this.config.trustedProxyClientCertToken
        ? { trustedProxyToken: this.config.trustedProxyClientCertToken }
        : {}),
    });
    if (!(request.socket instanceof TLSSocket) && clientCert?.source !== 'trusted_proxy') {
      throw new Error('WSS transport required');
    }
    const satellite = resolveSatelliteClaim({
      headers: request.headers,
      principal,
      registry: this.config.satelliteRegistry!,
      ...(clientCert ? { clientCert } : {}),
    });
    if (!satellite.ok) throw new Error('Hub claim denied');
    const assertion = extractCanonicalHubDeviceAssertion(request);
    const connection = resolveAuthenticatedHubDeviceConnection({
      req: request,
      principal,
      registry: this.config.satelliteRegistry!,
      companionId,
      ...(clientCert ? { clientCert } : {}),
    });
    delete request.headers.authorization;
    delete request.headers.cookie;
    stripClientCertHeaders(request.headers);
    const deviceHeaders = Object.freeze({
      [SATELLITE_CLAIM_HEADERS.claimType]: satellite.value.satellite.claimType,
      [SATELLITE_CLAIM_HEADERS.satelliteId]: satellite.value.satellite.satelliteId,
      [SATELLITE_CLAIM_HEADERS.endpointId]: satellite.value.satellite.endpointId,
      [SATELLITE_CLAIM_HEADERS.sessionId]: satellite.value.satellite.sessionId,
      [SATELLITE_CLAIM_HEADERS.capabilities]: satellite.value.satellite.capabilities.effective.join(','),
      [SATELLITE_CLAIM_HEADERS.telemetryScopes]: satellite.value.satellite.telemetryScopes.join(','),
    });
    return Object.freeze({
      companionId,
      ...(sessionToken ? { sessionToken } : {}),
      assertion,
      principal,
      connection,
      physicalCeiling: Object.freeze({
        capabilities: Object.freeze([...satellite.value.satellite.capabilities.effective]),
        telemetryScopes: Object.freeze([...satellite.value.satellite.telemetryScopes]),
      }),
      deviceTransport: Object.freeze({
        principal,
        headers: deviceHeaders,
        ...(clientCert ? { clientCert } : {}),
      }),
      presentation: Object.freeze({
        device: Object.freeze({
          id: connection.deviceId,
          label: satellite.value.satellite.endpointDisplayName,
        }),
        ...(connection.placeId ? {
          place: Object.freeze({
            id: connection.placeId,
            label: satellite.value.satellite.staticLocationLabel ?? connection.placeId,
          }),
        } : {}),
      }),
      audioOutputBinding: Object.freeze({
        companionId,
        principalId: principal.id,
        satelliteId: satellite.value.satellite.satelliteId,
        endpointId: satellite.value.satellite.endpointId,
        claimType: satellite.value.satellite.claimType,
        sessionId: satellite.value.satellite.sessionId,
      }),
      ...(clientCert ? { clientCert } : {}),
    });
  }

  private attachSocket(
    socket: WebSocket,
    authority: UpgradeAuthority,
    initialAttachment: Awaited<ReturnType<GatewayHubDeviceIngressService['admit']>>['attachment'],
  ): void {
    this.activeSockets.add(socket);
    let closed = false;
    let configured = false;
    let audioSocket: CompanionUiAudioSocketSession | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let unsubscribeAudioOutput: (() => void) | null = null;
    let eventDelivery = Promise.resolve();
    let audioOutputDelivery = Promise.resolve();
    let pendingAudioOutputFrames = 0;
    const seenRequestIds = new Set<string>();
    const audioCapable = Boolean(
      this.config.audioIngress
      && this.config.screenAudioTranscript
      && this.config.cancelAudioInteraction
      && authority.physicalCeiling.capabilities.includes('audio_input')
      && authority.physicalCeiling.capabilities.includes('speech_to_text'),
    );
    const advertisedCapabilities = audioCapable
      ? authority.physicalCeiling.capabilities
      : authority.physicalCeiling.capabilities.filter(
        capability => capability !== 'audio_input' && capability !== 'speech_to_text',
      );
    const audioOutputCapable = Boolean(
      this.config.audioOutputRelay
      && authority.physicalCeiling.capabilities.includes('audio_output'),
    );
    const effectiveAdvertisedCapabilities = audioOutputCapable
      ? advertisedCapabilities
      : advertisedCapabilities.filter(capability => capability !== 'audio_output');
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearInterval(watch);
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      unsubscribeAudioOutput?.();
      unsubscribeAudioOutput = null;
      audioSocket?.close(reason);
      audioSocket = null;
      this.activeSockets.delete(socket);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    };
    const sessionAuthority = new CompanionUiSessionAuthority(
      authority.assertion, initialAttachment,
      async assertion => (await this.config.hubDeviceIngress!.admit({
        assertion,
        connection: authority.connection,
        human: authority.sessionToken
          ? { kind: 'fleet_browser_session', sessionToken: authority.sessionToken }
          : { kind: 'guest' },
      })).attachment,
      () => closed,
    );
    const refreshAuthority = () => sessionAuthority.refresh();
    const reserveRequestId = (requestId: string): void => {
      if (seenRequestIds.has(requestId)
        || seenRequestIds.size >= RUNTIME_LIMITS.maxRequestIdsPerSocket) {
        throw new Error('duplicate or exhausted request identifier');
      }
      seenRequestIds.add(requestId);
    };
    const dispatchAction = async (body: Uint8Array, signal?: AbortSignal): Promise<unknown> => {
      await refreshAuthority();
      const common: Omit<CompanionUiActionBrokerInput, 'sessionToken'> = {
        rawBody: body,
        companionId: authority.companionId,
        attachment: sessionAuthority.attachment,
        physicalCeiling: authority.physicalCeiling,
        deviceTransport: authority.deviceTransport as CompanionUiActionBrokerInput['deviceTransport'],
        ...(signal ? { signal } : {}),
      };
      const result = authority.sessionToken
        ? await this.config.actionBroker!.execute({ ...common, sessionToken: authority.sessionToken })
        : await this.config.guestActionBroker?.execute(common);
      if (!authority.sessionToken && !this.config.guestActionBroker) {
        throw new Error('guest actions disabled');
      }
      return result;
    };
    if (this.config.audioIngress
      && this.config.screenAudioTranscript
      && this.config.cancelAudioInteraction) {
      audioSocket = new CompanionUiAudioSocketSession({
        enabled: audioCapable,
        companionId: authority.companionId,
        ingress: this.config.audioIngress,
        maxPendingFrames: this.maxPendingAudioFrames,
        send: value => sendJson(socket, value),
        refreshAuthority,
        attachment: () => sessionAuthority.attachment,
        reserveRequestId,
        dispatchAction,
        screenTranscript: this.config.screenAudioTranscript,
        cancelInteraction: this.config.cancelAudioInteraction,
        terminateSocket: reason => close(CLOSE.denied, reason),
      });
    }
    const watch = setInterval(() => {
      void refreshAuthority().catch(() => close(CLOSE.authorityChanged, 'authority changed'));
    }, this.authorityPollMs);
    watch.unref();
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!configured || !audioSocket) {
          close(CLOSE.denied, 'audio stream not ready');
          return;
        }
        try {
          audioSocket.handleBinary(rawDataBytes(raw));
        } catch {
          close(CLOSE.denied, 'invalid audio frame');
        }
        return;
      }
      const body = rawDataBytes(raw);
      void (async () => {
        if (!configured) {
          parseCompanionUiSessionConfigureFrame(body);
          configured = true;
          const eventCapabilities = authority.sessionToken
            && authority.physicalCeiling.telemetryScopes.includes('approvals')
            ? [COMPANION_APPROVALS_V2_CAPABILITY] as const
            : [];
          if (authority.sessionToken) {
            unsubscribeEvents = this.config.eventRelay.subscribe({
              companionId: authority.companionId,
              allowedKinds: companionEventKindsForScopes(
                authority.physicalCeiling.telemetryScopes,
              ),
              onEvent: (envelope) => {
                eventDelivery = eventDelivery.then(async () => {
                  await refreshAuthority();
                  if (!closed) {
                    sendJson(
                      socket,
                      projectCompanionEventFrame(envelope, eventCapabilities),
                    );
                  }
                }).catch(() => {
                  close(CLOSE.authorityChanged, 'authority changed');
                });
              },
            });
          }
          if (audioOutputCapable) {
            unsubscribeAudioOutput = this.config.audioOutputRelay!.subscribe({
              binding: authority.audioOutputBinding,
              onFrame: (frame) => {
                if (closed) return;
                if (pendingAudioOutputFrames >= this.maxPendingAudioFrames) {
                  close(CLOSE.denied, 'audio output backpressure exceeded');
                  return;
                }
                pendingAudioOutputFrames += 1;
                audioOutputDelivery = audioOutputDelivery.then(async () => {
                  await refreshAuthority();
                  if (!closed) {
                    sendJson(socket, {
                      schemaVersion: 1,
                      type: 'event',
                      event: frame,
                    });
                  }
                }).catch(() => {
                  close(CLOSE.authorityChanged, 'authority changed');
                }).finally(() => {
                  pendingAudioOutputFrames -= 1;
                });
              },
            });
          }
          sendJson(socket, {
            schemaVersion: 1,
            type: 'session.ready',
            device: authority.presentation.device,
            ...(authority.presentation.place ? { place: authority.presentation.place } : {}),
            capabilities: effectiveAdvertisedCapabilities,
            telemetryScopes: authority.physicalCeiling.telemetryScopes,
            eventCapabilities,
          });
          return;
        }
        const renewal = parseCompanionUiSessionRenewal(body);
        if (renewal) {
          reserveRequestId(renewal.requestId);
          await sessionAuthority.renew(renewal.assertion);
          sendJson(socket, {
            schemaVersion: 1, type: 'hub.session.renewed', requestId: renewal.requestId,
          });
          return;
        }
        if (audioSocket && await audioSocket.tryHandleControl(body)) return;
        const frame = parseCompanionUiActionFrame(body);
        reserveRequestId(frame.requestId);
        const result = await dispatchAction(body);
        sendJson(socket, {
          schemaVersion: 1,
          type: 'result',
          requestId: frame.requestId,
          ok: true,
          result,
        });
      })().catch(() => {
        sendJson(socket, {
          schemaVersion: 1,
          type: 'result',
          requestId: '',
          ok: false,
          error: { code: 'denied' },
        });
        close(CLOSE.denied, 'action denied');
      });
    });
    socket.once('close', () => close(CLOSE.authorityChanged, 'closed'));
    socket.once('error', () => close(CLOSE.authorityChanged, 'error'));
    log.info('Companion UI socket admitted', {
      companionId: authority.companionId,
      deviceId: authority.connection.deviceId,
    });
  }

  /**
   * Key-path session. No Hub attachment to refresh, no assertion to renew:
   * the bearer was verified on the upgrade and the socket lives until it
   * closes or the adapter stops. Every relay event kind the operator ceiling
   * grants is delivered, and frames dispatch through the operator broker.
   */
  private attachOperatorSocket(socket: WebSocket, authority: OperatorUpgradeAuthority): void {
    this.activeSockets.add(socket);
    let closed = false;
    let configured = false;
    let audioSocket: CompanionUiAudioSocketSession | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let eventDelivery = Promise.resolve();
    const seenRequestIds = new Set<string>();
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      audioSocket?.close(reason);
      audioSocket = null;
      this.activeSockets.delete(socket);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    };
    const reserveRequestId = (requestId: string): void => {
      if (seenRequestIds.has(requestId)
        || seenRequestIds.size >= RUNTIME_LIMITS.maxRequestIdsPerSocket) {
        throw new Error('duplicate or exhausted request identifier');
      }
      seenRequestIds.add(requestId);
    };
    const dispatchAction = async (body: Uint8Array, signal?: AbortSignal): Promise<unknown> => {
      if (closed || this.stopped) throw new Error('operator session closed');
      return await this.config.operatorActionBroker!.execute({
        rawBody: body,
        companionId: authority.companionId,
        principal: authority.principal,
        physicalCeiling: authority.physicalCeiling,
        ...(signal ? { signal } : {}),
      });
    };
    const audioCapable = authority.physicalCeiling.capabilities.includes('speech_to_text');
    if (audioCapable) {
      audioSocket = new CompanionUiAudioSocketSession({
        enabled: true,
        companionId: authority.companionId,
        ingress: this.config.audioIngress!,
        maxPendingFrames: this.maxPendingAudioFrames,
        send: value => sendJson(socket, value),
        refreshAuthority: async () => {
          if (closed || this.stopped) throw new Error('operator session closed');
        },
        attachment: () => undefined,
        reserveRequestId,
        dispatchAction,
        screenTranscript: this.config.screenAudioTranscript!,
        cancelInteraction: this.config.cancelAudioInteraction!,
        terminateSocket: reason => close(CLOSE.denied, reason),
      });
    }
    const eventCapabilities = [COMPANION_APPROVALS_V2_CAPABILITY] as const;
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!configured || !audioSocket) {
          close(CLOSE.denied, 'audio stream not ready');
          return;
        }
        try {
          audioSocket.handleBinary(rawDataBytes(raw));
        } catch {
          close(CLOSE.denied, 'invalid audio frame');
        }
        return;
      }
      const body = rawDataBytes(raw);
      void (async () => {
        if (!configured) {
          parseCompanionUiSessionConfigureFrame(body);
          configured = true;
          unsubscribeEvents = this.config.eventRelay.subscribe({
            companionId: authority.companionId,
            allowedKinds: companionEventKindsForScopes(authority.physicalCeiling.telemetryScopes),
            onEvent: (envelope) => {
              eventDelivery = eventDelivery.then(() => {
                if (!closed) sendJson(socket, projectCompanionEventFrame(envelope, eventCapabilities));
              }).catch(() => {
                close(CLOSE.denied, 'event projection failed');
              });
            },
          });
          sendJson(socket, {
            schemaVersion: 1,
            type: 'session.ready',
            device: OPERATOR_KEY_DEVICE,
            capabilities: authority.physicalCeiling.capabilities,
            telemetryScopes: authority.physicalCeiling.telemetryScopes,
            eventCapabilities,
          });
          return;
        }
        if (parseCompanionUiSessionRenewal(body)) throw new Error('operator key sessions do not renew');
        if (audioSocket && await audioSocket.tryHandleControl(body)) return;
        const frame = parseCompanionUiActionFrame(body);
        reserveRequestId(frame.requestId);
        const result = await dispatchAction(body);
        sendJson(socket, {
          schemaVersion: 1,
          type: 'result',
          requestId: frame.requestId,
          ok: true,
          result,
        });
      })().catch(() => {
        sendJson(socket, {
          schemaVersion: 1,
          type: 'result',
          requestId: '',
          ok: false,
          error: { code: 'denied' },
        });
        close(CLOSE.denied, 'action denied');
      });
    });
    socket.once('close', () => close(CLOSE.authorityChanged, 'closed'));
    socket.once('error', () => close(CLOSE.authorityChanged, 'error'));
    log.info('Companion UI operator key socket admitted', {
      companionId: authority.companionId,
      principalId: authority.principal.id,
    });
  }
}
