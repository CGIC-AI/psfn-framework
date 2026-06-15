import { createComponentLogger } from '../../shared/logger.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';

const log = createComponentLogger('ProactiveOutbound');

export interface ProactiveOutboundDispatchInput {
  actionId: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  reason?: string;
}

export type ProactiveOutboundDispatchResult =
  | { outcome: 'sent' }
  | { outcome: 'blocked'; reason: string; retryAfterMs?: number };

export interface ProactiveOutboundDispatcherOptions {
  sender: MessageSender;
  rateLimiter: ExternalCommunicationRateLimiter;
  /**
   * Fail-closed target policy for the first slice: only explicitly approved
   * primary-contact private channels may receive proactive messages.
   */
  isApprovedPrimaryChannel: (channelId: string) => boolean | Promise<boolean>;
  eventBus?: EventBus | null;
}

/**
 * Policy-gated companion-authored outbound dispatch (proactive outreach,
 * sprint-9 1xb.1 / rsgg.6). Internal whisper follow-ups stay internal; this
 * path exists only for follow-up decisions that explicitly chose external
 * delivery, and it fails closed on anything that is not a private Discord
 * channel approved for the primary contact.
 */
export class ProactiveOutboundDispatcher {
  private readonly sender: MessageSender;
  private readonly rateLimiter: ExternalCommunicationRateLimiter;
  private readonly isApprovedPrimaryChannel: ProactiveOutboundDispatcherOptions['isApprovedPrimaryChannel'];
  private readonly eventBus: EventBus | null;

  constructor(options: ProactiveOutboundDispatcherOptions) {
    this.sender = options.sender;
    this.rateLimiter = options.rateLimiter;
    this.isApprovedPrimaryChannel = options.isApprovedPrimaryChannel;
    this.eventBus = options.eventBus ?? null;
  }

  async dispatch(input: ProactiveOutboundDispatchInput): Promise<ProactiveOutboundDispatchResult> {
    const content = input.content.trim();
    const blocked = async (
      reason: string,
      retryAfterMs?: number,
    ): Promise<ProactiveOutboundDispatchResult> => {
      log.warn('Proactive outbound message blocked', {
        actionId: input.actionId,
        channelId: input.channelId,
        channelType: input.channelType,
        reason,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
      await this.emit('intention.outbound.blocked', input, reason);
      return {
        outcome: 'blocked',
        reason,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    };

    if (!content) {
      return blocked('empty_content');
    }
    if (input.channelType !== 'discord') {
      return blocked('unsupported_channel_type');
    }
    // The approved-channel allowlist is the privacy gate in this slice: the
    // operator approves exactly the primary contact's private DM. Visibility
    // classification needs adapter channel meta and arrives with the durable
    // outbox (1xb.2); do not widen targets before then.
    if (!(await this.isApprovedPrimaryChannel(input.channelId))) {
      return blocked('channel_not_approved_for_primary');
    }
    const rateDecision = this.rateLimiter.evaluate({
      channel: 'discord',
      scope: 'proactive-outbound',
    });
    if (!rateDecision.allowed) {
      return blocked('rate_limited', rateDecision.retryAfterMs);
    }

    await this.sender.send(input.channelId, content);
    log.info('Proactive outbound message sent', {
      actionId: input.actionId,
      channelId: input.channelId,
      contentLength: content.length,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await this.emit('intention.outbound.dispatched', input, undefined, content.length);
    return { outcome: 'sent' };
  }

  private async emit(
    eventName: 'intention.outbound.dispatched' | 'intention.outbound.blocked',
    input: ProactiveOutboundDispatchInput,
    blockReason?: string,
    contentLength?: number,
  ): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.emit(eventName, {
        actionId: input.actionId,
        channelId: input.channelId,
        channelType: input.channelType,
        ...(blockReason ? { reason: blockReason } : {}),
        ...(contentLength !== undefined ? { contentLength } : {}),
        timestamp: Date.now(),
      });
    } catch (error) {
      log.warn('Proactive outbound telemetry emit failed', {
        eventName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
