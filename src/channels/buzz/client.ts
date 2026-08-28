import { WebSocket, type RawData } from 'ws';
import { toError } from '../../shared/utils/errors.js';
import type { RuntimeChannelLifecycleLogger } from '../backplane/channel-lifecycle.js';
import {
  BUZZ_STREAM_KIND,
  acceptsBuzzStreamEvent,
  companionPubkeyForPrivateKey,
  createBuzzAuthEvent,
  createBuzzStreamEvent,
  isNostrEvent,
  parseBuzzRelayFrame,
} from './protocol.js';
import type { Event as NostrEvent } from 'nostr-tools';

interface PendingPublish {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BuzzRelayClientConfig {
  relayUrl: string;
  companionId: string;
  privateKey: Uint8Array;
  channelIds: readonly string[];
  allowedAuthorPubkeys: readonly string[];
  operationTimeoutMs: number;
}

export interface BuzzRelayClientCallbacks {
  onEvent: (event: NostrEvent) => Promise<void>;
  onTerminalFailure: (kind: string, title: string, error: Error) => Promise<void>;
}

export class BuzzRelayClient {
  readonly companionPubkey: string;
  private readonly config: BuzzRelayClientConfig;
  private readonly callbacks: BuzzRelayClientCallbacks;
  private readonly log: RuntimeChannelLifecycleLogger;
  private readonly channelAllowlist: ReadonlySet<string>;
  private readonly authorAllowlist: ReadonlySet<string>;
  private readonly subscriptionId: string;
  private readonly pendingPublishes = new Map<string, PendingPublish>();
  private socket: WebSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private startupResolve: (() => void) | null = null;
  private startupReject: ((error: Error) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAuthEventId: string | null = null;
  private subscribedSince = 0;
  private started = false;
  private stopping = false;

  constructor(
    config: BuzzRelayClientConfig,
    callbacks: BuzzRelayClientCallbacks,
    log: RuntimeChannelLifecycleLogger,
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.log = log;
    this.companionPubkey = companionPubkeyForPrivateKey(config.privateKey);
    this.channelAllowlist = new Set(config.channelIds);
    this.authorAllowlist = new Set(config.allowedAuthorPubkeys);
    this.subscriptionId = `buzz-companion-${config.companionId}`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return await this.startPromise;
    this.stopping = false;
    const startPromise = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
      this.startupTimer = setTimeout(() => {
        this.failStartup(new Error('Buzz relay timed out waiting for NIP-42 authentication'));
      }, this.config.operationTimeoutMs);
      const socket = new WebSocket(this.config.relayUrl);
      this.socket = socket;
      socket.on('message', raw => this.onSocketMessage(raw));
      socket.on('error', error => this.onSocketError(error));
      socket.on('close', () => this.onSocketClose());
    });
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.rejectPendingPublishes(new Error('Buzz adapter stopped before publish acknowledgement'));
    if (this.startupReject) this.failStartup(new Error('Buzz adapter stopped during startup'));
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(['CLOSE', this.subscriptionId]));
    socket.close();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, this.config.operationTimeoutMs);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async publishStreamEvent(input: {
    channelId: string;
    content: string;
    tags: string[][];
  }): Promise<void> {
    if (!this.started) throw new Error('Buzz adapter is not connected');
    const event = createBuzzStreamEvent({ ...input, privateKey: this.config.privateKey });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPublishes.delete(event.id);
        reject(new Error(`Buzz relay timed out acknowledging event ${event.id}`));
      }, this.config.operationTimeoutMs);
      this.pendingPublishes.set(event.id, { resolve, reject, timer });
      try {
        this.sendFrame(['EVENT', event]);
      } catch (error) {
        clearTimeout(timer);
        this.pendingPublishes.delete(event.id);
        reject(toError(error));
      }
    });
  }

  private onSocketMessage(raw: RawData): void {
    const frame = parseBuzzRelayFrame(raw.toString());
    if (!frame) {
      this.log.warn('Buzz relay sent a malformed frame');
      return;
    }
    void this.handleFrame(frame).catch(error => {
      if (!this.started) {
        this.failStartup(toError(error));
        return;
      }
      void this.callbacks.onTerminalFailure(
        'message-processing',
        'Buzz message processing failed',
        toError(error),
      );
    });
  }

  private async handleFrame(frame: unknown[]): Promise<void> {
    const command = frame[0];
    if (command === 'AUTH') {
      const challenge = frame[1];
      if (typeof challenge !== 'string' || !challenge) throw new Error('Buzz relay sent an invalid AUTH challenge');
      const event = createBuzzAuthEvent(this.config.relayUrl, challenge, this.config.privateKey);
      this.pendingAuthEventId = event.id;
      this.sendFrame(['AUTH', event]);
      return;
    }
    if (command === 'OK') {
      this.handleAcknowledgement(frame);
      return;
    }
    if (command === 'EVENT') {
      await this.handleInboundEvent(frame);
      return;
    }
    if (command === 'NOTICE' && !this.started) {
      throw new Error(`Buzz relay rejected startup: ${typeof frame[1] === 'string' ? frame[1] : 'unknown notice'}`);
    }
    if (command === 'CLOSED' && frame[1] === this.subscriptionId) {
      throw new Error(`Buzz relay closed the Stream subscription: ${typeof frame[2] === 'string' ? frame[2] : 'unknown reason'}`);
    }
  }

  private handleAcknowledgement(frame: unknown[]): void {
    const eventId = frame[1];
    const accepted = frame[2];
    const relayMessage = typeof frame[3] === 'string' && frame[3] ? frame[3] : 'no relay reason';
    if (typeof eventId !== 'string' || typeof accepted !== 'boolean') return;
    if (eventId === this.pendingAuthEventId) {
      this.pendingAuthEventId = null;
      if (!accepted) throw new Error(`Buzz relay rejected NIP-42 authentication: ${relayMessage}`);
      if (!this.started) {
        this.sendSubscription();
        this.completeStartup();
      }
      return;
    }
    const pending = this.pendingPublishes.get(eventId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPublishes.delete(eventId);
    if (accepted) pending.resolve();
    else pending.reject(new Error(`Buzz relay rejected event ${eventId}: ${relayMessage}`));
  }

  private sendSubscription(): void {
    this.subscribedSince = Math.floor(Date.now() / 1_000);
    this.sendFrame(['REQ', this.subscriptionId, {
      kinds: [BUZZ_STREAM_KIND],
      '#h': [...this.channelAllowlist],
      '#p': [this.companionPubkey],
      since: this.subscribedSince,
    }]);
  }

  private completeStartup(): void {
    this.started = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const resolve = this.startupResolve;
    this.startupResolve = null;
    this.startupReject = null;
    resolve?.();
  }

  private failStartup(error: Error): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const reject = this.startupReject;
    this.startupResolve = null;
    this.startupReject = null;
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    reject?.(error);
  }

  private async handleInboundEvent(frame: unknown[]): Promise<void> {
    if (!this.started || frame[1] !== this.subscriptionId || !isNostrEvent(frame[2])) return;
    const event = frame[2];
    if (!acceptsBuzzStreamEvent(event, {
      companionPubkey: this.companionPubkey,
      subscribedSince: this.subscribedSince,
      channelAllowlist: this.channelAllowlist,
      authorAllowlist: this.authorAllowlist,
    })) return;
    await this.callbacks.onEvent(event);
  }

  private sendFrame(frame: unknown[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Buzz relay WebSocket is not open');
    }
    this.socket.send(JSON.stringify(frame));
  }

  private onSocketError(error: Error): void {
    if (!this.started) {
      this.failStartup(new Error(`Buzz relay connection failed: ${error.message}`));
      return;
    }
    void this.callbacks.onTerminalFailure('connection-error', 'Buzz relay connection failed', error);
  }

  private onSocketClose(): void {
    this.socket = null;
    if (this.stopping) return;
    if (!this.started) {
      this.failStartup(new Error('Buzz relay connection closed during startup'));
      return;
    }
    this.started = false;
    this.rejectPendingPublishes(new Error('Buzz relay connection closed before publish acknowledgement'));
    void this.callbacks.onTerminalFailure(
      'connection-closed',
      'Buzz relay connection closed',
      new Error('WebSocket closed'),
    );
  }

  private rejectPendingPublishes(error: Error): void {
    for (const pending of this.pendingPublishes.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingPublishes.clear();
  }
}
