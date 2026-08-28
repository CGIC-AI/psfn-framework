import type { Event as NostrEvent } from 'nostr-tools';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toError } from '../../shared/utils/errors.js';
import { resolveAgentResponseDisposition } from '../../shared/agent-response-disposition.js';
import type {
  ChannelAdapterPort,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  ChannelSecurityAdapter,
  MessageHandler,
  OutboundContext,
} from '../backplane/types.js';
import type { RuntimeChannelLifecycleLogger } from '../backplane/channel-lifecycle.js';
import { BuzzRelayClient } from './client.js';
import {
  buzzCausalReplyTags,
  normalizeAcknowledgement,
  planBuzzCausalReply,
} from './causal-policy.js';
import { toBuzzSubstrateMessage } from './message.js';
import { normalizeBuzzRelayUrl } from './origin.js';
import {
  BUZZ_STREAM_TEXT_CHUNK_LIMIT,
  buzzTagValues,
  parseBuzzChannelId,
  parseBuzzPrivateKey,
} from './protocol.js';
import type { BuzzRecoveryStore } from './recovery-store.js';

export interface BuzzAdapterConfig {
  enabled: boolean;
  relayUrl: string;
  relayPubkey: string;
  companionId: string;
  privateKey: string;
  channelIds: readonly string[];
  allowedAuthorPubkeys: readonly string[];
  machineAuthorPubkeys: readonly string[];
  maxAutonomousReplyHops: number;
  noInformationAcknowledgements: readonly string[];
  replayWindowSeconds: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  maxReconnectAttempts: number;
}

interface BuzzOperatorAlert {
  title: string;
  message: string;
  idempotencyKey: string;
}

type BuzzOperatorAlertHandler = (alert: BuzzOperatorAlert) => Promise<void>;

export interface BuzzAdapterOptions {
  shutdownTimeoutMs: number;
  intakeScreening?: IntakeScreeningService | null;
  log?: RuntimeChannelLifecycleLogger;
  recoveryStore: BuzzRecoveryStore;
}

export class BuzzAdapter implements ChannelAdapterPort {
  readonly id = 'buzz';
  readonly name = 'Buzz';
  readonly meta = { label: 'Buzz', emoji: '🐝' };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['channel'],
    media: false,
    reactions: false,
    threads: false,
    streaming: false,
    promptChannelType: 'buzz',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter;
  readonly prompt: ChannelPromptAdapter = {
    resolveChannelType: () => 'buzz',
  };

  private readonly buzz: Omit<BuzzAdapterConfig, 'privateKey'>;
  private readonly intakeScreening: IntakeScreeningService | null;
  private readonly log: RuntimeChannelLifecycleLogger;
  private readonly channelAllowlist: ReadonlySet<string>;
  private readonly machineAuthorPubkeys: ReadonlySet<string>;
  private readonly noInformationAcknowledgements: ReadonlySet<string>;
  private readonly recoveryStore: BuzzRecoveryStore;
  private readonly inFlightByChannel = new Map<string, Set<AbortController>>();
  private readonly recoveredPublications = new Map<string, Promise<void>>();
  private readonly inFlightTasks = new Set<Promise<void>>();
  private readonly shutdownTimeoutMs: number;
  private readonly client: BuzzRelayClient;
  private handler: MessageHandler | null = null;
  private operatorAlertHandler: BuzzOperatorAlertHandler | null = null;

  constructor(config: BuzzAdapterConfig, options: BuzzAdapterOptions) {
    const relayUrl = normalizeBuzzRelayUrl(config.relayUrl, 'Buzz adapter relayUrl');
    this.buzz = {
      enabled: config.enabled,
      relayUrl,
      relayPubkey: config.relayPubkey,
      companionId: config.companionId,
      channelIds: [...config.channelIds],
      allowedAuthorPubkeys: [...config.allowedAuthorPubkeys],
      machineAuthorPubkeys: [...config.machineAuthorPubkeys],
      maxAutonomousReplyHops: config.maxAutonomousReplyHops,
      noInformationAcknowledgements: [...config.noInformationAcknowledgements],
      replayWindowSeconds: config.replayWindowSeconds,
      reconnectBaseDelayMs: config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
    };
    this.intakeScreening = options.intakeScreening ?? null;
    this.log = options.log ?? createComponentLogger('BuzzAdapter');
    this.channelAllowlist = new Set(config.channelIds);
    this.machineAuthorPubkeys = new Set(config.machineAuthorPubkeys);
    this.noInformationAcknowledgements = new Set(
      config.noInformationAcknowledgements.map(normalizeAcknowledgement),
    );
    this.recoveryStore = options.recoveryStore;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.client = new BuzzRelayClient({
      relayUrl,
      relayPubkey: config.relayPubkey,
      companionId: config.companionId,
      privateKey: parseBuzzPrivateKey(config.privateKey),
      channelIds: config.channelIds,
      allowedAuthorPubkeys: config.allowedAuthorPubkeys,
      machineAuthorPubkeys: config.machineAuthorPubkeys,
      maxAutonomousReplyHops: config.maxAutonomousReplyHops,
      replayWindowSeconds: config.replayWindowSeconds,
      reconnectBaseDelayMs: config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
      operationTimeoutMs: options.shutdownTimeoutMs,
    }, {
      onEvent: async event => {
        const work = this.handleInboundEvent(event);
        this.inFlightTasks.add(work);
        try {
          await work;
        } finally {
          this.inFlightTasks.delete(work);
        }
      },
      onMembershipSnapshot: async (channelIds, observedAtMs) => {
        await this.recoveryStore.replaceMemberships(channelIds, observedAtMs);
      },
      onMembershipChange: async (channelId, active, observedAtMs) => {
        await this.recoveryStore.setMembership(channelId, active, observedAtMs);
        if (!active) this.abortChannel(channelId, 'Buzz room membership was removed');
      },
      onConnected: async () => this.recoverDeliveries(),
      onTerminalFailure: async (kind, title, error) => this.alertOperator(kind, title, error),
    }, this.log);
    this.config = {
      enabled: config.enabled,
      accountId: this.client.companionPubkey,
      connectionLabel: relayUrl,
    };
    this.security = {
      supportsDirectMessages: false,
      requiresMentionForChannelMessages: true,
      allowlist: [...config.allowedAuthorPubkeys],
    };
    this.outbound = {
      textChunkLimit: BUZZ_STREAM_TEXT_CHUNK_LIMIT,
      sendText: async (context, text) => await this.sendOutboundText(context, text),
    };
    this.gateway = {
      init: async () => undefined,
      start: async () => this.start(),
      stop: async () => this.stop(),
    };
  }

  async init(): Promise<void> {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onOperatorAlert(handler: BuzzOperatorAlertHandler): void {
    this.operatorAlertHandler = handler;
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async start(): Promise<void> {
    if (!this.buzz.enabled) return;
    if (!this.handler) throw new Error('Buzz adapter requires an inbound message handler before start');
    if (!this.operatorAlertHandler) throw new Error('Buzz adapter requires an operator alert handler before start');
    await this.recoveryStore.waitUntilReady();
    this.client.setReplayCursor(await this.recoveryStore.loadReplayCursor());
    await this.client.start();
  }

  async stop(): Promise<void> {
    for (const channelId of this.inFlightByChannel.keys()) {
      this.abortChannel(channelId, 'Buzz adapter stopped');
    }
    let stopError: unknown;
    try {
      await this.client.stop();
    } catch (error) {
      stopError = error;
    }
    let inFlightTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlightTasks]).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          inFlightTimer = setTimeout(() => {
            reject(new Error('Buzz adapter timed out waiting for cancelled turns'));
          }, this.shutdownTimeoutMs);
        }),
      ]);
    } catch (error) {
      stopError = stopError
        ? new AggregateError([stopError, error], 'Buzz adapter shutdown failed')
        : error;
    } finally {
      if (inFlightTimer) clearTimeout(inFlightTimer);
    }
    try {
      await this.recoveryStore.close();
    } catch (error) {
      if (stopError) throw new AggregateError([stopError, error], 'Buzz adapter shutdown failed');
      throw error;
    }
    if (stopError) throw stopError;
  }

  private async handleInboundEvent(event: NostrEvent): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error('Buzz adapter lost its inbound message handler');
    const channelId = buzzTagValues(event, 'h')[0]!;
    const authorIsMachine = this.machineAuthorPubkeys.has(event.pubkey);
    if (!authorIsMachine) {
      await this.recoveryStore.registerHumanRoot(event.id, event.pubkey);
    }
    const claim = await this.recoveryStore.claimInbound({
      eventId: event.id,
      channelId,
      eventCreatedAt: event.created_at,
    });
    if (!claim.claimed) {
      if (claim.record.state === 'ready' && claim.record.outboundEvent) {
        await this.publishRecovered(event.id, claim.record.outboundEvent);
        await this.advanceCursor(claim.record.eventCreatedAt);
      }
      return;
    }
    const causal = planBuzzCausalReply({
      event,
      companionPubkey: this.client.companionPubkey,
      machineAuthorPubkeys: this.machineAuthorPubkeys,
      maxAutonomousReplyHops: this.buzz.maxAutonomousReplyHops,
      noInformationAcknowledgements: this.noInformationAcknowledgements,
    });
    if (causal.suppress) {
      await this.suppress(event, causal.suppress);
      return;
    }
    if (!causal.plan) throw new Error('Buzz causal reply policy returned no disposition');
    if (authorIsMachine && !(await this.recoveryStore.hasHumanRoot(causal.plan.rootEventId))) {
      await this.suppress(event, 'unknown_causal_root');
      return;
    }
    if (causal.causalEdge && !(await this.recoveryStore.claimCausalEdge(causal.causalEdge))) {
      await this.suppress(event, 'duplicate_causal_edge');
      return;
    }
    const controller = this.registerInFlight(channelId);
    try {
      const message = await toBuzzSubstrateMessage(event, {
        relayUrl: this.buzz.relayUrl,
        companionId: this.buzz.companionId,
        companionPubkey: this.client.companionPubkey,
        intakeScreening: this.intakeScreening,
      });
      let response: Awaited<ReturnType<MessageHandler>>;
      try {
        response = await handler(message, {
          signal: controller.signal,
          cancellationId: `buzz:${event.id}`,
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        await this.suppress(event, 'turn_cancelled');
        return;
      }
      const disposition = resolveAgentResponseDisposition(response);
      if (disposition.kind !== 'send') {
        const reason = disposition.kind === 'policy_suppressed'
          ? disposition.reason
          : disposition.kind === 'intentional_no_reply'
            ? 'intentional_no_reply'
            : disposition.kind === 'notification_ack'
              ? 'empty_response'
              : 'empty_response';
        await this.suppress(event, reason);
        return;
      }
      if (!response.content.trim()) {
        await this.suppress(event, 'empty_response');
        return;
      }
      const outboundEvent = this.client.createStreamEvent({
        channelId,
        content: response.content,
        tags: buzzCausalReplyTags(causal.plan),
      });
      await this.recoveryStore.markReady(event.id, outboundEvent);
      await this.client.publishEvent(outboundEvent);
      await this.recoveryStore.markCompleted(event.id);
      await this.advanceCursor(event.created_at);
    } finally {
      this.unregisterInFlight(channelId, controller);
    }
  }

  private async recoverDeliveries(): Promise<void> {
    for (const record of await this.recoveryStore.listRecoverable()) {
      if (record.state === 'ready' && record.outboundEvent) {
        await this.publishRecovered(record.eventId, record.outboundEvent);
        await this.advanceCursor(record.eventCreatedAt);
        continue;
      }
      await this.alertOperator(
        `ambiguous-processing:${record.eventId}`,
        'Buzz recovery found an ambiguous in-flight turn',
        new Error(`Accepted Buzz event ${record.eventId} requires operator reconciliation`),
      );
    }
  }

  private async publishRecovered(eventId: string, outboundEvent: NostrEvent): Promise<void> {
    const inFlight = this.recoveredPublications.get(eventId);
    if (inFlight) return await inFlight;
    const publication = (async () => {
      await this.client.publishEvent(outboundEvent);
      await this.recoveryStore.markCompleted(eventId);
    })();
    this.recoveredPublications.set(eventId, publication);
    try {
      await publication;
    } finally {
      if (this.recoveredPublications.get(eventId) === publication) {
        this.recoveredPublications.delete(eventId);
      }
    }
  }

  private async suppress(event: NostrEvent, reason: string): Promise<void> {
    await this.recoveryStore.markSuppressed(event.id, reason);
    await this.advanceCursor(event.created_at);
    this.log.warn('Buzz autonomous reply terminated without publication', {
      eventId: event.id,
      reason,
    });
  }

  private async advanceCursor(eventCreatedAt: number): Promise<void> {
    await this.recoveryStore.advanceReplayCursor(eventCreatedAt);
    this.client.setReplayCursor(eventCreatedAt);
  }

  private registerInFlight(channelId: string): AbortController {
    const controller = new AbortController();
    const controllers = this.inFlightByChannel.get(channelId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.inFlightByChannel.set(channelId, controllers);
    return controller;
  }

  private unregisterInFlight(channelId: string, controller: AbortController): void {
    const controllers = this.inFlightByChannel.get(channelId);
    controllers?.delete(controller);
    if (controllers?.size === 0) this.inFlightByChannel.delete(channelId);
  }

  private abortChannel(channelId: string, reason: string): void {
    const controllers = this.inFlightByChannel.get(channelId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort(new Error(reason));
    this.inFlightByChannel.delete(channelId);
  }

  private async sendOutboundText(context: OutboundContext, _content: string): Promise<void> {
    const channelId = parseBuzzChannelId(context.channelId, this.buzz.relayUrl);
    if (this.channelAllowlist.size > 0 && !this.channelAllowlist.has(channelId)) {
      throw new Error(`Buzz outbound channel ${channelId} is not allowlisted`);
    }
    if (context.replyToMessageId) {
      throw new Error('Buzz generic outbound replies require an authenticated author target');
    }
    throw new Error('Buzz top-level outbound is not supported by the Stream mention tracer');
  }

  private async alertOperator(kind: string, title: string, error: unknown): Promise<void> {
    const message = toError(error).message;
    this.log.error(title, { error: message });
    if (!this.operatorAlertHandler) return;
    try {
      await this.operatorAlertHandler({
        title,
        message,
        idempotencyKey: `buzz:${kind}:${this.buzz.companionId}`,
      });
    } catch (alertError) {
      this.log.error('Buzz operator alert delivery failed', { error: toError(alertError).message });
    }
  }
}
