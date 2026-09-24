// Routed inbound channel delivery: single-companion broadcast, multi-companion
// exact-owner delivery, the per-companion replay queue that holds messages
// until the owning agent is ready, and the audited operator alert when the
// replay queue drops a message.
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type { GatewayChannelSurface } from '../multi-companion.js';
import {
  GatewayInboundChannelReplay,
  inboundChannelMessageId,
  type InboundChannelReplayDrop,
} from '../inbound-channel-replay.js';
import type { GatewayServerPorts } from './ports.js';

const log = createComponentLogger('Gateway');

export class GatewayInboundChannelDelivery {
  private readonly inboundChannelReplay: GatewayInboundChannelReplay;

  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'multiCompanion'
      | 'notifyAll'
      | 'notifyOne'
      | 'audit'
      | 'auditComplete'
      | 'operatorAlertDispatcher'
      | 'resolveReadyCompanionConnection'
      | 'resolveRoutedCompanionId'
      | 'refreshConnectionHealth'
      | 'recordCompanionViolation'
    >,
  ) {
    this.inboundChannelReplay = new GatewayInboundChannelReplay({
      onDrop: drop => this.alertInboundChannelDrop(drop),
    });
  }

  /**
   * Deliver an inbound channel message to its owning agent.
   * Single-companion mode keeps today's broadcast semantics byte-identical;
   * multi-companion mode resolves exactly one companion via the channels.json
   * routing table and fails closed on any ambiguity.
   */
  notifyChannelMessage(
    surface: GatewayChannelSurface,
    method: string,
    params: unknown,
    discordAccountId?: string,
  ): number {
    if (!this.ports.multiCompanion.enabled) {
      this.ports.refreshConnectionHealth();
      return this.ports.notifyAll(method, params);
    }
    const companionId = this.ports.resolveRoutedCompanionId(
      surface,
      discordAccountId ? { kind: 'discord', accountId: discordAccountId } : undefined,
    );
    this.ports.refreshConnectionHealth();
    this.flushInboundChannelReplay(companionId);

    if (this.inboundChannelReplay.size(companionId) === 0) {
      const conn = this.ports.resolveReadyCompanionConnection(companionId);
      if (conn && this.ports.notifyOne(conn, method, params)) {
        return 1;
      }
    }

    const queueDepth = this.inboundChannelReplay.enqueue({
      companionId,
      surface,
      method,
      params,
      ...(discordAccountId ? { discordAccountId } : {}),
      enqueuedAt: Date.now(),
    });
    const messageId = inboundChannelMessageId(params);
    log.warn('Inbound channel message queued until companion is ready', {
      companionId,
      surface,
      method,
      queueDepth,
      ...(messageId ? { messageId } : {}),
    });
    // The gateway accepted durable-in-process responsibility for this
    // notification. Returning positive keeps the adapter from treating a
    // safely queued deploy-window message as an immediate delivery failure.
    return 1;
  }

  flushInboundChannelReplay(companionId: CompanionId): void {
    const conn = this.ports.resolveReadyCompanionConnection(companionId);
    if (!conn) return;

    let replayed = 0;
    let notification = this.inboundChannelReplay.peek(companionId);
    while (notification) {
      if (!this.ports.notifyOne(conn, notification.method, notification.params)) {
        break;
      }
      this.inboundChannelReplay.removeHead(companionId, notification);
      replayed += 1;
      notification = this.inboundChannelReplay.peek(companionId);
    }
    if (replayed > 0) {
      log.info('Replayed queued inbound channel messages', {
        companionId,
        replayed,
        remaining: this.inboundChannelReplay.size(companionId),
      });
    }
  }

  alertInboundChannelDrop(drop: InboundChannelReplayDrop): void {
    const { notification, reason } = drop;
    const messageId = inboundChannelMessageId(notification.params);
    const details = {
      companionId: notification.companionId,
      surface: notification.surface,
      method: notification.method,
      reason,
      enqueuedAt: notification.enqueuedAt,
      ...(messageId ? { messageId } : {}),
    };
    log.error('Inbound channel replay queue dropped a message', details);
    this.ports.recordCompanionViolation('inbound_channel_message_dropped', details);
    const startedAt = Date.now();
    const auditDrop = async (): Promise<void> => {
      try {
        const auditId = await this.ports.audit(
          'gateway.companion.inbound_channel_message_dropped',
          'DENY',
          details,
        );
        await this.ports.auditComplete(
          auditId,
          startedAt,
          'Inbound channel message dropped before replay',
        );
      } catch (error) {
        log.error('Failed to persist inbound channel drop audit', {
          ...details,
          error: toErrorMessage(error),
        });
      }
    };
    const deliverAlert = async (): Promise<void> => {
      try {
        await this.ports.operatorAlertDispatcher.dispatch({
          title: 'Inbound companion message dropped',
          priority: 5,
          message: [
            `Gateway replay queue dropped an inbound ${notification.surface} message.`,
            `Companion: ${notification.companionId}`,
            `Reason: ${reason}`,
            ...(messageId ? [`Message ID: ${messageId}`] : []),
          ].join('\n'),
          sender: {
            kind: 'system',
            provenance: 'system.operator_alert.inbound_channel_drop',
          },
        });
      } catch (error) {
        log.error('Failed to deliver inbound channel drop alert', {
          ...details,
          error: toErrorMessage(error),
        });
      }
    };
    void Promise.all([auditDrop(), deliverAlert()]);
  }
}
