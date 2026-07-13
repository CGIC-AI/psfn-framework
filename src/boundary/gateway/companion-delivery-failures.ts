import { isRecord } from '../../shared/utils/types.js';
import { DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS } from '../../core/agent/companion-presence-store-port.js';
import type { CompanionDeliveryFailureReason } from './protocol.js';

const DELIVERY_RECEIPT_TTL_MS = 60 * 60_000;
const FAILURE_REASONS = new Set<CompanionDeliveryFailureReason>([
  'processing_failed',
  'reply_delivery_failed',
]);

export interface CompanionDeliveryReceipt {
  channelId: string;
  messageId: string;
  senderCompanionId: string;
  recipientCompanionId: string;
  deliveredAt: number;
}

export interface CompanionMessageFailureReport {
  channelId: string;
  messageId: string;
  reason: CompanionDeliveryFailureReason;
}

function receiptKey(recipientCompanionId: string, messageId: string): string {
  return `${recipientCompanionId}\u0000${messageId}`;
}

export class CompanionDeliveryFailureReceipts {
  private readonly receipts = new Map<string, CompanionDeliveryReceipt>();
  private readonly claimedRoomReplies = new Set<string>();

  record(receipt: CompanionDeliveryReceipt): void {
    this.prune(receipt.deliveredAt);
    const key = receiptKey(receipt.recipientCompanionId, receipt.messageId);
    this.claimedRoomReplies.delete(key);
    this.receipts.set(key, receipt);
  }

  findVerified(
    reportingCompanionId: string,
    report: CompanionMessageFailureReport,
    now = Date.now(),
  ): CompanionDeliveryReceipt | null {
    this.prune(now);
    const receipt = this.receipts.get(receiptKey(reportingCompanionId, report.messageId));
    return receipt?.channelId === report.channelId ? receipt : null;
  }

  /**
   * Claim the one reply capability created by a gateway delivery. The tuple
   * is gateway-authored and recipient-bound, the capability expires at the
   * room-presence staleness boundary, and claiming is atomic/single-use.
   * Failure-report verification remains available after a reply claim.
   */
  claimRoomReply(
    replyingCompanionId: string,
    channelId: string,
    replyToMessageId: string,
    now = Date.now(),
  ): CompanionDeliveryReceipt | null {
    this.prune(now);
    const key = receiptKey(replyingCompanionId, replyToMessageId);
    if (this.claimedRoomReplies.has(key)) return null;
    const receipt = this.receipts.get(key);
    if (
      !receipt
      || receipt.channelId !== channelId
      || receipt.deliveredAt > now
      || receipt.deliveredAt < now - DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS
    ) {
      return null;
    }
    this.claimedRoomReplies.add(key);
    return receipt;
  }

  consume(recipientCompanionId: string, messageId: string): void {
    const key = receiptKey(recipientCompanionId, messageId);
    this.receipts.delete(key);
    this.claimedRoomReplies.delete(key);
  }

  clear(): void {
    this.receipts.clear();
    this.claimedRoomReplies.clear();
  }

  private prune(now: number): void {
    const oldestAllowed = now - DELIVERY_RECEIPT_TTL_MS;
    for (const [key, receipt] of this.receipts.entries()) {
      if (receipt.deliveredAt < oldestAllowed) {
        this.receipts.delete(key);
        this.claimedRoomReplies.delete(key);
      }
    }
  }
}

export function parseCompanionMessageFailureReport(params: unknown): CompanionMessageFailureReport {
  if (!isRecord(params)) {
    throw new Error('companion.message.report_failure requires an object params payload');
  }
  const channelId = typeof params.channelId === 'string' ? params.channelId.trim() : '';
  const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (!channelId || !messageId) {
    throw new Error('companion.message.report_failure requires non-empty channelId and messageId');
  }
  if (!FAILURE_REASONS.has(reason as CompanionDeliveryFailureReason)) {
    throw new Error('companion.message.report_failure reason is not supported');
  }
  return { channelId, messageId, reason: reason as CompanionDeliveryFailureReason };
}
