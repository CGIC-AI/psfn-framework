import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import type { Event as NostrEvent } from 'nostr-tools';
import { toError } from '../../shared/utils/errors.js';
import type { RuntimeChannelLifecycleLogger } from '../backplane/channel-lifecycle.js';
import {
  BUZZ_MEMBER_ADDED_KIND,
  BUZZ_MEMBER_REMOVED_KIND,
  BUZZ_MEMBERSHIP_SNAPSHOT_KIND,
  BUZZ_STREAM_KIND,
  acceptsBuzzStreamEvent,
  companionPubkeyForPrivateKey,
  createBuzzAuthEvent,
  createBuzzStreamEvent,
  isNostrEvent,
  parseBuzzMembershipChange,
  parseBuzzMembershipSnapshot,
  parseBuzzRelayFrame,
} from './protocol.js';

interface PendingPublish {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BuzzRelayClientConfig {
  relayUrl: string;
  relayPubkey: string;
  companionId: string;
  privateKey: Uint8Array;
  channelIds: readonly string[];
  allowedAuthorPubkeys: readonly string[];
  machineAuthorPubkeys: readonly string[];
  maxAutonomousReplyHops: number;
  replayWindowSeconds: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  maxReconnectAttempts: number;
  operationTimeoutMs: number;
}

export interface BuzzRelayClientCallbacks {
  onEvent: (event: NostrEvent) => Promise<void>;
  onMembershipSnapshot: (channelIds: readonly string[], observedAtMs: number) => Promise<void>;
  onMembershipChange: (channelId: string, active: boolean, observedAtMs: number) => Promise<void>;
  onConnected: () => Promise<void>;
  onTerminalFailure: (kind: string, title: string, error: Error) => Promise<void>;
}

export class BuzzRelayClient {
  readonly companionPubkey: string;
  private readonly configuredChannels: ReadonlySet<string>;
  private readonly authorAllowlist: ReadonlySet<string>;
  private readonly machineAuthorPubkeys: ReadonlySet<string>;
  private readonly membershipSubscriptionId: string;
  private readonly membershipChangesSubscriptionId: string;
  private readonly streamSubscriptionId: string;
  private readonly pendingPublishes = new Map<string, PendingPublish>();
  private readonly locallyClosedSubscriptions = new Set<string>();
  private readonly eligibleChannels = new Set<string>();
  private readonly discoveredChannels = new Set<string>();
  private socket: WebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private connectionResolve: (() => void) | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectController: AbortController | null = null;
  private reconnectTask: Promise<void> | null = null;
  private reconnectLossResolve: (() => void) | null = null;
  private pendingAuthEventId: string | null = null;
  private replayCursor: number | null = null;
  private membershipQuerySince = 0;
  private subscribedSince = 0;
  private running = false;
  private connected = false;
  private stopping = false;

  constructor(
    private readonly config: BuzzRelayClientConfig,
    private readonly callbacks: BuzzRelayClientCallbacks,
    private readonly log: RuntimeChannelLifecycleLogger,
  ) {
    this.companionPubkey = companionPubkeyForPrivateKey(config.privateKey);
    this.configuredChannels = new Set(config.channelIds);
    this.authorAllowlist = new Set(config.allowedAuthorPubkeys);
    this.machineAuthorPubkeys = new Set(config.machineAuthorPubkeys);
    this.membershipSubscriptionId = `buzz-membership-${config.companionId}`;
    this.membershipChangesSubscriptionId = `buzz-membership-live-${config.companionId}`;
    this.streamSubscriptionId = `buzz-stream-${config.companionId}`;
  }

  setReplayCursor(cursor: number | null): void {
    if (cursor !== null) this.replayCursor = Math.max(this.replayCursor ?? 0, cursor);
  }

  async start(): Promise<void> {
    if (this.running && this.connected) return;
    this.running = true;
    this.stopping = false;
    try {
      await this.connectOnce();
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.connected = false;
    this.reconnectController?.abort(new Error('Buzz adapter stopped'));
    this.reconnectController = null;
    this.rejectPendingPublishes(new Error('Buzz adapter stopped before publish acknowledgement'));
    const socket = this.socket;
    this.socket = null;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    const rejectConnection = this.connectionReject;
    this.connectionResolve = null;
    this.connectionReject = null;
    rejectConnection?.(new Error('Buzz adapter stopped during connection'));
    if (socket && socket.readyState === WebSocket.OPEN) {
      for (const subscriptionId of this.subscriptionIds()) {
        socket.send(JSON.stringify(['CLOSE', subscriptionId]));
      }
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
    } else if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
    await this.reconnectTask?.catch(() => undefined);
    this.reconnectTask = null;
  }

  createStreamEvent(input: {
    channelId: string;
    content: string;
    tags: string[][];
  }): NostrEvent {
    return createBuzzStreamEvent({ ...input, privateKey: this.config.privateKey });
  }

  async publishEvent(event: NostrEvent): Promise<void> {
    if (!this.running || !this.connected) throw new Error('Buzz adapter is not connected');
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

  private async connectOnce(): Promise<void> {
    if (this.connectionPromise) return await this.connectionPromise;
    this.connected = false;
    this.discoveredChannels.clear();
    this.locallyClosedSubscriptions.clear();
    const promise = new Promise<void>((resolve, reject) => {
      this.connectionResolve = resolve;
      this.connectionReject = reject;
      this.connectionTimer = setTimeout(() => {
        this.failConnection(new Error('Buzz relay timed out loading authenticated membership'));
      }, this.config.operationTimeoutMs);
      const socket = new WebSocket(this.config.relayUrl);
      this.socket = socket;
      socket.on('message', raw => this.onSocketMessage(socket, raw));
      socket.on('error', error => this.onSocketError(socket, error));
      socket.on('close', () => this.onSocketClose(socket));
    });
    this.connectionPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectionPromise === promise) this.connectionPromise = null;
    }
  }

  private onSocketMessage(socket: WebSocket, raw: RawData): void {
    if (socket !== this.socket) return;
    const frame = parseBuzzRelayFrame(raw.toString());
    if (!frame) {
      this.log.warn('Buzz relay sent a malformed frame');
      return;
    }
    void this.handleFrame(frame).catch(error => {
      if (!this.connected) {
        this.failConnection(toError(error));
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
      if (typeof challenge !== 'string' || !challenge) {
        throw new Error('Buzz relay sent an invalid AUTH challenge');
      }
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
    if (command === 'EOSE' && frame[1] === this.membershipSubscriptionId) {
      await this.completeMembershipLoad();
      return;
    }
    if (command === 'NOTICE' && !this.connected) {
      throw new Error(`Buzz relay rejected startup: ${typeof frame[1] === 'string' ? frame[1] : 'unknown notice'}`);
    }
    if (command === 'CLOSED' && this.subscriptionIds().includes(String(frame[1]))) {
      const subscriptionId = String(frame[1]);
      if (this.stopping || this.locallyClosedSubscriptions.delete(subscriptionId)) return;
      const error = new Error(`Buzz relay closed a required subscription: ${typeof frame[2] === 'string' ? frame[2] : 'unknown reason'}`);
      if (!this.connected) throw error;
      this.log.warn(error.message);
      this.socket?.terminate();
      return;
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
      this.membershipQuerySince = Math.floor(Date.now() / 1_000);
      this.sendFrame(['REQ', this.membershipSubscriptionId, {
        kinds: [BUZZ_MEMBERSHIP_SNAPSHOT_KIND],
        '#p': [this.companionPubkey],
      }]);
      return;
    }
    const pending = this.pendingPublishes.get(eventId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPublishes.delete(eventId);
    if (accepted) pending.resolve();
    else pending.reject(new Error(`Buzz relay rejected event ${eventId}: ${relayMessage}`));
  }

  private async handleInboundEvent(frame: unknown[]): Promise<void> {
    const subscriptionId = frame[1];
    if (typeof subscriptionId !== 'string' || !isNostrEvent(frame[2])) return;
    const event = frame[2];
    if (subscriptionId === this.membershipSubscriptionId && !this.connected) {
      const channelId = parseBuzzMembershipSnapshot(
        event,
        this.config.relayPubkey,
        this.companionPubkey,
      );
      if (channelId) this.discoveredChannels.add(channelId);
      return;
    }
    if (subscriptionId === this.membershipChangesSubscriptionId && this.connected) {
      const change = parseBuzzMembershipChange(
        event,
        this.config.relayPubkey,
        this.companionPubkey,
      );
      if (!change) return;
      await this.applyMembershipChange(change.channelId, change.active, Date.now());
      return;
    }
    if (subscriptionId !== this.streamSubscriptionId || !this.connected) return;
    if (!acceptsBuzzStreamEvent(event, {
      companionPubkey: this.companionPubkey,
      subscribedSince: this.subscribedSince,
      channelAllowlist: this.eligibleChannels,
      authorAllowlist: this.authorAllowlist,
      machineAuthorPubkeys: this.machineAuthorPubkeys,
      maxAutonomousReplyHops: this.config.maxAutonomousReplyHops,
    })) return;
    await this.callbacks.onEvent(event);
  }

  private async completeMembershipLoad(): Promise<void> {
    this.refreshEligibleChannels();
    await this.callbacks.onMembershipSnapshot([...this.eligibleChannels], Date.now());
    this.closeSubscription(this.membershipSubscriptionId);
    this.sendFrame(['REQ', this.membershipChangesSubscriptionId, {
      kinds: [BUZZ_MEMBER_ADDED_KIND, BUZZ_MEMBER_REMOVED_KIND],
      '#p': [this.companionPubkey],
      since: this.membershipQuerySince,
    }]);
    this.connected = true;
    this.sendStreamSubscription();
    try {
      await this.callbacks.onConnected();
    } catch (error) {
      this.connected = false;
      throw error;
    }
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    const resolve = this.connectionResolve;
    this.connectionResolve = null;
    this.connectionReject = null;
    resolve?.();
  }

  private async applyMembershipChange(
    channelId: string,
    active: boolean,
    observedAtMs: number,
  ): Promise<void> {
    if (active) this.discoveredChannels.add(channelId);
    else this.discoveredChannels.delete(channelId);
    const wasEligible = this.eligibleChannels.has(channelId);
    const isEligible = active && this.isConfiguredChannel(channelId);
    if (wasEligible === isEligible) return;
    if (isEligible) this.eligibleChannels.add(channelId);
    else this.eligibleChannels.delete(channelId);
    await this.callbacks.onMembershipChange(channelId, isEligible, observedAtMs);
    this.closeSubscription(this.streamSubscriptionId);
    this.sendStreamSubscription();
  }

  private refreshEligibleChannels(): void {
    this.eligibleChannels.clear();
    for (const channelId of this.discoveredChannels) {
      if (this.isConfiguredChannel(channelId)) this.eligibleChannels.add(channelId);
    }
  }

  private isConfiguredChannel(channelId: string): boolean {
    return this.configuredChannels.size === 0 || this.configuredChannels.has(channelId);
  }

  private sendStreamSubscription(): void {
    if (this.eligibleChannels.size === 0) return;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    this.subscribedSince = Math.max(
      0,
      (this.replayCursor ?? nowSeconds) - this.config.replayWindowSeconds,
    );
    this.sendFrame(['REQ', this.streamSubscriptionId, {
      kinds: [BUZZ_STREAM_KIND],
      '#h': [...this.eligibleChannels],
      '#p': [this.companionPubkey],
      since: this.subscribedSince,
    }]);
  }

  private failConnection(error: Error): void {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    const reject = this.connectionReject;
    this.connectionResolve = null;
    this.connectionReject = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    reject?.(error);
  }

  private onSocketError(socket: WebSocket, error: Error): void {
    if (socket !== this.socket) return;
    if (!this.connected) {
      this.failConnection(new Error(`Buzz relay connection failed: ${error.message}`));
      return;
    }
    this.log.warn('Buzz relay connection error; waiting for reconnect', { error: error.message });
    socket.terminate();
  }

  private onSocketClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    if (this.stopping) return;
    if (!this.connected) {
      this.failConnection(new Error('Buzz relay connection closed during startup'));
      return;
    }
    this.connected = false;
    this.rejectPendingPublishes(new Error('Buzz relay connection closed before publish acknowledgement'));
    this.reconnectLossResolve?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTask || !this.running || this.stopping) return;
    const controller = new AbortController();
    this.reconnectController = controller;
    this.reconnectTask = this.runReconnectLoop(controller.signal)
      .finally(() => {
        if (this.reconnectController === controller) this.reconnectController = null;
        this.reconnectTask = null;
      });
  }

  private async runReconnectLoop(signal: AbortSignal): Promise<void> {
    let lastError = new Error('Buzz relay connection closed');
    for (let attempt = 1; attempt <= this.config.maxReconnectAttempts; attempt += 1) {
      try {
        const exponentialDelay = this.config.reconnectBaseDelayMs * (2 ** (attempt - 1));
        await delay(Math.min(exponentialDelay, this.config.reconnectMaxDelayMs), undefined, { signal });
        signal.throwIfAborted();
        await this.connectOnce();
        if (!(await this.waitForReconnectStability(signal))) {
          throw new Error('Buzz relay connection closed before reconnect stabilized');
        }
        return;
      } catch (error) {
        if (signal.aborted) return;
        lastError = toError(error);
      }
    }
    this.running = false;
    await this.callbacks.onTerminalFailure(
      'reconnect-exhausted',
      'Buzz relay reconnect attempts exhausted',
      lastError,
    );
  }

  private async waitForReconnectStability(signal: AbortSignal): Promise<boolean> {
    let resolveLoss!: () => void;
    const connectionLost = new Promise<void>(resolve => {
      resolveLoss = resolve;
    });
    this.reconnectLossResolve = resolveLoss;
    try {
      if (!this.connected) return false;
      const stable = await Promise.race([
        delay(this.config.operationTimeoutMs, undefined, { signal }).then(() => true),
        connectionLost.then(() => false),
      ]);
      return stable && this.connected;
    } finally {
      if (this.reconnectLossResolve === resolveLoss) this.reconnectLossResolve = null;
    }
  }

  private sendFrame(frame: unknown[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Buzz relay WebSocket is not open');
    }
    this.socket.send(JSON.stringify(frame));
  }

  private closeSubscription(subscriptionId: string): void {
    this.locallyClosedSubscriptions.add(subscriptionId);
    this.sendFrame(['CLOSE', subscriptionId]);
  }

  private subscriptionIds(): string[] {
    return [
      this.membershipSubscriptionId,
      this.membershipChangesSubscriptionId,
      this.streamSubscriptionId,
    ];
  }

  private rejectPendingPublishes(error: Error): void {
    for (const pending of this.pendingPublishes.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingPublishes.clear();
  }
}
