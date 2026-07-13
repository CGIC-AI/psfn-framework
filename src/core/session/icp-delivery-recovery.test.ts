import { describe, expect, it } from 'vitest';
import {
  parseIcpDeliveryObservation,
  parseIcpRecoveryResponse,
  serializeIcpDeliveryObservation,
} from './icp-delivery-recovery.js';
import {
  buildInternalStateSnapshotRef,
  InternalStateComputer,
} from '../self-model/state.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;
const SOURCE = 'companion-initiation-33333333-3333-4333-8333-333333333333';
const FATIGUE_TIMESTAMP_MS = Date.parse('2026-03-02T00:00:00.000Z');
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

const fatigueScope = {
  localCompanionId: LOCAL,
  peerContactId: correlation.peerContactId,
  channelId: CHANNEL,
  dayKey: '2026-03-02',
};
const fatiguePeer = {
  contactId: correlation.peerContactId,
  channelAuthorId: PEER,
  isMachineIntelligence: true,
};
const fatigueActor = {
  role: 'machine_intelligence',
  contactId: correlation.peerContactId,
  channelAuthorId: PEER,
  isMachineIntelligence: true,
};
const fatigueBudget = {
  spentBefore: 0,
  remainingBefore: 8,
  allowance: 8,
  softLimit: 6,
  hardLimit: 8,
  amount: 1,
  spentAfterProjected: 1,
  remainingAfterProjected: 7,
  normalSpentBefore: 0,
  normalSpentAfterProjected: 1,
  overchargeSpentBefore: 0,
  overchargeSpentAfterProjected: 0,
  overchargeAllowance: 2,
  overchargeRemainingBefore: 2,
  overchargeRemainingAfterProjected: 2,
};
const fatigueMetadata = {
  schemaVersion: 1,
  decision: 'allowed_charged',
  modelDisposition: 'allowed',
  alertInjected: false,
  shouldRecordSpend: true,
  spendDecision: 'charged',
  spendReason: 'machine_intelligence_response',
  policyState: 'normal',
  policyBaseState: 'normal',
  intent: 'social',
  relationshipClass: 'known_mi',
  channelSetting: 'dm',
  overchargeEligible: false,
  overchargePermitted: false,
  overchargeBlockedReasons: [],
  overchargeReasons: [],
  scope: fatigueScope,
  peer: fatiguePeer,
  triggeringAuthor: fatigueActor,
  budget: fatigueBudget,
};
const fatiguePendingSpend = {
  schemaVersion: 1,
  timestampMs: FATIGUE_TIMESTAMP_MS,
  decision: 'charged',
  reason: 'machine_intelligence_response',
  amount: 1,
  scope: fatigueScope,
  peer: fatiguePeer,
  triggeringAuthor: fatigueActor,
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
};

function recoveryWithFatigue(overrides: Record<string, unknown> = {}) {
  return {
    ...recoveryResponse,
    metadata: {
      ...recoveryResponse.metadata,
      fatigue: fatigueMetadata,
      fatiguePendingSpend,
      ...overrides,
    },
  };
}

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
      ...recoveryWithFatigue(),
      content: '',
      metadata: {
        ...recoveryWithFatigue().metadata,
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
      },
    };

    expect(parseIcpRecoveryResponse(extended, {
      label: 'test recovery response',
      expectedChannelId: CHANNEL,
      expectedSourceMessageId: SOURCE,
    })).toEqual(extended);
  });

  it.each([
    ['outer fatigue decision', {
      icpCorrelation: { ...correlation, fatigueDecision: 'allow_overcharge' },
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        correlation: {
          ...fatiguePendingSpend.correlation,
          icpCorrelation: { ...correlation, fatigueDecision: 'allow_overcharge' },
        },
      },
    }],
    ['fatigue scope', {
      fatigue: {
        ...fatigueMetadata,
        scope: { ...fatigueScope, channelId: 'companion-room:wrong-channel' },
      },
    }],
    ['pending outer scope', {
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        scope: { ...fatigueScope, channelId: 'companion-room:wrong-channel' },
        correlation: {
          ...fatiguePendingSpend.correlation,
          channelId: 'companion-room:wrong-channel',
        },
      },
    }],
    ['turn lineage', {
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        correlation: {
          ...fatiguePendingSpend.correlation,
          turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7099',
        },
      },
    }],
    ['amount', {
      fatiguePendingSpend: { ...fatiguePendingSpend, amount: 2 },
    }],
    ['peer actor', {
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        triggeringAuthor: { ...fatigueActor, contactId: 'wrong-contact' },
      },
    }],
    ['limits', {
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        limits: { ...fatiguePendingSpend.limits, hardLimit: 9 },
      },
    }],
  ])('rejects recovery fatigue metadata with mismatched %s binding', (_label, overrides) => {
    const malformed = recoveryWithFatigue(overrides);

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/fatigue.*binding/i);
  });

  it('requires internal state and snapshot reference as a verified pair', () => {
    const state = new InternalStateComputer().computeState({
      activeConcerns: [],
      trustLevel: 'regular',
      sessionMetrics: {
        userMessageText: 'hello',
        responseText: 'hi',
        toolCallCount: 0,
        recentTurnCount: 1,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(state);
    const valid = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        internalState: state,
        internalStateSnapshotRef: snapshotRef,
      },
    };

    expect(parseIcpRecoveryResponse(valid, { label: 'test recovery response' })).toEqual(valid);
    expect(() => parseIcpRecoveryResponse({
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        internalStateSnapshotRef: snapshotRef,
      },
    }, { label: 'test recovery response' })).toThrow(/internal state.*pair/i);
    expect(() => parseIcpRecoveryResponse({
      ...valid,
      metadata: {
        ...valid.metadata,
        internalStateSnapshotRef: 'internal-state-v1:not-the-state',
      },
    }, { label: 'test recovery response' })).toThrow(/snapshot reference.*match/i);
  });
});
