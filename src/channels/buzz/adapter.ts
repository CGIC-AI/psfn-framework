import type { Event as NostrEvent } from 'nostr-tools';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toError } from '../../shared/utils/errors.js';
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
import { toBuzzSubstrateMessage } from './message.js';
import { normalizeBuzzRelayUrl } from './origin.js';
import {
  BUZZ_STREAM_TEXT_CHUNK_LIMIT,
  buzzTagValues,
  parseBuzzChannelId,
  parseBuzzPrivateKey,
} from './protocol.js';

export interface BuzzAdapterConfig {
  enabled: boolean;
  relayUrl: string;
  companionId: string;
  privateKey: string;
  channelIds: readonly string[];
  allowedAuthorPubkeys: readonly string[];
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
  private readonly client: BuzzRelayClient;
  private handler: MessageHandler | null = null;
  private operatorAlertHandler: BuzzOperatorAlertHandler | null = null;

  constructor(config: BuzzAdapterConfig, options: BuzzAdapterOptions) {
    const relayUrl = normalizeBuzzRelayUrl(config.relayUrl, 'Buzz adapter relayUrl');
    this.buzz = {
      enabled: config.enabled,
      relayUrl,
      companionId: config.companionId,
      channelIds: [...config.channelIds],
      allowedAuthorPubkeys: [...config.allowedAuthorPubkeys],
    };
    this.intakeScreening = options.intakeScreening ?? null;
    this.log = options.log ?? createComponentLogger('BuzzAdapter');
    this.channelAllowlist = new Set(config.channelIds);
    this.client = new BuzzRelayClient({
      relayUrl,
      companionId: config.companionId,
      privateKey: parseBuzzPrivateKey(config.privateKey),
      channelIds: config.channelIds,
      allowedAuthorPubkeys: config.allowedAuthorPubkeys,
      operationTimeoutMs: options.shutdownTimeoutMs,
    }, {
      onEvent: async event => this.handleInboundEvent(event),
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
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  private async handleInboundEvent(event: NostrEvent): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error('Buzz adapter lost its inbound message handler');
    const message = await toBuzzSubstrateMessage(event, {
      relayUrl: this.buzz.relayUrl,
      companionId: this.buzz.companionId,
      companionPubkey: this.client.companionPubkey,
      intakeScreening: this.intakeScreening,
    });
    const response = await handler(message);
    await this.client.publishStreamEvent({
      channelId: buzzTagValues(event, 'h')[0]!,
      content: response.content,
      tags: [
        ['e', event.id, '', 'reply'],
        ['p', event.pubkey],
      ],
    });
  }

  private async sendOutboundText(context: OutboundContext, _content: string): Promise<void> {
    const channelId = parseBuzzChannelId(context.channelId, this.buzz.relayUrl);
    if (!this.channelAllowlist.has(channelId)) {
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
