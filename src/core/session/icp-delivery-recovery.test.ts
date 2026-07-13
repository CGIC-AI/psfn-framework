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
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';

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
  fatigueDecision: 'not_evaluated' as const,
} satisfies IcpConversationCorrelation;
const chargedCorrelation = { ...correlation, fatigueDecision: 'allow' as const };
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
  overchargeBlockedReasons: [
    'normal_allowance_not_exhausted',
    'no_qualifying_overcharge_trigger',
  ],
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
    icpCorrelation: chargedCorrelation,
  },
};
const fatigueRecordedEvent = {
  timestampMs: FATIGUE_TIMESTAMP_MS,
  amount: 1,
  decision: 'charged',
  reason: 'machine_intelligence_response',
  spentAfter: 1,
  remainingAllowance: 7,
  normalSpentAfter: 1,
  overchargeSpentAfter: 0,
  overchargeAllowance: 2,
  remainingOvercharge: 2,
  softState: 'clear',
  hardState: 'available',
};

function recoveryWithFatigue(overrides: Record<string, unknown> = {}) {
  return {
    ...recoveryResponse,
    metadata: {
      ...recoveryResponse.metadata,
      icpCorrelation: chargedCorrelation,
      fatigue: fatigueMetadata,
      fatiguePendingSpend,
      ...overrides,
    },
  };
}

function suppressedRecovery(overrides: Record<string, unknown> = {}) {
  return {
    ...recoveryResponse,
    content: '',
    metadata: {
      ...recoveryResponse.metadata,
      icpCorrelation: { ...correlation, fatigueDecision: 'suppress' },
      fatigue: {
        ...fatigueMetadata,
        decision: 'suppressed_hard_exhausted',
        modelDisposition: 'suppressed',
        shouldRecordSpend: false,
        policyState: 'hard_exhausted',
        policyBaseState: 'hard_exhausted',
        overchargeBlockedReasons: ['no_qualifying_overcharge_trigger'],
        budget: {
          ...fatigueBudget,
          spentBefore: 8,
          remainingBefore: 0,
          spentAfterProjected: 9,
          remainingAfterProjected: 0,
          normalSpentBefore: 8,
          normalSpentAfterProjected: 9,
        },
      },
    },
    ...overrides,
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

  it('accepts one recorded fatigue event bound to its executable pending spend', () => {
    const durable = recoveryWithFatigue({
      fatigue: { ...fatigueMetadata, recordedEvent: fatigueRecordedEvent },
    });

    expect(parseIcpRecoveryResponse(durable, {
      label: 'test recovery response',
    })).toEqual(durable);
  });

  it.each([
    ['timestamp', { timestampMs: FATIGUE_TIMESTAMP_MS + 1 }],
    ['amount', { amount: 2 }],
    ['decision', { decision: 'overcharge' }],
    ['reason', { reason: 'overcharge_work_intent_wrapup' }],
    ['spentAfter', { spentAfter: 2 }],
    ['remainingAllowance', { remainingAllowance: 6 }],
    ['normalSpentAfter', { normalSpentAfter: 2 }],
    ['overchargeSpentAfter', { overchargeSpentAfter: 1 }],
    ['overchargeAllowance', { overchargeAllowance: 3 }],
    ['remainingOvercharge', { remainingOvercharge: 1 }],
    ['softState', { softState: 'soft_limit_reached' }],
    ['hardState', { hardState: 'exhausted' }],
  ])('rejects a recorded fatigue event with forged %s', (_label, eventOverrides) => {
    const malformed = recoveryWithFatigue({
      fatigue: {
        ...fatigueMetadata,
        recordedEvent: { ...fatigueRecordedEvent, ...eventOverrides },
      },
    });

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/recorded.*event.*(?:binding|derived state)/i);
  });

  it('rejects a recorded fatigue event without its executable pending spend', () => {
    const malformed = recoveryWithFatigue({
      fatigue: {
        ...fatigueMetadata,
        shouldRecordSpend: false,
        recordedEvent: fatigueRecordedEvent,
      },
      fatiguePendingSpend: undefined,
    });

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/recorded.*event.*binding/i);
  });

  it.each([
    ['allowed charged without pending spend', recoveryWithFatigue({
      fatigue: { ...fatigueMetadata, shouldRecordSpend: false },
      fatiguePendingSpend: undefined,
    })],
    ['allowed charged with suppressed model disposition', recoveryWithFatigue({
      fatigue: { ...fatigueMetadata, modelDisposition: 'suppressed' },
    })],
    ['allowed charged with a free spend decision', recoveryWithFatigue({
      fatigue: {
        ...fatigueMetadata,
        spendDecision: 'free',
        spendReason: 'peer_not_machine_intelligence',
        budget: { ...fatigueBudget, amount: 0 },
      },
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        decision: 'free',
        reason: 'peer_not_machine_intelligence',
        amount: 0,
      },
    })],
    ['wrap-up charged without pending spend', recoveryWithFatigue({
      fatigue: {
        ...fatigueMetadata,
        decision: 'wrap_up_charged',
        shouldRecordSpend: false,
      },
      fatiguePendingSpend: undefined,
    })],
    ['overcharge charged without pending spend', recoveryWithFatigue({
      icpCorrelation: { ...correlation, fatigueDecision: 'allow_overcharge' },
      fatigue: {
        ...fatigueMetadata,
        decision: 'overcharge_charged',
        shouldRecordSpend: false,
        spendDecision: 'overcharge',
        spendReason: 'overcharge_work_intent_wrapup',
      },
      fatiguePendingSpend: undefined,
    })],
    ['allowed free with pending spend', recoveryWithFatigue({
      fatigue: {
        ...fatigueMetadata,
        decision: 'allowed_free',
        shouldRecordSpend: true,
        spendDecision: 'free',
        spendReason: 'peer_not_machine_intelligence',
        budget: { ...fatigueBudget, amount: 0 },
      },
      fatiguePendingSpend: {
        ...fatiguePendingSpend,
        decision: 'free',
        reason: 'peer_not_machine_intelligence',
        amount: 0,
      },
    })],
    ['suppression with pending spend', {
      ...recoveryWithFatigue({
        icpCorrelation: { ...correlation, fatigueDecision: 'suppress' },
        fatigue: {
          ...fatigueMetadata,
          decision: 'suppressed_hard_exhausted',
          modelDisposition: 'suppressed',
          shouldRecordSpend: true,
        },
        fatiguePendingSpend: {
          ...fatiguePendingSpend,
          correlation: {
            ...fatiguePendingSpend.correlation,
            icpCorrelation: { ...correlation, fatigueDecision: 'suppress' },
          },
        },
      }),
      content: '',
    }],
  ])('rejects contradictory fatigue decision matrix: %s', (_label, malformed) => {
    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/fatigue.*(?:production invariant|binding)/i);
  });

  it.each([
    ['visible content', { content: 'forged deliverable text' }],
    ['an attachment', {
      attachments: [{
        url: 'https://example.invalid/forged.png',
        contentType: 'image/png',
        name: 'forged.png',
      }],
    }],
  ])('rejects a fatigue-suppressed recovery response with %s', (_label, overrides) => {
    expect(() => parseIcpRecoveryResponse(suppressedRecovery(overrides), {
      label: 'test suppressed recovery response',
    })).toThrow(/suppressed.*deliverable/i);
  });

  it.each([
    ['suppressed status with an allowed response', 'suppressed', recoveryWithFatigue()],
    ['prepared status with a suppressed response', 'prepared', suppressedRecovery()],
  ])('rejects %s', (_label, status, response) => {
    const observation = JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status,
      recoveryResponse: response,
    });

    expect(() => parseIcpDeliveryObservation(observation, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toThrow(/suppressed.*deliverable|status.*fatigue decision/i);
  });

  it.each([
    ['delivered without recovery evidence', {
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
    }],
    ['failed without recovery evidence', {
      status: 'failed',
      error: 'transport failed',
    }],
    ['delivered with whitespace-only transport content', {
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
      recoveryResponse: { ...recoveryResponse, content: ' \n\t ' },
    }],
    ['failed with whitespace-only transport content', {
      status: 'failed',
      error: 'transport failed',
      recoveryResponse: { ...recoveryResponse, content: ' \n\t ' },
    }],
  ])('rejects %s', (_label, fields) => {
    const observation = JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      ...fields,
    });

    expect(() => parseIcpDeliveryObservation(observation, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toThrow(/missing recovery response|transport content/i);
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
