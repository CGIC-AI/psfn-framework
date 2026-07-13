import { describe, expect, it } from 'vitest';
import {
  parseIcpDeliveryObservation,
  parseIcpRecoveryResponse,
  serializeIcpDeliveryObservation,
} from './icp-delivery-recovery.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;
const SOURCE = 'companion-initiation-33333333-3333-4333-8333-333333333333';
const correlation = {
  conversationId: '44444444-4444-4444-8444-444444444444',
  rootInitiationId: '99999999-9999-4999-8999-999999999999',
  initiatedByCompanionId: PEER,
  localCompanionId: LOCAL,
  peerCompanionId: PEER,
  peerContactId: 'contact-peer',
  channelId: CHANNEL,
  turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
  messageId: SOURCE,
  requestId: SOURCE,
  chargeLane: 'companion_social' as const,
  surface: 'companion_dm' as const,
  costPurpose: 'conversation_turn' as const,
  costOriginStage: 'reply' as const,
  fatigueDecision: 'allow' as const,
};
const recoveryResponse = {
  content: 'Durable reply',
  channelId: CHANNEL,
  metadata: {
    model: 'strict-codec-test',
    inputTokens: 3,
    outputTokens: 2,
    durationMs: 5,
    turnId: correlation.turnId,
    requestId: correlation.requestId,
    icpCorrelation: correlation,
  },
};

describe('ICP delivery recovery codec', () => {
  it('round-trips the strict completed-delivery shape', () => {
    const content = serializeIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
      deliveredTo: [PEER],
      recoveryResponse,
      turnCompleted: true,
    });

    expect(parseIcpDeliveryObservation(content, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toEqual({
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
      deliveredTo: [PEER],
      recoveryResponse,
      turnCompleted: true,
    });
  });

  it('rejects unknown observation fields instead of casting through them', () => {
    const content = JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'failed',
      error: 'transport failed',
      legacyFallback: true,
    });

    expect(() => parseIcpDeliveryObservation(content, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toThrow(/unknown fields/i);
  });

  it('rejects recovery response lineage with a different stable turn', () => {
    const mismatched = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      },
    };

    expect(() => parseIcpRecoveryResponse(mismatched, {
      label: 'test recovery response',
      expectedChannelId: CHANNEL,
      expectedSourceMessageId: SOURCE,
    })).toThrow(/lineage/i);
  });

  it('rejects non-finite recovery usage accounting', () => {
    const malformed = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        outputTokens: Number.POSITIVE_INFINITY,
      },
    };

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/non-negative finite/i);
  });

  it.each([
    ['noReply', {}],
    ['internalState', {}],
    ['internalStateSnapshotRef', 42],
    ['metacognitiveFlags', {}],
    ['retrievalProvenanceRefs', {}],
    ['diagnostics', []],
    ['broadcastSafety', []],
    ['fatigue', {}],
    ['fatiguePendingSpend', {}],
  ])('rejects a malformed permitted metadata field %s', (field, malformedValue) => {
    const malformed = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        [field]: malformedValue,
      },
    };

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(new RegExp(`metadata\\.${field}`, 'i'));
  });

  it('round-trips validated no-reply and durable fatigue-spend metadata', () => {
    const extended = {
      ...recoveryResponse,
      content: '',
      metadata: {
        ...recoveryResponse.metadata,
        noReply: {
          schemaVersion: 1,
          disposition: 'intentional_no_reply',
          source: 'response_control_tool',
          auditId: 'no-reply-codec',
          decidedAt: 1_700_000_000_000,
          turnId: correlation.turnId,
          requestId: correlation.requestId,
          channelId: CHANNEL,
        },
        fatiguePendingSpend: {
          schemaVersion: 1,
          timestampMs: 1_700_000_000_000,
          decision: 'charged',
          reason: 'machine_intelligence_response',
          amount: 1,
          scope: {
            localCompanionId: LOCAL,
            peerContactId: 'contact-peer',
            channelId: CHANNEL,
            dayKey: '2026-03-02',
          },
          peer: {
            contactId: 'contact-peer',
            channelAuthorId: PEER,
            isMachineIntelligence: true,
          },
          triggeringAuthor: {
            role: 'machine_intelligence',
            contactId: 'contact-peer',
            channelAuthorId: PEER,
            isMachineIntelligence: true,
          },
          limits: {
            softLimit: 6,
            hardLimit: 8,
            overchargeLimit: 2,
          },
          correlation: {
            turnId: correlation.turnId,
            requestId: correlation.requestId,
            channelId: CHANNEL,
            callType: 'chat',
            purpose: 'agent.fatigue.record',
            originType: 'chat',
            originStage: 'agent.fatigue.record',
            icpCorrelation: correlation,
          },
        },
      },
    };

    expect(parseIcpRecoveryResponse(extended, {
      label: 'test recovery response',
      expectedChannelId: CHANNEL,
      expectedSourceMessageId: SOURCE,
    })).toEqual(extended);
  });
});
