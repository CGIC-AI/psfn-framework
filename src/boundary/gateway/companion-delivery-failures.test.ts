import { describe, expect, it } from 'vitest';
import {
  COMPANION_ROOM_STALE_REPLY_GRACE_MS,
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

  it('mints a one-shot, short-lived reply authorization for the exact recipient and room', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-reply-source',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
      roomPresence: {
        since: new Date(100).toISOString(),
        updatedAt: new Date(1_000).toISOString(),
      },
    });

    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:elsewhere',
      'companion-reply-source',
      1_001,
    )).toBeNull();
    expect(receipts.claimRoomReply(
      'comp-c',
      'companion-room:living_room',
      'companion-reply-source',
      1_001,
    )).toBeNull();
    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:living_room',
      'companion-reply-source',
      1_000 + 15 * 60_000,
    )).toBeNull();
    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:living_room',
      'companion-reply-source',
      1_000 + 15 * 60_000 + 1,
    )).toMatchObject({ senderCompanionId: 'comp-a' });
    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:living_room',
      'companion-reply-source',
      1_000 + 15 * 60_000 + 2,
    )).toBeNull();
  });

  it('expires room reply authorization after the narrow post-staleness grace', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-old-reply-source',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
      roomPresence: {
        since: new Date(100).toISOString(),
        updatedAt: new Date(1_000).toISOString(),
      },
    });

    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:living_room',
      'companion-old-reply-source',
      1_000 + 15 * 60_000 + COMPANION_ROOM_STALE_REPLY_GRACE_MS + 1,
    )).toBeNull();
  });

  it('never authorizes a room reply from a delivery without an accepted presence row', () => {
    const receipts = new CompanionDeliveryFailureReceipts();
    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-no-presence-proof',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
    });

    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:living_room',
      'companion-no-presence-proof',
      1_000 + 15 * 60_000 + 1,
    )).toBeNull();

    receipts.record({
      channelId: 'companion-room:living_room',
      messageId: 'companion-impossible-presence-proof',
      senderCompanionId: 'comp-a',
      recipientCompanionId: 'comp-b',
      deliveredAt: 1_000,
      roomPresence: {
        since: new Date(1_001).toISOString(),
        updatedAt: new Date(1_000).toISOString(),
      },
    });
    expect(receipts.claimRoomReply(
      'comp-b',
      'companion-room:living_room',
      'companion-impossible-presence-proof',
      1_000 + 15 * 60_000 + 1,
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
