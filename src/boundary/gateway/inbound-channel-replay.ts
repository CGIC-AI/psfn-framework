import type { GatewayChannelSurface } from './multi-companion.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord } from '../../shared/utils/types.js';

const MAX_INBOUND_CHANNEL_REPLAY_MESSAGES_PER_COMPANION = 100;

export interface QueuedInboundChannelNotification {
  companionId: CompanionId;
  surface: GatewayChannelSurface;
  method: string;
  params: unknown;
  discordAccountId?: string;
  enqueuedAt: number;
}

export interface InboundChannelReplayDrop {
  notification: QueuedInboundChannelNotification;
  reason: 'capacity';
}

export interface GatewayInboundChannelReplayOptions {
  onDrop: (drop: InboundChannelReplayDrop) => void;
}

/**
 * Gateway-process deploy-window buffer. Queues are isolated by authenticated
 * companion route so one offline companion cannot consume a sibling's budget.
 */
export class GatewayInboundChannelReplay {
  private readonly onDrop: GatewayInboundChannelReplayOptions['onDrop'];
  private readonly queues = new Map<CompanionId, QueuedInboundChannelNotification[]>();

  constructor(options: GatewayInboundChannelReplayOptions) {
    this.onDrop = options.onDrop;
  }

  enqueue(notification: QueuedInboundChannelNotification): number {
    const queue = this.queues.get(notification.companionId) ?? [];
    if (queue.length >= MAX_INBOUND_CHANNEL_REPLAY_MESSAGES_PER_COMPANION) {
      const dropped = queue.shift();
      if (dropped) {
        this.onDrop({ notification: dropped, reason: 'capacity' });
      }
    }
    queue.push(notification);
    this.queues.set(notification.companionId, queue);
    return queue.length;
  }

  peek(companionId: CompanionId): QueuedInboundChannelNotification | undefined {
    return this.queues.get(companionId)?.[0];
  }

  removeHead(
    companionId: CompanionId,
    expected: QueuedInboundChannelNotification,
  ): void {
    const queue = this.queues.get(companionId);
    if (!queue || queue[0] !== expected) {
      throw new Error(`Inbound replay queue order changed for companion "${companionId}"`);
    }
    queue.shift();
    if (queue.length === 0) {
      this.queues.delete(companionId);
    }
  }

  size(companionId: CompanionId): number {
    return this.queues.get(companionId)?.length ?? 0;
  }
}

export function inboundChannelMessageId(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.message)) {
    return undefined;
  }
  const id = params.message.id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
