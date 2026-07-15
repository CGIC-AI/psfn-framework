import { describe, expect, it } from 'vitest';

import type { CorrelationMetadata } from '../../../../shared/contracts/runtime.js';
import { parsePendingSpend } from '../../../session/icp-recovery-fatigue-metadata.js';
import { projectFatiguePendingSpendCorrelation } from './icp-fatigue-regulation.js';

describe('ICP fatigue recovery correlation', () => {
  it('projects live turn attribution into the strict durable replay schema', () => {
    const icpCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'message-1',
      requestId: 'request-1',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'reply' as const,
      fatigueDecision: 'allow' as const,
    };
    const liveCorrelation: CorrelationMetadata = {
      sessionId: 'session-private',
      companionId: icpCorrelation.localCompanionId,
      turnId: icpCorrelation.turnId,
      requestId: icpCorrelation.requestId,
      channelId: icpCorrelation.channelId,
      channelType: 'companion',
      callType: 'chat',
      purpose: 'agent.fatigue.record',
      originType: 'chat',
      originStage: 'agent.fatigue.record',
      chargeLane: 'companion_social',
      service: 'agent',
      process: 'substrate-agent',
      conversationId: icpCorrelation.conversationId,
      rootInitiationId: icpCorrelation.rootInitiationId,
      icpCorrelation,
    };
    const correlation = projectFatiguePendingSpendCorrelation(liveCorrelation);

    expect(correlation).not.toHaveProperty('sessionId');
    expect(correlation).not.toHaveProperty('chargeLane');
    expect(correlation).not.toHaveProperty('conversationId');
    expect(() => parsePendingSpend({
      schemaVersion: 1,
      timestampMs: Date.parse('2026-07-14T12:00:00.000Z'),
      decision: 'charged',
      reason: 'machine_intelligence_response',
      amount: 1,
      scope: {
        localCompanionId: icpCorrelation.localCompanionId,
        peerContactId: icpCorrelation.peerContactId,
        channelId: icpCorrelation.channelId,
        dayKey: '2026-07-14',
      },
      peer: {
        contactId: icpCorrelation.peerContactId,
        channelAuthorId: icpCorrelation.peerCompanionId,
        displayName: 'Peer',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: icpCorrelation.peerContactId,
        channelAuthorId: icpCorrelation.peerCompanionId,
        displayName: 'Peer',
        isMachineIntelligence: true,
      },
      limits: { softLimit: 2, hardLimit: 3, overchargeLimit: 1 },
      correlation,
    }, 'pending spend')).not.toThrow();
  });
});
