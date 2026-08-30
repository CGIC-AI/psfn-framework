import { describe, expect, it } from 'vitest';

import { createEndogenousRoomParticipationCandidate } from './endogenous-room-candidate.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

describe('createEndogenousRoomParticipationCandidate', () => {
  it('represents a durable companion disposition without fabricating participant speech', () => {
    const candidate = createEndogenousRoomParticipationCandidate({
      sourceEventId: 'felt-impulse:would_message:1780000000000',
      candidateId: 'binding-hash',
      channelId: 'discord:guild-1:room-1',
      channelType: 'discord',
      companionId: COMPANION_ID,
      roomIntent: 'Ask how the shared project is going.',
      occurredAtMs: 1_780_000_000_100,
    });

    expect(candidate).toEqual({
      schemaVersion: 1,
      kind: 'endogenous_room_candidate',
      source: 'social_impulse_disposition',
      sourceEventId: 'felt-impulse:would_message:1780000000000',
      candidateId: 'binding-hash',
      channelId: 'discord:guild-1:room-1',
      channelType: 'discord',
      companionId: COMPANION_ID,
      roomIntent: 'Ask how the shared project is going.',
      occurredAtMs: 1_780_000_000_100,
    });
    expect(candidate).not.toHaveProperty('authorId');
    expect(candidate).not.toHaveProperty('authorName');
    expect(candidate).not.toHaveProperty('content');
  });

  it('fails closed for an incomplete or unsupported candidate', () => {
    const valid = {
      sourceEventId: 'source',
      candidateId: 'candidate',
      channelId: 'room',
      channelType: 'discord' as const,
      companionId: COMPANION_ID,
      roomIntent: 'Join naturally.',
      occurredAtMs: 1,
    };
    expect(() => createEndogenousRoomParticipationCandidate({
      ...valid,
      roomIntent: ' ',
    })).toThrow('roomIntent is required');
    expect(() => createEndogenousRoomParticipationCandidate({
      ...valid,
      channelType: 'telegram',
    })).toThrow('supported room channelType');
  });
});
