import type { TouchInteraction } from '../touch-interactions.js';
import type { DeviceLocationSample } from '../geolocation.js';
import type { PcmAudioStreamPort } from './pcm-audio.js';
import type { HubToClientMessage } from '../protocol/events.js';
import { buildSatelliteHello } from './auth.js';
import { COMPANION_APPROVALS_V2_CAPABILITY } from '../../../../src/shared/contracts/companion-relay.js';
import {
  encodeCompanionUiAudioChunk,
  parseCompanionUiAudioServerFrame,
  type CompanionUiAudioServerFrame,
} from '../../../../src/shared/contracts/companion-ui-audio.js';
import type {
  SatelliteHubClientEventMap,
  SatelliteHubConnectionState,
  SatelliteHubErrorEvent,
  SatelliteHubSession,
  SatelliteHubSnapshot,
  SatelliteHubUnsubscribe,
  SatelliteHubWebSocketFactory,
  SatelliteHubWebSocketLike,
} from './client.js';
import {
  cloneGatewaySession,
  decodeSocketText,
  mapCapabilities,
  parseAgentResponse,
  parseArtifactPreview,
  parseAttachmentReady,
  parseConfirmationResolution,
  parseGatewayEvent,
  parseGatewayResult,
  parseInterruptResult,
  parseShardAgentResponse,
  parseShardDirectory,
  parseShardHistory,
  parseShardInterruptResult,
  validCompanionRequestId,
  type AttachmentReady,
  type CompanionUiResource,
} from './gateway-protocol.js';

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 1_048_576;
const DEFAULT_MAX_PENDING_AUDIO_FRAMES = 32;

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface ActiveAudioStream {
  readonly requestId: string;
  readonly started: Deferred;
  phase: 'starting' | 'ready' | 'stopping';
  nextSequence: number;
  nextAckSequence: number;
  readonly pendingAcks: Map<number, Deferred>;
  turnActive: boolean;
  stopped?: Deferred;
}
interface PendingAction {
  readonly resource: CompanionUiResource;
  readonly artifactId?: string;
  readonly shardId?: string;
  readonly interactionId?: string;
}

interface SendActionOptions {
  readonly requestId?: string;
  readonly artifactId?: string;
  readonly shardId?: string;
  readonly interactionId?: string;
}

interface ActiveInteraction {
  readonly requestId: string;
  readonly shardId?: string;
}

export interface CompanionGatewayClientOptions {
  readonly url: string;
  readonly webSocketFactory?: SatelliteHubWebSocketFactory;
  readonly clock?: () => Date;
  readonly requestIdFactory?: () => string;
  readonly handshakeTimeoutMs?: number;
  readonly maxBufferedAudioBytes?: number;
  readonly maxPendingAudioFrames?: number;
}

type Listener = (event: SatelliteHubClientEventMap[keyof SatelliteHubClientEventMap]) => void;

/**
 * Browser client for the gateway-owned Companion UI action protocol. It
 * deliberately reuses the view store's event port, but never emits the legacy
 * Hub hello protocol and never places device/session/channel authority in a
 * browser frame.
 */
export class CompanionGatewayClient {
  readonly pcmAudio: PcmAudioStreamPort = Object.freeze({
    start: () => this.startPcmAudioStream(),
    write: (pcm: Uint8Array) => this.sendPcmAudio(pcm),
    stop: () => this.stopPcmAudioStream(),
  });
  private readonly listeners = new Map<keyof SatelliteHubClientEventMap, Set<Listener>>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly clock: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly handshakeTimeoutMs: number;
  private readonly maxBufferedAudioBytes: number;
  private readonly maxPendingAudioFrames: number;
  private socket: SatelliteHubWebSocketLike | null = null;
  private state: SatelliteHubConnectionState = 'idle';
  private ready = false;
  private activeInteraction: ActiveInteraction | null = null;
  private activeAudio: ActiveAudioStream | null = null;
  private authorizedShardId: string | null = null;
  private session: SatelliteHubSession = {};

  constructor(private readonly options: CompanionGatewayClientOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.requestIdFactory = options.requestIdFactory ?? (() => globalThis.crypto.randomUUID());
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.maxBufferedAudioBytes = options.maxBufferedAudioBytes
      ?? DEFAULT_MAX_BUFFERED_AUDIO_BYTES;
    this.maxPendingAudioFrames = options.maxPendingAudioFrames
      ?? DEFAULT_MAX_PENDING_AUDIO_FRAMES;
    if (!Number.isSafeInteger(this.maxBufferedAudioBytes)
      || this.maxBufferedAudioBytes < 1
      || !Number.isSafeInteger(this.maxPendingAudioFrames)
      || this.maxPendingAudioFrames < 1) {
      throw new Error('Companion audio backpressure limit is invalid');
    }
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
    return () => listeners?.delete(wrapped);
  }

  snapshot(): SatelliteHubSnapshot {
    return {
      state: this.state,
      ready: this.ready,
      url: this.options.url,
      hello: buildSatelliteHello(),
      session: cloneGatewaySession(this.session),
    };
  }

  connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected' || this.state === 'ready') {
      return Promise.resolve();
    }
    this.setState('connecting');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = globalThis.setTimeout(() => {
        const error = this.emitLocalError('Companion attachment handshake timed out', false);
        this.socket?.close(1002, 'Handshake timeout');
        settle(error);
      }, this.handshakeTimeoutMs);
      const socket = this.createSocket(this.options.url);
      this.socket = socket;
      this.attachSocketListener(socket, 'open', () => {
        this.setState('connected');
        socket.send(JSON.stringify({
          schemaVersion: 1,
          type: 'session.configure',
          eventCapabilities: [COMPANION_APPROVALS_V2_CAPABILITY],
        }));
      });
      this.attachSocketListener(socket, 'message', (raw) => {
        void this.handleRawSocketMessage(raw).then((becameReady) => {
          if (becameReady) settle();
        });
      });
      this.attachSocketListener(socket, 'error', (cause) => {
        const error = this.emitLocalError('Companion gateway websocket error', true, cause);
        if (!this.ready) settle(error);
      });
      this.attachSocketListener(socket, 'close', () => {
        this.clearAudio(new Error('Companion gateway closed during audio startup'));
        this.socket = null;
        this.ready = false;
        this.pending.clear();
        this.activeInteraction = null;
        this.authorizedShardId = null;
        this.session = {};
        this.setState('closed');
        if (!settled) settle(new Error('Companion gateway closed before attachment was ready'));
      });
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.pending.clear();
    this.activeInteraction = null;
    this.authorizedShardId = null;
    this.clearAudio(new Error('Companion gateway disconnected during audio streaming'));
    this.session = {};
    if (socket && socket.readyState !== SOCKET_CLOSED && socket.readyState !== SOCKET_CLOSING) {
      this.setState('closing');
      socket.close(1000, 'Companion UI disconnect');
      return;
    }
    this.setState('closed');
  }

  sendUserText(text: string): void {
    const content = text.trim();
    if (!content) throw this.emitLocalError('Typed message is empty', false);
    const shardId = this.session.activeShardId;
    if (shardId && shardId !== this.authorizedShardId) {
      throw this.emitLocalError('Selected shard has not been reauthorized', true);
    }
    const requestId = shardId
      ? this.sendAction(
          'shards.interact',
          'companion.interact',
          { shardId, content },
          { shardId },
        )
      : this.sendAction(
          'conversation.interact',
          'companion.interact',
          { content },
        );
    this.activeInteraction = {
      requestId,
      ...(shardId ? { shardId } : {}),
    };
    this.emitInbound({ type: 'message', data: { role: 'user', content, final: true } });
  }

  private startPcmAudioStream(): Promise<void> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== SOCKET_OPEN) {
      throw this.emitLocalError('Companion gateway is not ready for audio', true);
    }
    if (!this.session.capabilities?.input?.includes('microphone_pcm')) {
      throw this.emitLocalError('Companion gateway did not authorize microphone audio', true);
    }
    if (this.activeAudio) {
      throw this.emitLocalError('Companion audio stream is already active', true);
    }
    const requestId = this.requestIdFactory();
    if (!validCompanionRequestId(requestId) || this.pending.has(requestId)) {
      throw this.emitLocalError('Companion audio request identifier is invalid', true);
    }
    const started = createDeferred();
    const audio: ActiveAudioStream = {
      requestId,
      started,
      phase: 'starting',
      nextSequence: 0,
      nextAckSequence: 0,
      pendingAcks: new Map(),
      turnActive: false,
    };
    this.activeAudio = audio;
    try {
      socket.send(JSON.stringify({ schemaVersion: 1, type: 'audio.start', requestId }));
    } catch (error) {
      this.activeAudio = null;
      const resolved = this.emitLocalError('Companion audio stream could not be started', true, error);
      started.reject(resolved);
      throw resolved;
    }
    return started.promise;
  }

  private sendPcmAudio(pcm: Uint8Array): Promise<void> {
    const socket = this.socket;
    const audio = this.activeAudio;
    if (!this.ready || !socket || socket.readyState !== SOCKET_OPEN
      || !audio || audio.phase !== 'ready') {
      throw this.emitLocalError('Companion audio stream is not ready', true);
    }
    const frame = encodeCompanionUiAudioChunk(audio.nextSequence, pcm);
    if (audio.pendingAcks.size >= this.maxPendingAudioFrames) {
      throw this.emitLocalError('Companion audio backpressure limit was reached', true);
    }
    if ((socket.bufferedAmount ?? 0) + frame.byteLength > this.maxBufferedAudioBytes) {
      throw this.emitLocalError('Companion audio backpressure limit was reached', true);
    }
    const sequence = audio.nextSequence;
    const acknowledged = createDeferred();
    audio.pendingAcks.set(sequence, acknowledged);
    try {
      socket.send(frame);
      audio.nextSequence = (audio.nextSequence + 1) >>> 0;
    } catch (error) {
      audio.pendingAcks.delete(sequence);
      throw this.emitLocalError('Companion audio chunk could not be sent', true, error);
    }
    return acknowledged.promise;
  }

  private stopPcmAudioStream(): Promise<void> {
    const audio = this.activeAudio;
    if (!audio) return Promise.resolve();
    if (audio.phase === 'starting') {
      return audio.started.promise.then(() => this.stopPcmAudioStream());
    }
    if (audio.phase === 'stopping') return audio.stopped?.promise ?? Promise.resolve();
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.clearAudio(new Error('Companion gateway closed before audio could stop'));
      return Promise.reject(new Error('Companion gateway closed before audio could stop'));
    }
    const stopped = createDeferred();
    audio.phase = 'stopping';
    audio.stopped = stopped;
    try {
      socket.send(JSON.stringify({
        schemaVersion: 1,
        type: 'audio.stop',
        requestId: audio.requestId,
      }));
    } catch (error) {
      const resolved = this.emitLocalError('Companion audio stream could not be stopped', true, error);
      this.clearAudio(resolved);
      return Promise.reject(resolved);
    }
    return stopped.promise;
  }

  interrupt(): void {
    const audio = this.activeAudio;
    const socket = this.socket;
    if (audio?.phase === 'ready' && audio.turnActive
      && socket?.readyState === SOCKET_OPEN) {
      try {
        socket.send(JSON.stringify({
          schemaVersion: 1,
          type: 'audio.interrupt',
          requestId: audio.requestId,
        }));
      } catch (error) {
        throw this.emitLocalError('Companion audio turn could not be interrupted', true, error);
      }
      return;
    }
    const interaction = this.activeInteraction;
    if (!interaction) return;
    const { requestId: interactionId, shardId } = interaction;
    this.sendAction(
      shardId ? 'shards.interrupt' : 'conversation.interrupt',
      'companion.interact',
      shardId ? { shardId, interactionId } : { interactionId },
      {
        ...(shardId ? { shardId } : {}),
        interactionId,
      },
    );
  }

  refreshShards(): void {
    this.sendAction('shards.list', 'companion.read', {});
  }

  selectShard(shardId: string | null): void {
    if (shardId === null) {
      delete this.session.activeShardId;
      this.authorizedShardId = null;
      this.emit('session', cloneGatewaySession(this.session));
      return;
    }
    if (!this.session.shards?.some(entry => entry.shardId === shardId)) {
      throw this.emitLocalError('Selected shard is not in the server directory', true);
    }
    this.session = { ...this.session, activeShardId: shardId };
    this.authorizedShardId = null;
    this.emit('session', cloneGatewaySession(this.session));
    this.sendAction(
      'shards.history',
      'companion.read',
      { shardId },
      { shardId },
    );
  }

  sendApprovalDecision(id: string, decision: 'approve' | 'deny'): void {
    this.sendAction('confirmations.resolve', 'confirmations.resolve', { id, decision });
  }

  sendArtifactPreviewRequest(requestId: string, artifactId: string): void {
    this.sendAction(
      'artifact.preview',
      'artifacts.read',
      { id: artifactId },
      { requestId, artifactId },
    );
  }

  sendTouchInteraction(interaction: TouchInteraction): void {
    this.sendAction('conversation.touch', 'companion.interact', {
      region: interaction.region,
      count: interaction.count,
      durationMs: interaction.durationMs,
    });
  }

  /**
   * The gateway transport reaches PSFN directly — there is no satellite hub in
   * the path to geofence coordinates into a place label. Raw lat/lon must never
   * cross into PSFN, so this transport does not carry `device.location`.
   */
  supportsDeviceLocation(): boolean {
    return false;
  }

  sendDeviceLocation(_sample: DeviceLocationSample): void {
    // Fail closed: forwarding coordinates over the gateway would move raw
    // lat/lon into PSFN, violating the 7ang.8 privacy invariant. device.location
    // is valid only on a coordinate-terminating hub transport.
    throw this.emitLocalError(
      'device.location is unsupported on the gateway transport: raw coordinates must terminate at a satellite hub',
      false,
    );
  }

  private sendAction(
    resource: CompanionUiResource,
    action: 'companion.read' | 'companion.interact' | 'confirmations.resolve' | 'artifacts.read',
    body: Record<string, unknown>,
    options: SendActionOptions = {},
  ): string {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== SOCKET_OPEN) {
      throw this.emitLocalError('Companion gateway is not ready', false);
    }
    const requestId = options.requestId ?? this.requestIdFactory();
    if (!validCompanionRequestId(requestId) || this.pending.has(requestId)
      || this.activeAudio?.requestId === requestId) {
      throw this.emitLocalError('Companion request identifier is invalid', false);
    }
    const frame = { schemaVersion: 1, requestId, action, resource, body };
    this.pending.set(requestId, {
      resource,
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
      ...(options.shardId ? { shardId: options.shardId } : {}),
      ...(options.interactionId ? { interactionId: options.interactionId } : {}),
    });
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.pending.delete(requestId);
      throw this.emitLocalError('Companion action could not be sent', false, error);
    }
    return requestId;
  }

  private async handleRawSocketMessage(raw: unknown): Promise<boolean> {
    const text = await decodeSocketText(raw);
    if (text === null) return this.failProtocol('Unsupported websocket payload');
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      return this.failProtocol('Companion gateway returned invalid JSON', error);
    }
    const ready = parseAttachmentReady(value);
    if (ready) {
      if (this.ready) return this.failProtocol('Duplicate attachment-ready frame');
      this.applyReady(ready);
      return true;
    }
    const audioFrame = parseCompanionUiAudioServerFrame(value);
    if (audioFrame) return this.consumeAudioFrame(audioFrame);
    const event = parseGatewayEvent(value);
    if (event) {
      if (!this.ready || (event.type === 'approval.requested'
        && !this.session.eventCapabilities?.includes(COMPANION_APPROVALS_V2_CAPABILITY))) {
        return this.failProtocol('Companion event arrived before approvals.v2 was acknowledged');
      }
      this.emitInbound(event);
      return false;
    }
    const result = parseGatewayResult(value);
    if (!result) return this.failProtocol('Companion gateway frame was malformed');
    if (!result.ok) {
      this.emitLocalError('Companion action was denied', true);
      return false;
    }
    const pending = this.pending.get(result.requestId);
    if (!pending) return this.failProtocol('Companion result did not match a pending request');
    this.pending.delete(result.requestId);
    this.consumeResult(result.requestId, pending, result.result);
    return false;
  }

  private applyReady(ready: AttachmentReady): void {
    const capabilities = mapCapabilities(ready.capabilities, ready.telemetryScopes);
    this.session = {
      deviceId: ready.device.id,
      deviceName: ready.device.label,
      ...(ready.place ? { place: { id: ready.place.id, name: ready.place.label } } : {}),
      capabilities,
      eventCapabilities: [...ready.eventCapabilities],
      canListShards: ready.telemetryScopes.includes('status'),
    };
    this.ready = true;
    this.setState('ready');
    this.emit('session', cloneGatewaySession(this.session));
  }

  private consumeAudioFrame(frame: CompanionUiAudioServerFrame): false {
    const audio = this.activeAudio;
    if (!audio || audio.requestId !== frame.requestId) {
      return this.failProtocol('Companion audio frame did not match the active stream');
    }
    if (frame.type === 'audio.ready') {
      if (audio.phase !== 'starting') {
        return this.failProtocol('Companion audio stream became ready out of order');
      }
      audio.phase = 'ready';
      audio.started.resolve();
      return false;
    }
    if (frame.type === 'audio.ack') {
      if (audio.phase !== 'ready' || frame.sequence !== audio.nextAckSequence
        || frame.sequence >= audio.nextSequence) {
        return this.failProtocol('Companion audio acknowledgement was out of order');
      }
      const acknowledged = audio.pendingAcks.get(frame.sequence);
      if (!acknowledged) {
        return this.failProtocol('Companion audio acknowledgement was not pending');
      }
      audio.pendingAcks.delete(frame.sequence);
      audio.nextAckSequence = (audio.nextAckSequence + 1) >>> 0;
      acknowledged.resolve();
      return false;
    }
    if (frame.type === 'audio.turn.started') {
      if ((audio.phase !== 'ready' && audio.phase !== 'stopping') || audio.turnActive) {
        return this.failProtocol('Companion audio turn started out of order');
      }
      audio.turnActive = true;
      return false;
    }
    if (frame.type === 'audio.turn.ended') {
      if ((audio.phase !== 'ready' && audio.phase !== 'stopping') || !audio.turnActive) {
        return this.failProtocol('Companion audio turn ended out of order');
      }
      audio.turnActive = false;
      this.emitInbound({ type: 'action', data: 'pause-audio' });
      return false;
    }
    if (audio.phase !== 'stopping' || !audio.stopped || audio.turnActive
      || audio.pendingAcks.size > 0) {
      return this.failProtocol('Companion audio stream stopped out of order');
    }
    this.activeAudio = null;
    audio.stopped.resolve();
    return false;
  }

  private clearAudio(error: Error): void {
    const audio = this.activeAudio;
    this.activeAudio = null;
    if (!audio) return;
    if (audio.phase === 'starting') audio.started.reject(error);
    if (audio.phase === 'stopping') audio.stopped?.reject(error);
    for (const pending of audio.pendingAcks.values()) pending.reject(error);
    audio.pendingAcks.clear();
  }

  private consumeResult(requestId: string, pending: PendingAction, result: unknown): void {
    switch (pending.resource) {
      case 'conversation.interact':
      case 'conversation.touch': {
        const response = parseAgentResponse(result);
        if (!response) {
          this.failProtocol('Companion response was malformed');
          return;
        }
        if (pending.resource === 'conversation.interact'
          && this.activeInteraction?.requestId === requestId
          && this.activeInteraction.shardId === undefined) {
          this.activeInteraction = null;
        }
        if (response.content
          && (pending.resource !== 'conversation.interact' || !this.session.activeShardId)) {
          this.emitInbound({ type: 'message', data: { role: 'assistant', content: response.content, final: true } });
        }
        return;
      }
      case 'shards.list': {
        const shards = parseShardDirectory(result);
        if (!shards) {
          this.failProtocol('Shard directory was malformed');
          return;
        }
        const activeStillListed = this.session.activeShardId
          && shards.some(entry => entry.shardId === this.session.activeShardId);
        this.session = {
          ...this.session,
          shards: [...shards],
          ...(activeStillListed ? { activeShardId: this.session.activeShardId } : {}),
        };
        if (!activeStillListed) this.authorizedShardId = null;
        this.emit('session', cloneGatewaySession(this.session));
        return;
      }
      case 'shards.history': {
        const shardId = pending.shardId;
        if (!shardId) {
          this.failProtocol('Shard history lost its selector');
          return;
        }
        const history = parseShardHistory(result, shardId);
        if (!history) {
          this.failProtocol('Shard history was malformed');
          return;
        }
        if (this.session.activeShardId !== shardId) return;
        this.authorizedShardId = shardId;
        for (const message of history) {
          this.emitInbound({
            type: 'message',
            data: { role: message.role, content: message.content, final: true },
          });
        }
        return;
      }
      case 'shards.interact': {
        const shardId = pending.shardId;
        if (!shardId) {
          this.failProtocol('Shard response lost its selector');
          return;
        }
        const response = parseShardAgentResponse(result, shardId);
        if (!response) {
          this.failProtocol('Shard response was malformed');
          return;
        }
        if (this.activeInteraction?.requestId === requestId
          && this.activeInteraction.shardId === shardId) {
          this.activeInteraction = null;
        }
        if (response.content && this.session.activeShardId === shardId
          && this.authorizedShardId === shardId) {
          this.emitInbound({
            type: 'message',
            data: { role: 'assistant', content: response.content, final: true },
          });
        }
        return;
      }
      case 'conversation.interrupt':
        if (!parseInterruptResult(result, pending.interactionId ?? null)) {
          this.failProtocol('Interrupt result was malformed');
          return;
        }
        if (this.activeInteraction?.requestId === pending.interactionId) {
          this.activeInteraction = null;
        }
        return;
      case 'shards.interrupt': {
        const shardId = pending.shardId;
        if (!shardId
          || !parseShardInterruptResult(result, shardId, pending.interactionId ?? null)) {
          this.failProtocol('Shard interrupt result was malformed');
          return;
        }
        const activeInteraction = this.activeInteraction;
        if (activeInteraction
          && activeInteraction.requestId === pending.interactionId
          && activeInteraction.shardId === shardId) {
          this.activeInteraction = null;
        }
        return;
      }
      case 'confirmations.resolve': {
        const resolved = parseConfirmationResolution(result);
        if (!resolved) {
          this.failProtocol('Confirmation result was malformed');
          return;
        }
        this.emitInbound({
          type: 'approval.resolved',
          data: {
            id: resolved.id,
            status: resolved.status,
            resolvedAt: this.clock().toISOString(),
          },
        });
        return;
      }
      case 'artifact.preview': {
        const preview = parseArtifactPreview(result, pending.artifactId);
        if (!preview) {
          this.failProtocol('Artifact preview result was malformed');
          return;
        }
        this.emitInbound({
          type: 'artifact.preview.result',
          requestId,
          artifactId: preview.artifactId,
          mediaType: preview.mediaType,
          data: preview.dataBase64,
        });
      }
    }
  }

  private emitInbound(message: HubToClientMessage): void {
    this.emit('inbound', { message });
  }

  private failProtocol(message: string, cause?: unknown): false {
    this.emitLocalError(message, false, cause);
    this.socket?.close(1002, 'Protocol error');
    return false;
  }

  private createSocket(url: string): SatelliteHubWebSocketLike {
    if (this.options.webSocketFactory) return this.options.webSocketFactory(url);
    if (!globalThis.WebSocket) throw this.emitLocalError('No WebSocket implementation is available', false);
    return new globalThis.WebSocket(url) as SatelliteHubWebSocketLike;
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
      socket.on(type, (...args) => listener(args[0]));
      return;
    }
    throw this.emitLocalError('WebSocket implementation does not expose an event API', false);
  }

  private setState(next: SatelliteHubConnectionState): void {
    if (this.state === next) return;
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
    const event: SatelliteHubErrorEvent = { message, recoverable, ...(cause ? { cause } : {}) };
    this.emit('error', event);
    return error;
  }

  private emit<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    event: SatelliteHubClientEventMap[K],
  ): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
