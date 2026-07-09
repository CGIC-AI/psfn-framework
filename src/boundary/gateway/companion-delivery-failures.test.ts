import { describe, expect, it } from 'vitest';
import {
  CompanionDeliveryFailureReceipts,
  parseCompanionMessageFailureReport,
} from './companion-delivery-failures.js';

describe('CompanionDeliveryFailureReceipts', () => {
  it('verifies reports against the recipient, message, and channel tuple', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-dm:comp-a:comp-b',
      messageId: 'companion-1',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
    });
    const report = {
      channelId: 'companion-dm:comp-a:comp-b',
      messageId: 'companion-1',
      reason: 'processing_failed' as const,
    };

    expect(receipts.findVerified('comp-b', report, 1_001)).toMatchObject({
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
    });
    expect(receipts.findVerified('comp-c', report, 1_001)).toBeNull();
    expect(receipts.findVerified('comp-b', { ...report, channelId: 'companion-room:elsewhere' }, 1_001))
      .toBeNull();

    receipts.consume('comp-b', 'companion-1');
    expect(receipts.findVerified('comp-b', report, 1_001)).toBeNull();
  });

  it('expires delivery receipts after the bounded reporting window', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-old',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
    });

    expect(receipts.findVerified('comp-b', {
      channelId: 'companion-room:living_room',
      messageId: 'companion-old',
      reason: 'processing_failed',
    }, 1_000 + 60 * 60_000 + 1)).toBeNull();
  });
});

describe('parseCompanionMessageFailureReport', () => {
  it('accepts the closed reason vocabulary and rejects malformed reports', () => {
    expect(parseCompanionMessageFailureReport({
      channelId: 'companion-room:living_room',
      messageId: 'companion-1',
      reason: 'reply_delivery_failed',
    })).toEqual({
      channelId: 'companion-room:living_room',
      messageId: 'companion-1',
      reason: 'reply_delivery_failed',
    });
    expect(() => parseCompanionMessageFailureReport({
      channelId: 'companion-room:living_room',
      messageId: 'companion-1',
      reason: 'arbitrary_failure',
    })).toThrow(/reason is not supported/);
    expect(() => parseCompanionMessageFailureReport({
      channelId: '',
      messageId: 'companion-1',
      reason: 'processing_failed',
    })).toThrow(/non-empty channelId and messageId/);
  });
});
