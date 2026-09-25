import { toErrorMessage } from '../../shared/utils/errors.js';
import type { CompanionDeliveryFailureReason } from '../../boundary/gateway/protocol.js';
import {
  DISCORD_DELIVERY_FAILURE_NOTICE,
  DISCORD_TURN_FAILURE_NOTICE,
  DiscordReplyDeliveryError,
  type DiscordDeliveryCheckpoint,
  type DiscordFailedDeliveryCache,
  type DiscordFailureStage,
} from './discord-reply-delivery.js';
import { CompanionReplyDeliveryError } from './companion-reply-delivery-recovery.js';

/**
 * Typed delivery-pump outcome handling (bead hrlg).
 *
 * The Discord and companion inbound pumps in gateway-message-handlers.ts each
 * carried their terminal failure handling — failure classification, audit,
 * user notice / peer failure receipt — and their success-only dedupe transition
 * inside large nested closures alongside queue scheduling. That made it easy for
 * a future retry change to reintroduce silent loss or duplicate delivery. These
 * focused helpers own the outcome transitions so the pumps only wire them up;
 * behavior (failure stages/reasons, notice/receipt copy, audit event names, and
 * success-only dedupe) is preserved exactly. Queue scheduling and handler
 * registration stay in the pump.
 */

export interface PumpAuditPort {
  append(event: string, details: Record<string, unknown>): void;
}

export interface PumpLogPort {
  error(message: string, details: Record<string, unknown>): void;
}

export interface DiscordFailureOutcomePorts {
  discordSend(channelId: string, content: string): Promise<void>;
  audit: PumpAuditPort;
  log: PumpLogPort;
}

/**
 * Terminal Discord turn/delivery failure: classify the stage, park the
 * checkpoint for retry, audit, and deliver the appropriate system notice
 * (auditing whether the notice itself was delivered).
 */
export async function handleDiscordTurnFailure(params: {
  error: unknown;
  channelId: string;
  messageId: string;
  checkpoint: DiscordDeliveryCheckpoint | undefined;
  failedDeliveries: DiscordFailedDeliveryCache;
  ports: DiscordFailureOutcomePorts;
}): Promise<void> {
  const { error, channelId, messageId, checkpoint, failedDeliveries, ports } = params;
  const failureStage: DiscordFailureStage = error instanceof DiscordReplyDeliveryError
    ? error.stage
    : 'handle_message';
  const errorText = toErrorMessage(error);
  ports.log.error('Error handling message', { channelId, messageId, error: errorText, stage: failureStage });
  ports.audit.append('discord.message.error', { channelId, messageId, error: errorText, stage: failureStage });
  if (checkpoint) {
    failedDeliveries.recordFailure(checkpoint, Date.now());
  }
  const failureNotice = failureStage === 'handle_message'
    ? DISCORD_TURN_FAILURE_NOTICE
    : DISCORD_DELIVERY_FAILURE_NOTICE;
  try {
    await ports.discordSend(channelId, failureNotice);
    ports.audit.append('discord.message.failure_notice', {
      channelId, messageId, stage: failureStage, delivered: true,
    });
  } catch (noticeError) {
    const noticeErrorText = toErrorMessage(noticeError);
    ports.log.error('Failed to deliver system-derived discord failure notice', {
      channelId, messageId, error: noticeErrorText,
    });
    ports.audit.append('discord.message.failure_notice', {
      channelId, messageId, stage: failureStage, delivered: false, error: noticeErrorText,
    });
  }
}

/** Success-only Discord dedupe/checkpoint finalization for a bundle's keys. */
export function finalizeDiscordDelivery(params: {
  dedupeKeys: readonly string[];
  completed: boolean;
  inFlight: Set<string>;
  failedDeliveries: DiscordFailedDeliveryCache;
  recent: Map<string, number>;
  finishedAt: number;
}): void {
  const { dedupeKeys, completed, inFlight, failedDeliveries, recent, finishedAt } = params;
  for (const key of dedupeKeys) {
    inFlight.delete(key);
    if (completed) {
      failedDeliveries.delete(key);
      recent.set(key, finishedAt);
    }
  }
}

export interface CompanionFailureOutcomePorts {
  companionReportFailure(params: {
    channelId: string;
    messageId: string;
    reason: CompanionDeliveryFailureReason;
  }): Promise<unknown>;
  audit: PumpAuditPort;
  log: PumpLogPort;
}

/**
 * Terminal companion turn/delivery failure: refine the failure reason, audit,
 * and send the peer failure receipt (no conversational error text on this
 * lane), auditing whether the receipt itself was reported. `failureReason` is
 * the reason accumulated by the pump before the throw; a reply-delivery error
 * refines it to `reply_delivery_failed`.
 */
export async function handleCompanionTurnFailure(params: {
  error: unknown;
  channelId: string;
  messageId: string;
  failureReason: CompanionDeliveryFailureReason;
  ports: CompanionFailureOutcomePorts;
}): Promise<void> {
  const { error, channelId, messageId, ports } = params;
  const reason: CompanionDeliveryFailureReason = error instanceof CompanionReplyDeliveryError
    ? 'reply_delivery_failed'
    : params.failureReason;
  const errorText = toErrorMessage(error);
  ports.log.error('Error handling companion message', { channelId, messageId, error: errorText });
  ports.audit.append('companion.message.error', { channelId, messageId, error: errorText, reason });
  try {
    await ports.companionReportFailure({ channelId, messageId, reason });
    ports.audit.append('companion.message.failure_reported', { channelId, messageId, reason });
  } catch (reportError) {
    const reportErrorText = toErrorMessage(reportError);
    ports.log.error('Failed to report companion message delivery failure', {
      channelId, messageId, error: reportErrorText,
    });
    ports.audit.append('companion.message.failure_report_error', {
      channelId, messageId, reason, error: reportErrorText,
    });
  }
}

/** Success-only companion dedupe finalization for one message's key. */
export function finalizeCompanionDelivery(params: {
  dedupeKey: string | null;
  completed: boolean;
  inFlight: Set<string>;
  recent: Map<string, number>;
  finishedAt: number;
}): void {
  const { dedupeKey, completed, inFlight, recent, finishedAt } = params;
  if (!dedupeKey) return;
  inFlight.delete(dedupeKey);
  if (completed) {
    recent.set(dedupeKey, finishedAt);
  }
}
