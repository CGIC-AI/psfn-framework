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
import type { GatewayCompanionUiActionBroker } from '../../boundary/gateway/companion-ui-action-broker.js';
import { parseCompanionUiActionFrame } from '../../boundary/fleet-auth/companion-ui-action.js';
import {
  getBearerToken,
  isExpectedApiToken,
  principalFromSatelliteApiKeyToken,
} from '../backplane/http/auth.js';
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

const log = createComponentLogger('CompanionUiWebSocket');
const PATH_PATTERN = /^\/companion-ui\/companions\/([0-9a-f-]+)\/ws$/u;
const CLOSE = Object.freeze({ denied: 4403, authorityChanged: 4401, shutdown: 1012 });
const RUNTIME_LIMITS = Object.freeze({
  maxPayloadBytes: 1_048_576,
  maxRequestIdsPerSocket: 4_096,
  authorityPollMs: 5_000,
});
const FORBIDDEN_BROWSER_AUTHORITY_HEADERS = new Set([
  'x-author-id', 'x-author-name', 'x-canonical-contact-id', 'x-channel-id', 'x-channel-type',
  'x-companion-id', 'x-device-id', 'x-place-id', 'x-psfn-action', 'x-psfn-author',
  'x-psfn-author-id', 'x-psfn-author-name', 'x-psfn-capability', 'x-psfn-channel-id',
  'x-psfn-companion-id', 'x-psfn-request-capability', 'x-psfn-resource',
  ...REQUEST_CAPABILITY_ASSERTION_HEADERS,
]);

export interface CompanionUiWebSocketConfig {
  readonly canonicalOrigin: string;
  readonly satelliteApiKeys: readonly string[];
  readonly satelliteRegistry: SatelliteRegistryConfig;
  readonly trustedProxyClientCertToken?: string;
  readonly hubDeviceIngress: GatewayHubDeviceIngressService;
  readonly actionBroker: GatewayCompanionUiActionBroker;
  readonly guestMode?: 'disabled' | 'explicit';
  readonly guestActionBroker?: Readonly<{
    execute(input: Omit<Parameters<GatewayCompanionUiActionBroker['execute']>[0], 'sessionToken'>): Promise<unknown>;
  }>;
  readonly authorityPollMs?: number;
  readonly createWebSocketServer?: () => WebSocketServer;
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

export class CompanionUiWebSocketAdapter {
  private readonly expectedOrigin: string;
  private readonly expectedHost: string;
  private readonly authorityPollMs: number;
  private readonly webSocketServer: WebSocketServer;
  private readonly activeSockets = new Set<WebSocket>();
  private stopped = false;

  constructor(private readonly config: CompanionUiWebSocketConfig) {
    const origin = new URL(config.canonicalOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== config.canonicalOrigin) {
      throw new Error('Companion UI canonical origin must be an exact HTTPS origin');
    }
    if (config.satelliteApiKeys.length === 0 || !config.satelliteRegistry.enabled) {
      throw new Error('Companion UI requires authenticated Satellite Hub registry authority');
    }
    this.expectedOrigin = origin.origin;
    this.expectedHost = origin.host;
    this.authorityPollMs = config.authorityPollMs ?? RUNTIME_LIMITS.authorityPollMs;
    if (!Number.isSafeInteger(this.authorityPollMs) || this.authorityPollMs < 250) {
      throw new Error('Companion UI authority poll interval is invalid');
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
    void this.admitUpgrade(request, socket, head, match[1] as CompanionId);
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
      authority = this.resolveUpgradeAuthority(request, companionId);
      const admission = await this.config.hubDeviceIngress.admit({
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

  private resolveUpgradeAuthority(request: IncomingMessage, companionId: CompanionId): UpgradeAuthority {
    if (this.stopped
      || rawHeaderCount(request, 'host') !== 1
      || rawHeaderCount(request, 'origin') !== 1
      || rawHeaderCount(request, 'authorization') !== 1
      || rawHeaderCount(request, 'sec-websocket-protocol') !== 0
      || request.headers.host !== this.expectedHost
      || request.headers.origin !== this.expectedOrigin
      || hasForbiddenAuthorityHeader(request)) throw new Error('invalid upgrade metadata');
    const sessionToken = readExclusiveFleetSessionCookie(request);
    const cookieCount = rawHeaderCount(request, 'cookie');
    if (sessionToken ? cookieCount !== 1 : cookieCount !== 0) throw new Error('invalid fleet session cookie');
    if (!sessionToken && this.config.guestMode !== 'explicit') throw new Error('fleet session required');
    const bearer = getBearerToken(request);
    const satelliteKey = this.config.satelliteApiKeys.find(key => isExpectedApiToken(bearer, key));
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
      registry: this.config.satelliteRegistry,
      ...(clientCert ? { clientCert } : {}),
    });
    if (!satellite.ok) throw new Error('Hub claim denied');
    const assertion = extractCanonicalHubDeviceAssertion(request);
    const connection = resolveAuthenticatedHubDeviceConnection({
      req: request,
      principal,
      registry: this.config.satelliteRegistry,
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
      ...(clientCert ? { clientCert } : {}),
    });
  }

  private attachSocket(
    socket: WebSocket,
    authority: UpgradeAuthority,
    initialAttachment: Awaited<ReturnType<GatewayHubDeviceIngressService['admit']>>['attachment'],
  ): void {
    this.activeSockets.add(socket);
    let attachment = initialAttachment;
    let closed = false;
    const seenRequestIds = new Set<string>();
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearInterval(watch);
      this.activeSockets.delete(socket);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    };
    const refreshAuthority = async (): Promise<void> => {
      const refreshed = await this.config.hubDeviceIngress.admit({
        assertion: authority.assertion,
        connection: authority.connection,
        human: authority.sessionToken
          ? { kind: 'fleet_browser_session', sessionToken: authority.sessionToken }
          : { kind: 'guest' },
      });
      if ((authority.sessionToken && refreshed.attachment.actor.kind !== 'human')
        || (!authority.sessionToken && refreshed.attachment.actor.kind !== 'guest')
        || refreshed.attachment.attachmentId !== initialAttachment.attachmentId) {
        throw new Error('socket authority changed');
      }
      attachment = refreshed.attachment;
    };
    const watch = setInterval(() => {
      void refreshAuthority().catch(() => close(CLOSE.authorityChanged, 'authority changed'));
    }, this.authorityPollMs);
    watch.unref();
    sendJson(socket, {
      schemaVersion: 1,
      type: 'session.ready',
      device: authority.presentation.device,
      ...(authority.presentation.place ? { place: authority.presentation.place } : {}),
      capabilities: authority.physicalCeiling.capabilities,
      telemetryScopes: authority.physicalCeiling.telemetryScopes,
    });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        close(CLOSE.denied, 'binary frames denied');
        return;
      }
      const body = rawDataBytes(raw);
      void (async () => {
        const frame = parseCompanionUiActionFrame(body);
        if (seenRequestIds.has(frame.requestId)
          || seenRequestIds.size >= RUNTIME_LIMITS.maxRequestIdsPerSocket) {
          throw new Error('duplicate or exhausted request identifier');
        }
        seenRequestIds.add(frame.requestId);
        await refreshAuthority();
        const common = {
          rawBody: body,
          companionId: authority.companionId,
          attachment,
          physicalCeiling: authority.physicalCeiling,
          deviceTransport: authority.deviceTransport,
        };
        const result = authority.sessionToken
          ? await this.config.actionBroker.execute({ ...common, sessionToken: authority.sessionToken })
          : await this.config.guestActionBroker?.execute(common);
        if (!authority.sessionToken && !this.config.guestActionBroker) throw new Error('guest actions disabled');
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
}
