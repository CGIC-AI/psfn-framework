import { describe, expect, it } from 'vitest';
import { buildSessionMetadataWithIcpCorrelation } from '../../../core/session/icp-correlation-metadata.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { resolveIcpExtractionLineage } from './icp-lineage.js';

const LOCAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;
const DYAD = '11111111-1111-4111-8111-111111111111';

function correlation(activityId: string, turnId: string): IcpConversationCorrelation {
  return {
    dyadId: DYAD,
    conversationId: activityId,
    rootInitiationId: '22222222-2222-4222-8222-222222222222',
    initiatedByCompanionId: LOCAL,
    localCompanionId: LOCAL,
    peerCompanionId: PEER,
    peerContactId: 'contact-peer-fixture',
    channelId: CHANNEL,
    turnId,
    messageId: `message:${turnId}`,
    requestId: `request:${turnId}`,
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'reply',
    fatigueDecision: 'allow',
  };
}

function entry(
  id: number,
  role: SessionEntry['role'],
  activityId: string,
  turnId: string,
): SessionEntry {
  return {
    id,
    channelId: CHANNEL,
    role,
    content: `${role} continuity message ${id}`,
    timestamp: id * 1_000,
    metadata: buildSessionMetadataWithIcpCorrelation(undefined, correlation(activityId, turnId)),
  };
}

describe('ICP extraction lineage', () => {
  it('keeps one dyad while preserving every selected bounded activity and turn', () => {
    const activityOne = '33333333-3333-4333-8333-333333333333';
    const activityTwo = '44444444-4444-4444-8444-444444444444';
    const entries = [
      entry(1, 'user', activityOne, 'turn-one'),
      entry(2, 'assistant', activityOne, 'turn-two'),
      entry(3, 'system', activityTwo, 'control-retry'),
      entry(4, 'user', activityTwo, 'turn-three'),
    ];

    expect(resolveIcpExtractionLineage({
      channelId: CHANNEL,
      entries,
      sourceMessageIds: [2, 3, 4],
    })).toEqual({
      icpDyadId: DYAD,
      sourceActivityIds: [activityOne, activityTwo],
      sourceTurnIds: ['turn-three', 'turn-two'],
    });
  });

  it('fails closed when one extraction range claims two durable dyads', () => {
    const first = correlation('33333333-3333-4333-8333-333333333333', 'turn-one');
    const second = {
      ...correlation('44444444-4444-4444-8444-444444444444', 'turn-two'),
      dyadId: '55555555-5555-4555-8555-555555555555',
    };

    expect(() => resolveIcpExtractionLineage({
      channelId: CHANNEL,
      entries: [
        { ...entry(1, 'user', first.conversationId, first.turnId), metadata: buildSessionMetadataWithIcpCorrelation(undefined, first) },
        { ...entry(2, 'assistant', second.conversationId, second.turnId), metadata: buildSessionMetadataWithIcpCorrelation(undefined, second) },
      ],
    })).toThrow('crosses durable dyad identities');
  });
});
