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

  record(receipt: CompanionDeliveryReceipt): void {
    this.prune(receipt.deliveredAt);
    this.receipts.set(receiptKey(receipt.recipientCompanionId, receipt.messageId), receipt);
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

  consume(recipientCompanionId: string, messageId: string): void {
    this.receipts.delete(receiptKey(recipientCompanionId, messageId));
  }

  clear(): void {
    this.receipts.clear();
  }

  private prune(now: number): void {
    const oldestAllowed = now - DELIVERY_RECEIPT_TTL_MS;
    for (const [key, receipt] of this.receipts.entries()) {
      if (receipt.deliveredAt < oldestAllowed) {
        this.receipts.delete(key);
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
