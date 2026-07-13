import { describe, expect, it } from 'vitest';
import {
  buildSessionMetadataWithIcpCorrelation,
  parseSessionIcpCorrelation,
} from './icp-correlation-metadata.js';

const correlation = {
  conversationId: '44444444-4444-4444-8444-444444444444',
  rootInitiationId: '99999999-9999-4999-8999-999999999999',
  initiatedByCompanionId: '11111111-1111-4111-8111-111111111111',
  localCompanionId: '11111111-1111-4111-8111-111111111111',
  peerCompanionId: '22222222-2222-4222-8222-222222222222',
  peerContactId: 'contact-nova',
  channelId: 'companion-dm:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
  messageId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
  requestId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
  chargeLane: 'companion_social' as const,
  surface: 'companion_dm' as const,
  costPurpose: 'conversation_turn' as const,
  costOriginStage: 'initiation' as const,
  fatigueDecision: 'not_evaluated' as const,
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
});
