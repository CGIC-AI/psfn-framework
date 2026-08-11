import { isObjectRecord as isRecord } from '../../../../src/shared/utils/types.js';
import type {
  ClientToHubMessage,
  HelloAckMessage,
  HelloMessage,
  HubToClientMessage,
  MessageEvent as HubMessageEvent,
  PongMessage,
  RuntimeIdentity,
  RuntimePlaceIdentity,
  SatelliteCapabilities,
  SessionReadyMessage,
  TouchInteractionMessage,
} from '../protocol/events.js';
import {
  HubFramingError,
  parseHubToClientMessage,
  serializeClientToHubMessage,
} from '../protocol/framing.js';
import { buildSatelliteHello, type SatelliteHelloOptions } from './auth.js';
import type { ShardDirectoryEntry } from '../../../../src/shared/contracts/shard-directory.js';
import type { DeviceLocationSample } from '../geolocation.js';

export type SatelliteHubConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'error';

export interface SatelliteHubSession {
  sessionId?: string;
  channelId?: string;
  deviceId?: string;
  deviceName?: string;
  satelliteId?: string;
  satelliteName?: string;
  place?: RuntimePlaceIdentity;
  audioFormat?: string;
  capabilities?: SatelliteCapabilities;
  eventCapabilities?: readonly string[];
  shards?: readonly ShardDirectoryEntry[];
  activeShardId?: string;
  canListShards?: boolean;
  identity?: RuntimeIdentity;
  lastPingSentAt?: number;
  lastPongAt?: string;
  lastPingRttMs?: number;
}

export interface SatelliteHubSnapshot {
  state: SatelliteHubConnectionState;
  ready: boolean;
  url: string;
  hello: HelloMessage;
  session: SatelliteHubSession;
}

export interface SatelliteHubStateEvent {
  previous: SatelliteHubConnectionState;
  current: SatelliteHubConnectionState;
}

export interface SatelliteHubInboundEvent {
  message: HubToClientMessage;
}

export interface SatelliteHubOutboundEvent {
  message: ClientToHubMessage;
}

export interface SatelliteHubConversationEvent {
  role: HubMessageEvent['data']['role'];
  content: string;
  live: boolean;
  final: boolean;
  message: HubMessageEvent;
}

export interface SatelliteHubPongEvent {
  sentAt: number;
  receivedAt: string;
  rttMs?: number;
  message: PongMessage;
}

export interface SatelliteHubErrorEvent {
  message: string;
  recoverable: boolean;
  cause?: unknown;
}

export interface SatelliteHubClientEventMap {
  state: SatelliteHubStateEvent;
  inbound: SatelliteHubInboundEvent;
  outbound: SatelliteHubOutboundEvent;
  conversation: SatelliteHubConversationEvent;
  session: SatelliteHubSession;
  status: string;
  pong: SatelliteHubPongEvent;
  error: SatelliteHubErrorEvent;
}

export type SatelliteHubUnsubscribe = () => void;

export interface SatelliteHubWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  on?: (type: string, listener: (...args: unknown[]) => void) => void;
  off?: (type: string, listener: (...args: unknown[]) => void) => void;
}

export type SatelliteHubWebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => SatelliteHubWebSocketLike;

export interface SatelliteHubClientOptions extends SatelliteHelloOptions {
  url: string;
  webSocketFactory?: SatelliteHubWebSocketFactory;
  clock?: () => Date;
  nowMs?: () => number;
  autoHello?: boolean;
}

type Listener = (event: SatelliteHubClientEventMap[keyof SatelliteHubClientEventMap]) => void;

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

export class SatelliteHubClient {
  private readonly listeners = new Map<keyof SatelliteHubClientEventMap, Set<Listener>>();
  private readonly hello: HelloMessage;
  private readonly clock: () => Date;
  private readonly nowMs: () => number;
  private readonly autoHello: boolean;
  private socket: SatelliteHubWebSocketLike | null = null;
  private state: SatelliteHubConnectionState = 'idle';
  private ready = false;
  private closingRequested = false;
  private readonly session: SatelliteHubSession;

  constructor(private readonly options: SatelliteHubClientOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.autoHello = options.autoHello ?? true;
    this.hello = buildSatelliteHello(options);
    this.session = { capabilities: cloneCapabilities(this.hello.capabilities) };
  }

  on<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    listener: (event: SatelliteHubClientEventMap[K]) => void,
  ): SatelliteHubUnsubscribe {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set<Listener>();
      this.listeners.set(type, listeners);
    }
    const wrapped = listener as Listener;
    listeners.add(wrapped);
    return () => {
      listeners?.delete(wrapped);
    };
  }

  snapshot(): SatelliteHubSnapshot {
    return {
      state: this.state,
      ready: this.ready,
      url: this.options.url,
      hello: cloneHello(this.hello),
      session: {
        ...this.session,
        capabilities: cloneCapabilities(this.session.capabilities),
        identity: cloneIdentity(this.session.identity),
        place: this.session.place ? { ...this.session.place } : undefined,
      },
    };
  }

  connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected' || this.state === 'ready') {
      return Promise.resolve();
    }
    const url = resolveHubWebSocketUrl(this.options.url);
    this.closingRequested = false;
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleReject = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const socket = this.createSocket(url);
      this.socket = socket;
      this.attachSocketListener(socket, 'open', () => {
        this.setState('connected');
        if (this.autoHello) {
          this.send(this.hello);
        }
        settleResolve();
      });
      this.attachSocketListener(socket, 'message', (raw) => {
        void this.handleRawSocketMessage(raw);
      });
      this.attachSocketListener(socket, 'error', (error) => {
        const emitted = this.emitLocalError('Satellite Hub websocket error', true, error);
        if (this.state === 'connecting') {
          settleReject(emitted);
        }
      });
      this.attachSocketListener(socket, 'close', () => {
        this.socket = null;
        this.ready = false;
        if (this.state === 'error') {
          settleResolve();
          return;
        }
        this.setState(this.closingRequested ? 'closed' : 'closed');
        settleResolve();
      });
    });
  }

  disconnect(): void {
    this.closingRequested = true;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket && socket.readyState !== SOCKET_CLOSED && socket.readyState !== SOCKET_CLOSING) {
      this.setState('closing');
      socket.close(1000, 'Satellite mobile chat app disconnect');
      return;
    }
    this.setState('closed');
  }

  sendUserText(text: string, options: { interrupt?: boolean } = {}): void {
    const normalized = text.trim();
    if (!normalized) {
      throw this.emitLocalError('Typed message is empty', false);
    }
    this.send({
      type: 'user.text',
      text: normalized,
      interrupt: options.interrupt ?? true,
    });
  }

  startTurn(options: { interrupt?: boolean } = {}): void {
    this.send({ type: 'turn.start', interrupt: options.interrupt });
  }

  endTurn(reason = 'manual'): void {
    this.send({ type: 'turn.end', reason });
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
  }

  startPcmAudioStream(): Promise<void> {
    return Promise.reject(new Error('Microphone audio is unavailable on the Satellite Hub transport'));
  }

  sendPcmAudio(_pcm: Uint8Array): Promise<void> {
    return Promise.reject(new Error('Microphone audio is unavailable on the Satellite Hub transport'));
  }

  stopPcmAudioStream(): Promise<void> {
    return Promise.reject(new Error('Microphone audio is unavailable on the Satellite Hub transport'));
  }

  sendApprovalDecision(id: string, decision: 'approve' | 'deny'): void {
    this.send({ type: 'approval.decision', id, decision });
  }

  sendArtifactPreviewRequest(requestId: string, artifactId: string): void {
    this.send({ type: 'artifact.preview', requestId, artifactId });
  }

  sendTouchInteraction(interaction: Omit<TouchInteractionMessage, 'type'>): void {
    this.send({ type: 'touch.interaction', ...interaction });
  }

  /**
   * The direct-hub transport terminates raw coordinates at the hub (it
   * geofences them into a place label and never forwards lat/lon toward PSFN),
   * so `device.location` may be sent here.
   */
  supportsDeviceLocation(): boolean {
    return true;
  }

  sendDeviceLocation(sample: DeviceLocationSample): void {
    this.send({
      type: 'device.location',
      lat: sample.lat,
      lon: sample.lon,
      accuracyM: sample.accuracyM,
      timestamp: sample.timestamp,
    });
  }

  ping(sentAt = this.nowMs()): void {
    this.session.lastPingSentAt = sentAt;
    this.send({ type: 'ping', sentAt });
  }

  send(message: ClientToHubMessage): void {
    this.ensureSendable();
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw this.emitLocalError('Satellite Hub websocket is not connected', false);
    }
    const frame = serializeClientToHubMessage(message);
    socket.send(frame);
    this.emit('outbound', { message: redactClientMessage(message) });
  }

  private createSocket(url: string): SatelliteHubWebSocketLike {
    if (this.options.webSocketFactory) {
      return this.options.webSocketFactory(url);
    }
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw this.emitLocalError(
        'No global WebSocket implementation is available',
        false,
      );
    }
    return new WebSocketCtor(url) as SatelliteHubWebSocketLike;
  }

  private attachSocketListener(
    socket: SatelliteHubWebSocketLike,
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event?: unknown) => void,
  ): void {
    if (socket.addEventListener) {
      socket.addEventListener(type, listener);
      return;
    }
    if (socket.on) {
      socket.on(type, (...args) => listener(type === 'message' ? args[0] : args[0]));
      return;
    }
    throw this.emitLocalError('WebSocket implementation does not expose an event API', false);
  }

  private async handleRawSocketMessage(raw: unknown): Promise<void> {
    const text = await decodeRawSocketText(raw);
    if (text === null) {
      this.failProtocol('Unsupported websocket message payload', raw);
      return;
    }
    try {
      this.consumeHubMessage(parseHubToClientMessage(text));
    } catch (error) {
      this.failProtocol(
        error instanceof HubFramingError ? error.message : 'Invalid hub message',
        error,
      );
    }
  }

  private failProtocol(message: string, cause?: unknown): void {
    this.emitLocalError(message, false, cause);
    const socket = this.socket;
    if (socket && socket.readyState === SOCKET_OPEN) {
      socket.close(1002, 'Protocol error');
    }
  }

  private consumeHubMessage(message: HubToClientMessage): void {
    this.emit('inbound', { message });

    switch (message.type) {
      case 'session.ready':
        this.applySessionReady(message);
        this.markReady();
        return;
      case 'hello.ack':
        this.applyHelloAck(message);
        this.markReady();
        return;
      case 'status':
        if (message.data === 'call_initialized') {
          this.markReady();
        }
        this.emit('status', message.data);
        return;
      case 'message':
        this.emit('conversation', {
          role: message.data.role,
          content: message.data.content,
          live: message.data.live ?? false,
          final: message.data.final ?? false,
          message,
        });
        return;
      case 'pong':
        this.handlePong(message);
        return;
      case 'error-event':
        this.emit('error', {
          // Hub error text is untrusted diagnostic input and can accidentally
          // contain credentials. Keep the detailed frame in volatile protocol
          // state only; browser diagnostics receive a fixed summary.
          message: 'Satellite Hub reported an error',
          recoverable: true,
        });
        return;
      case 'text':
      case 'audio':
      case 'action':
      case 'relay.stt.result':
      case 'relay.tts.chunk':
      case 'relay.tts.done':
      case 'relay.error':
      case 'assistant.interrupted':
      // Approval/artifact/tool-activity families are consumed by the stream
      // store via the 'inbound' event above; the low-level client stays a
      // pure transport for them.
      case 'approval.requested':
      case 'approval.resolved':
      case 'artifact.created':
      case 'artifact.preview.result':
      case 'artifact.preview.error':
      case 'tool.activity':
        return;
    }
  }

  private markReady(): void {
    this.ready = true;
    this.setState('ready');
    this.emit('session', {
      ...this.session,
      capabilities: cloneCapabilities(this.session.capabilities),
      identity: cloneIdentity(this.session.identity),
      place: this.session.place ? { ...this.session.place } : undefined,
    });
  }

  private applySessionReady(message: SessionReadyMessage): void {
    this.session.sessionId = message.sessionId;
    this.session.channelId = message.channelId;
    this.session.deviceId = message.deviceId;
    this.session.deviceName = message.deviceName;
    this.session.satelliteId = message.satelliteId;
    this.session.audioFormat = message.audioFormat;
    this.session.place = message.place ? { ...message.place } : undefined;
    this.session.identity = cloneIdentity(message.identity);
  }

  private applyHelloAck(message: HelloAckMessage): void {
    this.session.sessionId = message.sessionId;
    this.session.channelId = message.channelId;
    this.session.deviceId = message.deviceId;
    this.session.deviceName = message.deviceName;
    this.session.satelliteId = message.satelliteId;
    this.session.satelliteName = message.satelliteName;
    this.session.capabilities = cloneCapabilities(message.capabilities);
    this.session.eventCapabilities = message.eventCapabilities
      ? [...message.eventCapabilities]
      : undefined;
    this.session.place = message.place ? { ...message.place } : undefined;
    this.session.identity = cloneIdentity(message.identity);
  }

  private handlePong(message: PongMessage): void {
    const receivedAt = this.clock().toISOString();
    const rttMs = this.session.lastPingSentAt === message.sentAt
      ? Math.max(0, this.nowMs() - message.sentAt)
      : undefined;
    this.session.lastPongAt = receivedAt;
    this.session.lastPingRttMs = rttMs;
    this.emit('pong', { sentAt: message.sentAt, receivedAt, rttMs, message });
  }

  private ensureSendable(): void {
    const socket = this.socket;
    if (socket && socket.readyState === SOCKET_OPEN) {
      return;
    }
    throw this.emitLocalError('Satellite Hub websocket is not connected', false);
  }

  private setState(next: SatelliteHubConnectionState): void {
    if (this.state === next) {
      return;
    }
    const previous = this.state;
    this.state = next;
    this.emit('state', { previous, current: next });
  }

  private emitLocalError(message: string, recoverable: boolean, cause?: unknown): Error {
    const error = cause instanceof Error ? cause : new Error(message);
    if (!recoverable) {
      this.ready = false;
      this.setState('error');
    }
    this.emit('error', { message, recoverable, cause });
    return error;
  }

  private emit<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    event: SatelliteHubClientEventMap[K],
  ): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(event);
    }
  }
}

export function resolveHubWebSocketUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Satellite Hub websocket URL is required');
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Satellite Hub websocket URL must use ws: or wss:');
  }
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments[0] === 'api' && pathSegments[1] === 'admin') {
    throw new Error('Satellite Hub websocket URL must not target admin APIs');
  }
  return parsed.toString();
}

function cloneCapabilities(capabilities: SatelliteCapabilities | undefined): SatelliteCapabilities | undefined {
  if (!capabilities) {
    return undefined;
  }
  return {
    input: capabilities.input ? [...capabilities.input] : undefined,
    output: capabilities.output ? [...capabilities.output] : undefined,
    control: capabilities.control ? [...capabilities.control] : undefined,
    safety: capabilities.safety ? [...capabilities.safety] : undefined,
  };
}

function cloneHello(message: HelloMessage): HelloMessage {
  return {
    type: 'hello',
    capabilities: cloneCapabilities(message.capabilities) ?? {},
    eventCapabilities: [...message.eventCapabilities],
  };
}

function redactClientMessage(message: ClientToHubMessage): ClientToHubMessage {
  if (message.type === 'hello') {
    return cloneHello(message);
  }
  if (message.type === 'device.location') {
    // Raw coordinates must never reach the 'outbound' telemetry event (which
    // may be logged). Emit the shape without lat/lon; keep coarse accuracy and
    // timestamp so diagnostics can confirm a fix was sent.
    return {
      type: 'device.location',
      lat: 0,
      lon: 0,
      accuracyM: message.accuracyM,
      timestamp: message.timestamp,
    };
  }
  return message;
}

function cloneIdentity(identity: RuntimeIdentity | undefined): RuntimeIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  return {
    source: identity.source,
    companion: identity.companion ? { ...identity.companion } : undefined,
    user: identity.user ? { ...identity.user } : undefined,
  };
}

async function decodeRawSocketText(raw: unknown): Promise<string | null> {
  const data = isRecord(raw) && 'data' in raw ? raw.data : raw;
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }
  return null;
}
