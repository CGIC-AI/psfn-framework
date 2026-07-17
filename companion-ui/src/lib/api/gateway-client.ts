import type { TouchInteraction } from '../touch-interactions.js';
import type { HubToClientMessage } from '../protocol/events.js';
import { buildSatelliteHello } from './auth.js';
import { COMPANION_APPROVALS_V2_CAPABILITY } from '../../../../src/shared/contracts/companion-relay.js';
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
  validCompanionRequestId,
  type AttachmentReady,
  type CompanionUiResource,
} from './gateway-protocol.js';

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
interface PendingAction {
  readonly resource: CompanionUiResource;
  readonly artifactId?: string;
}

export interface CompanionGatewayClientOptions {
  readonly url: string;
  readonly webSocketFactory?: SatelliteHubWebSocketFactory;
  readonly clock?: () => Date;
  readonly requestIdFactory?: () => string;
  readonly handshakeTimeoutMs?: number;
}

type Listener = (event: SatelliteHubClientEventMap[keyof SatelliteHubClientEventMap]) => void;

/**
 * Browser client for the gateway-owned Companion UI action protocol. It
 * deliberately reuses the view store's event port, but never emits the legacy
 * Hub hello protocol and never places device/session/channel authority in a
 * browser frame.
 */
export class CompanionGatewayClient {
  private readonly listeners = new Map<keyof SatelliteHubClientEventMap, Set<Listener>>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly clock: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly handshakeTimeoutMs: number;
  private socket: SatelliteHubWebSocketLike | null = null;
  private state: SatelliteHubConnectionState = 'idle';
  private ready = false;
  private activeInteractionRequestId: string | null = null;
  private session: SatelliteHubSession = {};

  constructor(private readonly options: CompanionGatewayClientOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.requestIdFactory = options.requestIdFactory ?? (() => globalThis.crypto.randomUUID());
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
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
        this.socket = null;
        this.ready = false;
        this.pending.clear();
        this.activeInteractionRequestId = null;
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
    this.activeInteractionRequestId = null;
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
    const requestId = this.sendAction(
      'conversation.interact',
      'companion.interact',
      { content },
    );
    this.activeInteractionRequestId = requestId;
    this.emitInbound({ type: 'message', data: { role: 'user', content, final: true } });
  }

  interrupt(): void {
    const interactionId = this.activeInteractionRequestId;
    if (!interactionId) return;
    this.sendAction(
      'conversation.interrupt',
      'companion.interact',
      { interactionId },
    );
  }

  sendApprovalDecision(id: string, decision: 'approve' | 'deny'): void {
    this.sendAction('confirmations.resolve', 'confirmations.resolve', { id, decision });
  }

  sendArtifactPreviewRequest(requestId: string, artifactId: string): void {
    this.sendAction('artifact.preview', 'artifacts.read', { id: artifactId }, requestId, artifactId);
  }

  sendTouchInteraction(interaction: TouchInteraction): void {
    this.sendAction('conversation.touch', 'companion.interact', {
      region: interaction.region,
      count: interaction.count,
      durationMs: interaction.durationMs,
    });
  }

  private sendAction(
    resource: CompanionUiResource,
    action: 'companion.interact' | 'confirmations.resolve' | 'artifacts.read',
    body: Record<string, unknown>,
    suppliedRequestId?: string,
    artifactId?: string,
  ): string {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== SOCKET_OPEN) {
      throw this.emitLocalError('Companion gateway is not ready', false);
    }
    const requestId = suppliedRequestId ?? this.requestIdFactory();
    if (!validCompanionRequestId(requestId) || this.pending.has(requestId)) {
      throw this.emitLocalError('Companion request identifier is invalid', false);
    }
    const frame = { schemaVersion: 1, requestId, action, resource, body };
    this.pending.set(requestId, { resource, ...(artifactId ? { artifactId } : {}) });
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
    };
    this.ready = true;
    this.setState('ready');
    this.emit('session', cloneGatewaySession(this.session));
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
        if (pending.resource === 'conversation.interact' && this.activeInteractionRequestId === requestId) {
          this.activeInteractionRequestId = null;
        }
        if (response.content) {
          this.emitInbound({ type: 'message', data: { role: 'assistant', content: response.content, final: true } });
        }
        return;
      }
      case 'conversation.interrupt':
        if (!parseInterruptResult(result, this.activeInteractionRequestId)) {
          this.failProtocol('Interrupt result was malformed');
          return;
        }
        this.activeInteractionRequestId = null;
        return;
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
