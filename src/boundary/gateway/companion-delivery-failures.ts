import { isRecord } from '../../shared/utils/types.js';
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
  /** Room recipients only: stable presence epoch accepted at delivery time. */
  roomPresenceEpoch?: {
    since: string;
  };
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
  private readonly claimedReplies = new Set<string>();

  record(receipt: CompanionDeliveryReceipt): void {
    this.prune(receipt.deliveredAt);
    const key = receiptKey(receipt.recipientCompanionId, receipt.messageId);
    this.claimedReplies.delete(key);
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
   * Claim the one reply capability created by any gateway delivery. The tuple
   * is gateway-authored, recipient- and channel-bound, expires with the
   * delivery receipt, and is atomically single-use. Presence privilege, when
   * needed for a room, is separately decided by the channel lane.
   * Failure-report verification remains available after this claim.
   */
  claimReply(
    replyingCompanionId: string,
    channelId: string,
    replyToMessageId: string,
    now = Date.now(),
  ): CompanionDeliveryReceipt | null {
    this.prune(now);
    const key = receiptKey(replyingCompanionId, replyToMessageId);
    if (this.claimedReplies.has(key)) return null;
    const receipt = this.receipts.get(key);
    if (
      !receipt
      || receipt.channelId !== channelId
      || !Number.isFinite(now)
      || !Number.isFinite(receipt.deliveredAt)
      || receipt.deliveredAt > now
      || receipt.deliveredAt < now - DELIVERY_RECEIPT_TTL_MS
    ) {
      return null;
    }
    this.claimedReplies.add(key);
    return receipt;
  }

  consume(recipientCompanionId: string, messageId: string): void {
    const key = receiptKey(recipientCompanionId, messageId);
    this.receipts.delete(key);
    this.claimedReplies.delete(key);
  }

  clear(): void {
    this.receipts.clear();
    this.claimedReplies.clear();
  }

  private prune(now: number): void {
    const oldestAllowed = now - DELIVERY_RECEIPT_TTL_MS;
    for (const [key, receipt] of this.receipts.entries()) {
      if (receipt.deliveredAt < oldestAllowed) {
        this.receipts.delete(key);
        this.claimedReplies.delete(key);
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
