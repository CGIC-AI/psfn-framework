// ── Generic external channel adapter (psfn-framework-pus8m) ──
//
// One instance per `channels.json.external.adapters[]` entry, supervised as
// its own channel surface by the plugin host. The adapter never initiates I/O
// to its bridge: the bridge calls in over the MCP route, and every call is
// answered within owner-file bounds. Isolation rules:
//
//   * inbound turns are capped (`maxInFlightTurns`) and time-boxed
//     (`turnTimeoutMs`); excess or late work is refused, never queued;
//   * outbound sends go to a bounded queue the bridge drains by pulling;
//   * a silent bridge, a flood, or a failed turn is reported as a degraded
//     runtime failure of THIS surface only, throttled per kind;
//   * no method rejects into shared gateway code except `start`, whose
//     failure the supervisor contains to this surface.

import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { AgentResponse } from '../../shared/contracts/runtime.js';
import { toError } from '../../shared/utils/errors.js';
import { isExpectedApiToken } from '../backplane/http/auth.js';
import type { RuntimeChannelLifecycleLogger } from '../backplane/channel-lifecycle.js';
import type {
  ChannelAdapterMeta,
  ChannelAdapterPort,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  MessageHandler,
  OutboundContext,
} from '../backplane/types.js';
import { EXTERNAL_CHANNEL_PLUGIN_ID, type ExternalChannelInstanceConfig } from './config.js';
import {
  assertExternalInboundWithinLimits,
  ExternalChannelMessageRejected,
  externalChannelIdPrefix,
  toExternalSubstrateMessage,
} from './message.js';
import { ExternalChannelOutboundQueue } from './outbound-queue.js';
import {
  EXTERNAL_CHANNEL_PROTOCOL_VERSION,
  type ExternalChannelConnectionState,
  type ExternalChannelHealthInput,
  type ExternalChannelHelloResult,
  type ExternalChannelInboundInput,
  type ExternalChannelInboundResult,
  type ExternalChannelPullInput,
  type ExternalChannelPullResult,
  type ExternalChannelRejectReason,
  type ExternalChannelStatus,
} from './protocol.js';

type DegradedKind = 'heartbeat' | 'flood' | 'turn_timeout' | 'outbound_full' | 'malformed';

export interface ExternalChannelAdapterOptions {
  config: ExternalChannelInstanceConfig;
  token: string;
  intakeScreening: IntakeScreeningService | null;
  log: RuntimeChannelLifecycleLogger;
  /** Reports a contained fault of this surface to the degraded-health plane. */
  reportRuntimeFailure: (error: unknown) => void;
  now?: () => number;
}

interface TurnOutcome {
  kind: 'response' | 'timeout';
  response?: AgentResponse;
}

export class ExternalChannelAdapter implements ChannelAdapterPort {
  readonly id = EXTERNAL_CHANNEL_PLUGIN_ID;
  readonly name: string;
  readonly meta: ChannelAdapterMeta;
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['direct', 'channel'],
    media: false,
    reactions: false,
    threads: false,
    streaming: false,
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;

  readonly #options: ExternalChannelAdapterOptions;
  readonly #prefix: string;
  readonly #now: () => number;
  readonly #queue: ExternalChannelOutboundQueue;
  readonly #inFlight = new Map<string, AbortController>();
  readonly #lastReported = new Map<DegradedKind, number>();
  #handler: MessageHandler | undefined;
  #running = false;
  #endpointAttached = false;
  #endpointRefusal: Error | undefined;
  #startedAt = 0;
  #lastSeenAt: number | undefined;
  #stale = false;
  #bridgeReportedStatus: 'ok' | 'degraded' | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #rejectedInbound = 0;
  #droppedOutbound = 0;

  constructor(options: ExternalChannelAdapterOptions) {
    this.#options = options;
    const { instanceId, label, limits } = options.config;
    this.name = `${EXTERNAL_CHANNEL_PLUGIN_ID}:${instanceId}`;
    this.meta = { label };
    this.config = { enabled: true, accountId: instanceId, connectionLabel: label };
    this.#prefix = externalChannelIdPrefix(instanceId);
    this.#now = options.now ?? Date.now;
    this.#queue = new ExternalChannelOutboundQueue(limits.outboundQueueMax);
    this.outbound = {
      textChunkLimit: limits.maxTextChars,
      sendText: (ctx, text) => this.#sendText(ctx, text),
    };
    this.gateway = {
      init: () => this.init(),
      start: () => this.start(),
      stop: () => this.stop(),
      onMessage: handler => this.onMessage(handler),
    };
  }

  get instanceId(): string {
    return this.#options.config.instanceId;
  }

  get limits(): ExternalChannelInstanceConfig['limits'] {
    return this.#options.config.limits;
  }

  get running(): boolean {
    return this.#running;
  }

  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
  }

  /** The MCP route serves this adapter; without it the adapter refuses to start. */
  attachEndpoint(): void {
    this.#endpointAttached = true;
  }

  /** The route refused this adapter (e.g. a reused credential); start fails closed. */
  refuseEndpoint(error: Error): void {
    this.#endpointRefusal = error;
  }

  get token(): string {
    return this.#options.token;
  }

  authenticates(bearer: string | null): boolean {
    return isExpectedApiToken(bearer, this.#options.token);
  }

  async init(): Promise<void> {
    if (!this.#options.token.trim()) {
      throw new Error(`External channel adapter "${this.instanceId}" has an empty bearer token`);
    }
  }

  async start(): Promise<void> {
    if (this.#endpointRefusal) throw this.#endpointRefusal;
    if (!this.#endpointAttached) {
      throw new Error(
        `External channel adapter "${this.instanceId}" has no served endpoint; `
        + 'the gateway API server must be enabled to admit external bridges',
      );
    }
    if (!this.#handler) {
      throw new Error(`External channel adapter "${this.instanceId}" has no inbound handler`);
    }
    this.#running = true;
    this.#startedAt = this.#now();
    this.#stale = false;
    const interval = setInterval(() => this.#checkHeartbeat(), this.limits.heartbeatTimeoutMs);
    interval.unref();
    this.#watchdog = interval;
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
    const dropped = this.#queue.clear();
    if (dropped > 0) {
      this.#droppedOutbound += dropped;
      this.#options.log.warn('External channel stopped with undelivered outbound messages', {
        instanceId: this.instanceId,
        dropped,
      });
    }
  }

  status(): ExternalChannelStatus {
    return {
      state: this.#connectionState(),
      ...(this.#lastSeenAt !== undefined ? { lastSeenAt: new Date(this.#lastSeenAt).toISOString() } : {}),
      ...(this.#bridgeReportedStatus ? { bridgeReportedStatus: this.#bridgeReportedStatus } : {}),
      inFlightTurns: this.#inFlight.size,
      outboundQueued: this.#queue.size,
      rejectedInbound: this.#rejectedInbound,
      droppedOutbound: this.#droppedOutbound,
    };
  }

  hello(): ExternalChannelHelloResult {
    this.#touch();
    const { limits } = this;
    return {
      protocolVersion: EXTERNAL_CHANNEL_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      label: this.meta.label,
      capabilities: { conversationKinds: ['direct', 'group'], media: false, reactions: false, threads: false },
      limits: {
        maxTextChars: limits.maxTextChars,
        maxIdChars: limits.maxIdChars,
        maxInFlightTurns: limits.maxInFlightTurns,
        turnTimeoutMs: limits.turnTimeoutMs,
        outboundPullMax: limits.outboundPullMax,
        heartbeatTimeoutMs: limits.heartbeatTimeoutMs,
      },
    };
  }

  reportHealth(input: ExternalChannelHealthInput): ExternalChannelStatus {
    this.#touch();
    this.#bridgeReportedStatus = input.status;
    if (input.status === 'degraded') {
      this.#options.log.warn('External bridge reports degraded health', {
        instanceId: this.instanceId,
      });
    }
    return this.status();
  }

  pullOutbound(input: ExternalChannelPullInput): ExternalChannelPullResult {
    this.#touch();
    const max = Math.min(input.maxItems ?? this.limits.outboundPullMax, this.limits.outboundPullMax);
    return { messages: this.#queue.drain(max) };
  }

  /** A request the route could not parse still proves liveness, and is counted. */
  recordMalformedRequest(detail: string): void {
    this.#rejectedInbound += 1;
    this.#reportDegraded('malformed', new Error(`External bridge sent a malformed request: ${detail}`));
  }

  async receiveInbound(input: ExternalChannelInboundInput): Promise<ExternalChannelInboundResult> {
    this.#touch();
    const handler = this.#handler;
    if (!this.#running || !handler) return this.#reject('not_running');
    const { message } = input;
    try {
      assertExternalInboundWithinLimits(message, this.limits);
    } catch (error) {
      return this.#reject('invalid', toError(error).message);
    }
    if (this.#inFlight.has(message.id)) return this.#reject('duplicate');
    if (this.#inFlight.size >= this.limits.maxInFlightTurns) {
      this.#reportDegraded('flood', new Error(
        `External bridge exceeded ${this.limits.maxInFlightTurns} concurrent turns`,
      ));
      return this.#reject('busy');
    }
    const controller = new AbortController();
    this.#inFlight.set(message.id, controller);
    try {
      const substrate = await toExternalSubstrateMessage(message, {
        instanceId: this.instanceId,
        intakeScreening: this.#options.intakeScreening,
        receivedAt: new Date(this.#now()),
      });
      if (controller.signal.aborted) return this.#reject('not_running');
      const outcome = await this.#runTurn(handler, substrate, controller);
      if (outcome.kind === 'timeout') {
        this.#reportDegraded('turn_timeout', new Error(
          `External channel turn exceeded ${this.limits.turnTimeoutMs}ms`,
        ));
        return this.#reject('turn_timeout');
      }
      const content = outcome.response?.content ?? '';
      if (!content.trim()) return { status: 'no_reply' };
      return { status: 'replied', reply: { conversationId: message.conversationId, text: content } };
    } catch (error) {
      if (error instanceof ExternalChannelMessageRejected) {
        return this.#reject('invalid', error.message);
      }
      // The plugin host already recorded a failed companion turn against this
      // surface; the bridge gets a structured refusal it can retry or report.
      this.#options.log.warn('External channel turn failed', {
        instanceId: this.instanceId,
        error: toError(error).message,
      });
      return this.#reject('turn_failed');
    } finally {
      this.#inFlight.delete(message.id);
    }
  }

  async #runTurn(
    handler: MessageHandler,
    message: Parameters<MessageHandler>[0],
    controller: AbortController,
  ): Promise<TurnOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const turn = handler(message, { signal: controller.signal });
    // A turn that settles after its deadline must not surface as an unhandled rejection.
    turn.catch((error: unknown) => {
      if (controller.signal.aborted) {
        this.#options.log.warn('External channel turn settled after abandonment', {
          instanceId: this.instanceId,
          error: toError(error).message,
        });
      }
    });
    const deadline = new Promise<TurnOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.limits.turnTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        turn.then((response): TurnOutcome => ({ kind: 'response', response })),
        deadline,
      ]);
      if (outcome.kind === 'timeout') controller.abort();
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #sendText(ctx: OutboundContext, text: string): Promise<void> {
    if (!this.#running) {
      throw new Error(`External channel adapter "${this.instanceId}" is not running`);
    }
    if (!ctx.channelId.startsWith(this.#prefix) || ctx.channelId.length === this.#prefix.length) {
      throw new Error(`Channel "${ctx.channelId}" does not belong to external adapter "${this.instanceId}"`);
    }
    try {
      this.#queue.enqueue({
        conversationId: ctx.channelId.slice(this.#prefix.length),
        text,
        ...(ctx.replyToMessageId?.startsWith(this.#prefix)
          ? { replyToMessageId: ctx.replyToMessageId.slice(this.#prefix.length) }
          : {}),
      });
    } catch (error) {
      this.#droppedOutbound += 1;
      this.#reportDegraded('outbound_full', error);
      throw error;
    }
  }

  #reject(reason: ExternalChannelRejectReason, detail?: string): ExternalChannelInboundResult {
    this.#rejectedInbound += 1;
    return { status: 'rejected', reason, ...(detail ? { detail } : {}) };
  }

  #touch(): void {
    this.#lastSeenAt = this.#now();
    if (this.#stale) {
      this.#stale = false;
      this.#options.log.warn('External bridge reconnected', { instanceId: this.instanceId });
    }
  }

  #connectionState(): ExternalChannelConnectionState {
    if (!this.#running) return 'stopped';
    if (this.#stale) return 'stale';
    return this.#lastSeenAt === undefined ? 'awaiting_bridge' : 'connected';
  }

  #checkHeartbeat(): void {
    if (!this.#running) return;
    const since = this.#lastSeenAt ?? this.#startedAt;
    if (this.#now() - since <= this.limits.heartbeatTimeoutMs) return;
    this.#stale = true;
    this.#reportDegraded('heartbeat', new Error(
      `External bridge "${this.instanceId}" silent for more than ${this.limits.heartbeatTimeoutMs}ms`,
    ));
  }

  #reportDegraded(kind: DegradedKind, error: unknown): void {
    const now = this.#now();
    const last = this.#lastReported.get(kind);
    if (last !== undefined && now - last < this.limits.failureReportIntervalMs) return;
    this.#lastReported.set(kind, now);
    try {
      this.#options.reportRuntimeFailure(error);
    } catch (reportError) {
      this.#options.log.error('External channel degraded report failed', {
        instanceId: this.instanceId,
        error: toError(reportError).message,
      });
    }
  }
}
