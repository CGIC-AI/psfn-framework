import { describe, expect, it } from 'vitest';

import {
  assertIcpConversationStatusTransition,
  assertIcpConversationActivityTransition,
  deriveChildIcpConversationCostCorrelation,
  parseIcpAvailabilityLease,
  parseIcpConversationCorrelation,
  parseIcpConversationEpisode,
  parseIcpInitiationPermit,
  redactIcpInitiationPermit,
} from './icp-autonomy.js';

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMPANION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const ROOT_INITIATION_ID = '33333333-3333-4333-8333-333333333333';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const PROVENANCE_HANDLE = 'icp-prov:55555555-5555-4555-8555-555555555555';

describe('ICP autonomy shared contracts', () => {
  it('strictly parses a bounded current availability lease', () => {
    const lease = parseIcpAvailabilityLease({
      companionId: COMPANION_A,
      state: 'open_to_chat',
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
      source: 'companion',
      revision: 1,
    }, { nowMs: 2_000, requireCurrent: true });

    expect(lease.state).toBe('open_to_chat');
    expect(() => parseIcpAvailabilityLease({ ...lease, privateThought: 'nope' }))
      .toThrow('unknown keys');
    expect(() => parseIcpAvailabilityLease({ ...lease, expiresAtMs: lease.issuedAtMs }))
      .toThrow('expiresAtMs must be later');
    expect(() => parseIcpAvailabilityLease(lease, { nowMs: 61_000, requireCurrent: true }))
      .toThrow('expired');
  });

  it('binds a DM episode to its canonical sorted participants and known fleet', () => {
    const episode = parseIcpConversationEpisode({
      conversationId: CONVERSATION_ID,
      channelId: `companion-dm:${COMPANION_A}:${COMPANION_B}`,
      participantCompanionIds: [COMPANION_A, COMPANION_B],
      rootInitiationId: ROOT_INITIATION_ID,
      initiatedByCompanionId: COMPANION_A,
      initiationSource: 'free_time',
      provenanceRef: PROVENANCE_HANDLE,
      openedAtMs: 10_000,
      lastActivityAtMs: 10_000,
      status: 'invited',
      revision: 1,
    }, { knownCompanionIds: new Set([COMPANION_A, COMPANION_B]) });

    expect(episode.channelId).toContain('companion-dm:');
    expect(() => parseIcpConversationEpisode({
      ...episode,
      participantCompanionIds: [COMPANION_B, COMPANION_A],
    })).toThrow('canonical sorted order');
    expect(() => parseIcpConversationEpisode({
      ...episode,
      participantCompanionIds: [COMPANION_A, COMPANION_C],
    })).toThrow('must exactly match the DM channel participants');
    expect(() => parseIcpConversationEpisode(episode, {
      knownCompanionIds: new Set([COMPANION_A]),
    })).toThrow(`unknown participant ${COMPANION_B}`);
    expect(() => parseIcpConversationEpisode({ ...episode, lastActivityAtMs: 9_999 }))
      .toThrow('lastActivityAtMs must not precede openedAtMs');
    expect(() => parseIcpConversationEpisode({
      ...episode,
      provenanceRef: 'icp-prov:private reason text',
    })).toThrow(/opaque provenance handle/i);
  });

  it('rejects invalid episode lifecycle transitions', () => {
    expect(() => assertIcpConversationStatusTransition('invited', 'active')).not.toThrow();
    expect(() => assertIcpConversationStatusTransition('active', 'ended')).not.toThrow();
    expect(() => assertIcpConversationStatusTransition('ended', 'active'))
      .toThrow('Invalid ICP conversation status transition');
    expect(() => assertIcpConversationActivityTransition(11_000, 10_999))
      .toThrow('lastActivityAtMs must not regress');
  });

  it('strictly binds and redacts a one-use permit', () => {
    const permit = parseIcpInitiationPermit({
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: COMPANION_A,
      recipientCompanionId: COMPANION_B,
      channelId: `companion-dm:${COMPANION_A}:${COMPANION_B}`,
      provenanceRef: PROVENANCE_HANDLE,
      issuedAtMs: 10_000,
      expiresAtMs: 70_000,
      status: 'issued',
      revision: 1,
    }, { nowMs: 11_000, requireUsable: true });

    expect(redactIcpInitiationPermit(permit)).toEqual({
      ...permit,
      permitId: '[redacted]',
    });
    expect(() => parseIcpInitiationPermit({
      ...permit,
      recipientCompanionId: COMPANION_C,
    })).toThrow('must bind exactly to the DM channel participants');
    expect(() => parseIcpInitiationPermit({
      ...permit,
      status: 'consumed',
    })).toThrow('consumedAtMs');
    expect(() => parseIcpInitiationPermit({
      ...permit,
      status: 'consumed',
      consumedAtMs: 9_999,
    })).toThrow('consumedAtMs must not predate issuedAtMs');
    expect(() => parseIcpInitiationPermit({
      ...permit,
      status: 'revoked',
      revokedAtMs: 9_999,
      reasonCode: 'operator_cancelled',
    })).toThrow('revokedAtMs must not predate issuedAtMs');
    expect(() => parseIcpInitiationPermit(permit, { nowMs: 70_000, requireUsable: true }))
      .toThrow('expired');
  });

  it('round-trips complete typed conversation correlation and rejects generic bags', () => {
    const correlation = {
      conversationId: CONVERSATION_ID,
      rootInitiationId: ROOT_INITIATION_ID,
      initiatedByCompanionId: COMPANION_A,
      localCompanionId: COMPANION_A,
      peerCompanionId: COMPANION_B,
      peerContactId: 'contact-artemis',
      channelId: `companion-dm:${COMPANION_A}:${COMPANION_B}`,
      turnId: 'turn-1',
      messageId: 'message-1',
      requestId: 'request-1',
      chargeLane: 'interactive',
      surface: 'companion_dm',
      costPurpose: 'conversation_turn',
      costOriginStage: 'initiation',
      fatigueDecision: 'not_evaluated',
    } as const;

    expect(parseIcpConversationCorrelation(JSON.parse(JSON.stringify(correlation))))
      .toEqual(correlation);
    expect(() => parseIcpConversationCorrelation({ ...correlation, metadata: {} }))
      .toThrow('unknown keys');
    expect(() => parseIcpConversationCorrelation({
      ...correlation,
      channelId: `companion-dm:${COMPANION_A}:${COMPANION_C}`,
    })).toThrow('must bind exactly to the DM channel participants');
    expect(() => parseIcpConversationCorrelation({
      ...correlation,
      initiatedByCompanionId: COMPANION_C,
    })).toThrow('initiatedByCompanionId must be the local or peer companion');
  });

  it('derives a child cost correlation without changing trusted conversation scope', () => {
    const parent = parseIcpConversationCorrelation({
      conversationId: CONVERSATION_ID,
      rootInitiationId: ROOT_INITIATION_ID,
      initiatedByCompanionId: COMPANION_A,
      localCompanionId: COMPANION_A,
      peerCompanionId: COMPANION_B,
      peerContactId: 'contact-artemis',
      channelId: `companion-dm:${COMPANION_A}:${COMPANION_B}`,
      turnId: 'turn-1',
      messageId: 'message-1',
      requestId: 'request-parent',
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'conversation_turn',
      costOriginStage: 'reply',
      fatigueDecision: 'allow',
    });

    expect(deriveChildIcpConversationCostCorrelation(parent, {
      requestId: 'request-parent:summary',
      costPurpose: 'summary',
      costOriginStage: 'post_turn',
    })).toEqual({
      ...parent,
      requestId: 'request-parent:summary',
      costPurpose: 'summary',
      costOriginStage: 'post_turn',
    });
    expect(() => deriveChildIcpConversationCostCorrelation(parent, {
      requestId: ' ',
      costPurpose: 'tool',
      costOriginStage: 'reply',
    })).toThrow('requestId must be a non-empty trimmed string');
  });
});
