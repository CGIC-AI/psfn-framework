import type { AgentResponse, Attachment } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export const DISCORD_TURN_FAILURE_NOTICE =
  '[System delivery error] The runtime could not complete that turn. Please retry your message.';
export const DISCORD_DELIVERY_FAILURE_NOTICE =
  '[System delivery error] The runtime could not deliver part of the response. Please retry your message.';

export type DiscordFailureStage = 'handle_message' | 'text_delivery' | 'media_delivery';

export interface DiscordDeliveryCheckpoint {
  response: AgentResponse;
  contentDelivered: boolean;
  nextAttachmentIndex: number;
  dedupeKeys: string[];
  failedAt: number;
}

export interface DiscordReplyDeliveryPort {
  sendText(channelId: string, content: string): Promise<void>;
  sendMedia(channelId: string, attachment: Attachment): Promise<void>;
  onTextDelivered(content: string): void;
}

export class DiscordReplyDeliveryError extends Error {
  constructor(
    readonly stage: Exclude<DiscordFailureStage, 'handle_message'>,
    cause: unknown,
  ) {
    super(toErrorMessage(cause), { cause });
    this.name = 'DiscordReplyDeliveryError';
  }
}

export function createDiscordDeliveryCheckpoint(
  response: AgentResponse,
  dedupeKeys: string[],
): DiscordDeliveryCheckpoint {
  return {
    response,
    contentDelivered: false,
    nextAttachmentIndex: 0,
    dedupeKeys,
    failedAt: 0,
  };
}

export async function deliverDiscordReply(
  channelId: string,
  checkpoint: DiscordDeliveryCheckpoint,
  port: DiscordReplyDeliveryPort,
): Promise<void> {
  const { response } = checkpoint;
  if (response.content.trim() && !checkpoint.contentDelivered) {
    try {
      await port.sendText(channelId, response.content);
    } catch (error) {
      throw new DiscordReplyDeliveryError('text_delivery', error);
    }
    checkpoint.contentDelivered = true;
    port.onTextDelivered(response.content);
  }

  const attachments = response.attachments ?? [];
  while (checkpoint.nextAttachmentIndex < attachments.length) {
    const attachment = attachments[checkpoint.nextAttachmentIndex];
    try {
      await port.sendMedia(channelId, attachment);
    } catch (error) {
      throw new DiscordReplyDeliveryError('media_delivery', error);
    }
    checkpoint.nextAttachmentIndex += 1;
  }
}

export class DiscordFailedDeliveryCache {
  private readonly entries = new Map<string, DiscordDeliveryCheckpoint>();

  find(dedupeKey: string): DiscordDeliveryCheckpoint | undefined {
    return this.entries.get(dedupeKey);
  }

  recordFailure(checkpoint: DiscordDeliveryCheckpoint, failedAt: number): void {
    checkpoint.failedAt = failedAt;
    for (const key of checkpoint.dedupeKeys) {
      this.entries.set(key, checkpoint);
    }
  }

  delete(dedupeKey: string): void {
    this.entries.delete(dedupeKey);
  }

  prune(minTimestamp: number): void {
    for (const [key, checkpoint] of this.entries.entries()) {
      if (checkpoint.failedAt < minTimestamp) {
        this.entries.delete(key);
      }
    }
  }
}
