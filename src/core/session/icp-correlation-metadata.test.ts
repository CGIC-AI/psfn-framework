import { describe, expect, it } from 'vitest';
import {
  buildSessionMetadataWithIcpCorrelation,
  parseSessionIcpCorrelation,
  parseSessionIcpRecoveryResponse,
} from './icp-correlation-metadata.js';

const correlation = {
  conversationId: '44444444-4444-4444-8444-444444444444',
  rootInitiationId: '99999999-9999-4999-8999-999999999999',
  initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  peerContactId: 'contact-nova',
  channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
  messageId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
  requestId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
  chargeLane: 'companion_social' as const,
  surface: 'companion_dm' as const,
  costPurpose: 'conversation_turn' as const,
  costOriginStage: 'initiation' as const,
  fatigueDecision: 'not_evaluated' as const,
};

const recoveryResponse = {
  content: 'A durable companion reply',
  channelId: correlation.channelId,
  metadata: {
    model: 'deterministic-test-model',
    inputTokens: 12,
    outputTokens: 7,
    durationMs: 5,
    turnId: correlation.turnId,
    requestId: correlation.requestId,
    icpCorrelation: correlation,
  },
};

describe('ICP session correlation metadata', () => {
  it('round-trips strict lineage alongside turn metadata and sender pending-delivery truth', () => {
    const metadata = buildSessionMetadataWithIcpCorrelation(
      '{"turn":{"schemaVersion":1}}',
      correlation,
      { deliveryStatus: 'pending' },
    );

    expect(parseSessionIcpCorrelation(metadata)).toEqual(correlation);
    expect(JSON.parse(metadata)).toMatchObject({
      turn: { schemaVersion: 1 },
      icpDelivery: { schemaVersion: 1, status: 'pending' },
    });
  });

  it('fails closed on malformed stored correlation instead of dropping lineage', () => {
    expect(() => parseSessionIcpCorrelation('{"icpCorrelation":{"conversationId":"bad"}}'))
      .toThrow(/unknown fields|must be/i);
  });

  it('round-trips the complete response needed to resume ordinary post-turn work', () => {
    const metadata = buildSessionMetadataWithIcpCorrelation(undefined, correlation, {
      deliveryStatus: 'pending',
      recoveryResponse,
    });

    expect(parseSessionIcpRecoveryResponse(metadata)).toEqual(recoveryResponse);
  });

  it('fails closed when durable recovery response lineage diverges from the assistant row', () => {
    const mismatched = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        requestId: 'icp-initiation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    };
    const metadata = buildSessionMetadataWithIcpCorrelation(undefined, correlation, {
      deliveryStatus: 'pending',
      recoveryResponse: mismatched,
    });

    expect(() => parseSessionIcpRecoveryResponse(metadata)).toThrow(/does not match/i);
  });
});
