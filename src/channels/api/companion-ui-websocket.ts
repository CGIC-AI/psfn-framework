import { randomUUID } from 'node:crypto';
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
import { isObjectRecord as isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { GatewayHubDeviceIngressService } from '../../boundary/fleet-auth/hub-device-ingress.js';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import type {
  CompanionUiActionBrokerInput,
  GatewayCompanionUiActionBroker,
} from '../../boundary/gateway/companion-ui-action-broker.js';
import type {
  CompanionUiAudioIngressPort,
  CompanionUiAudioIngressSession,
} from '../../boundary/gateway/companion-ui-audio-ingress.js';
import {
  parseCompanionUiActionFrame,
  parseCompanionUiSessionConfigureFrame,
} from '../../boundary/fleet-auth/companion-ui-action.js';
import {
  parseCompanionUiAudioChunk,
  parseCompanionUiAudioControlFrame,
  type CompanionUiAudioControlFrame,
} from '../../shared/contracts/companion-ui-audio.js';
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
  maxPendingAudioFrames: 32,
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
  readonly audioIngress?: CompanionUiAudioIngressPort;
  readonly screenAudioTranscript?: (
    input: Readonly<{
      companionId: CompanionId;
      attachment: HubDeviceAttachmentSnapshot;
      requestId: string;
      transcript: string;
    }>,
  ) => Promise<string>;
  readonly eventRelay: CompanionEventRelay;
  readonly guestMode?: 'disabled' | 'explicit';
  readonly guestActionBroker?: Readonly<{
    execute(input: Omit<Parameters<GatewayCompanionUiActionBroker['execute']>[0], 'sessionToken'>): Promise<unknown>;
  }>;
  readonly authorityPollMs?: number;
  readonly maxPendingAudioFrames?: number;
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

interface ActiveAudioStream {
  readonly requestId: string;
  readonly session: CompanionUiAudioIngressSession;
  nextSequence: number;
  pendingWrites: number;
  writeChain: Promise<void>;
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

function tryParseAudioControl(body: Uint8Array): CompanionUiAudioControlFrame | undefined {
  try {
    return parseCompanionUiAudioControlFrame(body);
  } catch {
    return undefined;
  }
}

function sendConversationMessage(
  socket: WebSocket,
  role: 'user' | 'assistant',
  content: string,
  state: Readonly<{ live: true } | { final: true }>,
): void {
  sendJson(socket, {
    schemaVersion: 1,
    type: 'event',
    event: {
      type: 'message',
      data: { role, content, ...state },
    },
  });
}

function companionResponseContent(result: unknown): string {
  if (!isRecord(result) || typeof result.content !== 'string') {
    throw new Error('Companion audio response was malformed');
  }
  return result.content;
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

function attachmentAuthorityKey(attachment: HubDeviceAttachmentSnapshot): string {
  const actor = attachment.actor.kind === 'human'
    ? {
        kind: attachment.actor.kind,
        principalId: attachment.actor.principalId,
        companionId: attachment.actor.companionId,
        providerSubject: attachment.actor.providerSubject,
        contact: attachment.actor.contact,
        operator: attachment.actor.operator,
        session: attachment.actor.session,
      }
    : {
        kind: attachment.actor.kind,
        companionId: attachment.actor.companionId,
      };
  return JSON.stringify({
    attachmentId: attachment.attachmentId,
    deviceActor: attachment.deviceActor,
    actor,
    channel: attachment.channel,
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

  constructor(private readonly config: CompanionUiWebSocketConfig) {
    const origin = new URL(config.canonicalOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== config.canonicalOrigin) {
      throw new Error('Companion UI canonical origin must be an exact HTTPS origin');
    }
    if (config.satelliteApiKeys.length === 0 || !config.satelliteRegistry.enabled) {
      throw new Error('Companion UI requires authenticated Satellite Hub registry authority');
    }
    if (Boolean(config.audioIngress) !== Boolean(config.screenAudioTranscript)) {
      throw new Error('Companion UI audio ingress requires transcript screening');
    }
    this.expectedOrigin = origin.origin;
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
    let configured = false;
    let activeAudio: ActiveAudioStream | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let eventDelivery = Promise.resolve();
    const seenRequestIds = new Set<string>();
    const initialAuthorityKey = attachmentAuthorityKey(initialAttachment);
    const audioCapable = Boolean(
      this.config.audioIngress
      && this.config.screenAudioTranscript
      && authority.physicalCeiling.capabilities.includes('audio_input')
      && authority.physicalCeiling.capabilities.includes('speech_to_text'),
    );
    const advertisedCapabilities = audioCapable
      ? authority.physicalCeiling.capabilities
      : authority.physicalCeiling.capabilities.filter(
        capability => capability !== 'audio_input' && capability !== 'speech_to_text',
      );
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearInterval(watch);
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      const audio = activeAudio;
      activeAudio = null;
      if (audio) void audio.session.cancel(reason).catch(() => undefined);
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
        || attachmentAuthorityKey(refreshed.attachment) !== initialAuthorityKey) {
        throw new Error('socket authority changed');
      }
      attachment = refreshed.attachment;
    };
    const reserveRequestId = (requestId: string): void => {
      if (seenRequestIds.has(requestId)
        || seenRequestIds.size >= RUNTIME_LIMITS.maxRequestIdsPerSocket) {
        throw new Error('duplicate or exhausted request identifier');
      }
      seenRequestIds.add(requestId);
    };
    const dispatchAction = async (body: Uint8Array): Promise<unknown> => {
      await refreshAuthority();
      const common: Omit<CompanionUiActionBrokerInput, 'sessionToken'> = {
        rawBody: body,
        companionId: authority.companionId,
        attachment,
        physicalCeiling: authority.physicalCeiling,
        deviceTransport: authority.deviceTransport as CompanionUiActionBrokerInput['deviceTransport'],
      };
      const result = authority.sessionToken
        ? await this.config.actionBroker.execute({ ...common, sessionToken: authority.sessionToken })
        : await this.config.guestActionBroker?.execute(common);
      if (!authority.sessionToken && !this.config.guestActionBroker) {
        throw new Error('guest actions disabled');
      }
      return result;
    };
    const failAudio = (requestId: string, reason: string): void => {
      const audio = activeAudio;
      if (!audio || audio.requestId !== requestId) return;
      activeAudio = null;
      sendJson(socket, {
        schemaVersion: 1,
        type: 'event',
        event: {
          type: 'error-event',
          data: { message: 'Companion audio relay failed' },
        },
      });
      void audio.session.cancel(reason).catch(() => undefined);
    };
    const deliverAudioUtterance = async (requestId: string, transcript: string): Promise<void> => {
      const screenAudioTranscript = this.config.screenAudioTranscript;
      const streamIsActive = () => !closed && activeAudio?.requestId === requestId;
      if (!streamIsActive() || !screenAudioTranscript) return;
      const actionRequestId = randomUUID();
      await refreshAuthority();
      const effectiveTranscript = await screenAudioTranscript({
        companionId: authority.companionId,
        attachment,
        requestId: actionRequestId,
        transcript,
      });
      if (!streamIsActive()) return;
      reserveRequestId(actionRequestId);
      const body = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        requestId: actionRequestId,
        action: 'companion.interact',
        resource: 'conversation.audio',
        body: { transcript: effectiveTranscript },
      }));
      sendConversationMessage(socket, 'user', effectiveTranscript, { final: true });
      const result = await dispatchAction(body);
      const content = companionResponseContent(result);
      if (streamIsActive() && content) {
        sendConversationMessage(socket, 'assistant', content, { final: true });
      }
    };
    const watch = setInterval(() => {
      void refreshAuthority().catch(() => close(CLOSE.authorityChanged, 'authority changed'));
    }, this.authorityPollMs);
    watch.unref();
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!configured || !activeAudio) {
          close(CLOSE.denied, 'audio stream not ready');
          return;
        }
        const audio = activeAudio;
        try {
          const chunk = parseCompanionUiAudioChunk(rawDataBytes(raw));
          if (chunk.sequence !== audio.nextSequence
            || audio.pendingWrites >= this.maxPendingAudioFrames) {
            throw new Error('audio sequence or backpressure violation');
          }
          audio.nextSequence = (audio.nextSequence + 1) >>> 0;
          audio.pendingWrites += 1;
          audio.writeChain = audio.writeChain
            .then(async () => {
              await audio.session.writePcm(chunk.pcm);
              if (!closed && activeAudio === audio) {
                sendJson(socket, {
                  schemaVersion: 1,
                  type: 'audio.ack',
                  requestId: audio.requestId,
                  sequence: chunk.sequence,
                });
              }
            })
            .catch(() => { failAudio(audio.requestId, 'audio write failed'); })
            .finally(() => { audio.pendingWrites -= 1; });
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
          sendJson(socket, {
            schemaVersion: 1,
            type: 'session.ready',
            device: authority.presentation.device,
            ...(authority.presentation.place ? { place: authority.presentation.place } : {}),
            capabilities: advertisedCapabilities,
            telemetryScopes: authority.physicalCeiling.telemetryScopes,
            eventCapabilities,
          });
          return;
        }
        const audioControl = tryParseAudioControl(body);
        if (audioControl?.type === 'audio.start') {
          if (!audioCapable || !this.config.audioIngress || activeAudio) {
            throw new Error('audio stream denied');
          }
          reserveRequestId(audioControl.requestId);
          await refreshAuthority();
          const requestId = audioControl.requestId;
          const session = await this.config.audioIngress.start({
            companionId: authority.companionId,
            onPartial: (text) => {
              if (!closed && activeAudio?.requestId === requestId) {
                sendConversationMessage(socket, 'user', text, { live: true });
              }
            },
            onUtterance: async (text) => deliverAudioUtterance(requestId, text),
            onError: () => { failAudio(requestId, 'STT stream failed'); },
          });
          activeAudio = {
            requestId,
            session,
            nextSequence: 0,
            pendingWrites: 0,
            writeChain: Promise.resolve(),
          };
          sendJson(socket, {
            schemaVersion: 1,
            type: 'audio.ready',
            requestId,
          });
          return;
        }
        if (audioControl?.type === 'audio.stop') {
          const audio = activeAudio;
          if (!audio || audio.requestId !== audioControl.requestId) {
            throw new Error('audio stream mismatch');
          }
          await audio.writeChain;
          await audio.session.stop('client stop');
          if (activeAudio === audio) activeAudio = null;
          sendJson(socket, {
            schemaVersion: 1,
            type: 'audio.stopped',
            requestId: audio.requestId,
          });
          return;
        }
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
}
