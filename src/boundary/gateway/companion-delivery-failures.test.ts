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

  it('claims a one-shot reply capability for the exact recipient and channel', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-reply-source',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
      roomPresenceEpoch: {
        since: new Date(100).toISOString(),
      },
    });

    expect(receipts.claimReply(
      'comp-b',
      'companion-room:elsewhere',
      'companion-reply-source',
      1_001,
    )).toBeNull();
    expect(receipts.claimReply(
      'comp-c',
      'companion-room:living_room',
      'companion-reply-source',
      1_001,
    )).toBeNull();
    expect(receipts.claimReply(
      'comp-b',
      'companion-room:living_room',
      'companion-reply-source',
      1_001,
    )).toMatchObject({
      senderCompanionId: 'comp-a',
      roomPresenceEpoch: { since: new Date(100).toISOString() },
    });
    expect(receipts.claimReply(
      'comp-b',
      'companion-room:living_room',
      'companion-reply-source',
      1_002,
    )).toBeNull();
  });

  it('claims DM reply lineage even though it carries no room presence epoch', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-dm:comp-a:comp-b',
      messageId: 'companion-dm-source',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
    });

    expect(receipts.claimReply(
      'comp-b',
      'companion-dm:comp-a:comp-b',
      'companion-dm-source',
      1_001,
    )).toMatchObject({ messageId: 'companion-dm-source' });
    expect(receipts.claimReply(
      'comp-b',
      'companion-dm:comp-a:comp-b',
      'companion-dm-source',
      1_002,
    )).toBeNull();
  });

  it('rejects expired receipts and receipts delivered in the future', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-old-source',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
    });

    expect(receipts.claimReply(
      'comp-b',
      'companion-room:living_room',
      'companion-old-source',
      1_000 + 60 * 60_000 + 1,
    )).toBeNull();

    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-future-source',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 2_000,
    });
    expect(receipts.claimReply(
      'comp-b',
      'companion-room:living_room',
      'companion-future-source',
      1_999,
    )).toBeNull();
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
