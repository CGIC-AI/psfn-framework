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
import type {
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
  TurnID,
} from '../../shared/contracts/runtime.js';

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

interface FatigueRecoveryTestResponse {
  content: string;
  channelId: string;
  metadata: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    turnId: string;
    requestId: string;
    icpCorrelation: IcpConversationCorrelation;
    fatigue: FatigueEnforcementMetadata;
    fatiguePendingSpend?: FatiguePendingSpendMetadata;
  };
}

interface FatigueDecisionFixture {
  label: string;
  response: FatigueRecoveryTestResponse;
}

function buildPendingSpend(
  fatigue: FatigueEnforcementMetadata,
  icpCorrelation: IcpConversationCorrelation,
): FatiguePendingSpendMetadata {
  return {
    schemaVersion: 1,
    timestampMs: FATIGUE_TIMESTAMP_MS,
    decision: fatigue.spendDecision,
    reason: fatigue.spendReason,
    amount: fatigue.budget.amount,
    scope: { ...fatigue.scope },
    peer: { ...fatigue.peer },
    triggeringAuthor: { ...fatigue.triggeringAuthor },
    limits: {
      softLimit: fatigue.budget.softLimit,
      hardLimit: fatigue.budget.hardLimit,
      overchargeLimit: fatigue.budget.overchargeAllowance,
    },
    correlation: {
      turnId: icpCorrelation.turnId as TurnID,
      requestId: icpCorrelation.requestId,
      channelId: icpCorrelation.channelId,
      callType: 'chat',
      purpose: 'agent.fatigue.record',
      originType: 'chat',
      originStage: 'agent.fatigue.record',
      icpCorrelation,
    },
  };
}

function buildFatigueDecisionFixture(input: {
  label: string;
  fatigueDecision: IcpConversationCorrelation['fatigueDecision'];
  fatigue: FatigueEnforcementMetadata;
  pendingSpend: boolean;
  content?: string;
}): FatigueDecisionFixture {
  const icpCorrelation: IcpConversationCorrelation = {
    ...correlation,
    fatigueDecision: input.fatigueDecision,
  };
  return {
    label: input.label,
    response: {
      ...recoveryResponse,
      content: input.content ?? 'Durable reply',
      metadata: {
        ...recoveryResponse.metadata,
        icpCorrelation,
        fatigue: structuredClone(input.fatigue),
        ...(input.pendingSpend
          ? { fatiguePendingSpend: buildPendingSpend(input.fatigue, icpCorrelation) }
          : {}),
      },
    },
  };
}

const freeBudget = {
  ...fatigueBudget,
  amount: 0,
  spentAfterProjected: 0,
  remainingAfterProjected: 8,
  normalSpentAfterProjected: 0,
};
const wrapBudget = {
  ...fatigueBudget,
  spentBefore: 6,
  remainingBefore: 2,
  spentAfterProjected: 7,
  remainingAfterProjected: 1,
  normalSpentBefore: 6,
  normalSpentAfterProjected: 7,
};
const overchargeBudget = {
  ...fatigueBudget,
  spentBefore: 8,
  remainingBefore: 0,
  spentAfterProjected: 9,
  remainingAfterProjected: 0,
  normalSpentBefore: 8,
  normalSpentAfterProjected: 8,
  overchargeSpentAfterProjected: 1,
  overchargeRemainingAfterProjected: 1,
};
const suppressedBudget = {
  ...fatigueBudget,
  spentBefore: 10,
  remainingBefore: 0,
  spentAfterProjected: 11,
  remainingAfterProjected: 0,
  normalSpentBefore: 8,
  normalSpentAfterProjected: 9,
  overchargeSpentBefore: 2,
  overchargeSpentAfterProjected: 2,
  overchargeRemainingBefore: 0,
  overchargeRemainingAfterProjected: 0,
};

const fatigueDecisionFixtures: FatigueDecisionFixture[] = [
  buildFatigueDecisionFixture({
    label: 'allowed_free for a non-MI peer',
    fatigueDecision: 'allow',
    pendingSpend: false,
    fatigue: {
      ...fatigueMetadata,
      decision: 'allowed_free',
      shouldRecordSpend: false,
      spendDecision: 'free',
      spendReason: 'peer_not_machine_intelligence',
      relationshipClass: 'non_machine_intelligence',
      overchargeBlockedReasons: [
        'peer_not_machine_intelligence',
        'turn_does_not_spend_fatigue',
        'normal_allowance_not_exhausted',
        'no_qualifying_overcharge_trigger',
      ],
      peer: {
        contactId: correlation.peerContactId,
        channelAuthorId: PEER,
      },
      triggeringAuthor: {
        role: 'human',
        contactId: correlation.peerContactId,
        channelAuthorId: PEER,
      },
      budget: freeBudget,
    },
  }),
  buildFatigueDecisionFixture({
    label: 'allowed_free for a non-MI triggering author',
    fatigueDecision: 'allow',
    pendingSpend: false,
    fatigue: {
      ...fatigueMetadata,
      decision: 'allowed_free',
      shouldRecordSpend: false,
      spendDecision: 'free',
      spendReason: 'triggering_author_not_machine_intelligence',
      overchargeBlockedReasons: [
        'turn_does_not_spend_fatigue',
        'normal_allowance_not_exhausted',
        'no_qualifying_overcharge_trigger',
      ],
      triggeringAuthor: {
        role: 'human',
        contactId: correlation.peerContactId,
        channelAuthorId: PEER,
      },
      budget: freeBudget,
    },
  }),
  buildFatigueDecisionFixture({
    label: 'allowed_charged',
    fatigueDecision: 'allow',
    pendingSpend: true,
    fatigue: {
      ...fatigueMetadata,
      overchargeBlockedReasons: [
        'normal_allowance_not_exhausted',
        'no_qualifying_overcharge_trigger',
      ],
    },
  }),
  buildFatigueDecisionFixture({
    label: 'wrap_up_charged',
    fatigueDecision: 'allow',
    pendingSpend: true,
    fatigue: {
      ...fatigueMetadata,
      decision: 'wrap_up_charged',
      alertInjected: true,
      policyState: 'soft_exhausted',
      policyBaseState: 'soft_exhausted',
      overchargeBlockedReasons: [
        'normal_allowance_not_exhausted',
        'no_qualifying_overcharge_trigger',
      ],
      budget: wrapBudget,
    },
  }),
  buildFatigueDecisionFixture({
    label: 'overcharge_charged',
    fatigueDecision: 'allow_overcharge',
    pendingSpend: true,
    fatigue: {
      ...fatigueMetadata,
      decision: 'overcharge_charged',
      alertInjected: true,
      spendDecision: 'overcharge',
      spendReason: 'overcharge_work_intent_wrapup',
      policyState: 'overcharge_eligible',
      policyBaseState: 'hard_exhausted',
      intent: 'work',
      overchargeEligible: true,
      overchargePermitted: true,
      overchargeBlockedReasons: [],
      overchargeReasons: ['work_intent_wrapup'],
      budget: overchargeBudget,
    },
  }),
  buildFatigueDecisionFixture({
    label: 'suppressed_hard_exhausted',
    fatigueDecision: 'suppress',
    pendingSpend: false,
    content: '',
    fatigue: {
      ...fatigueMetadata,
      decision: 'suppressed_hard_exhausted',
      modelDisposition: 'suppressed',
      shouldRecordSpend: false,
      policyState: 'overcharge_eligible',
      policyBaseState: 'hard_exhausted',
      intent: 'work',
      overchargeEligible: true,
      overchargeBlockedReasons: ['overcharge_reserve_exhausted'],
      overchargeReasons: ['work_intent_wrapup'],
      budget: suppressedBudget,
    },
  }),
];

interface FatigueMutation {
  label: string;
  mutate(fatigue: FatigueEnforcementMetadata): void;
}

const fatigueMutations: FatigueMutation[] = [
  {
    label: 'decision',
    mutate: fatigue => {
      fatigue.decision = fatigue.decision === 'allowed_free'
        ? 'allowed_charged'
        : 'allowed_free';
    },
  },
  {
    label: 'modelDisposition',
    mutate: fatigue => {
      fatigue.modelDisposition = fatigue.modelDisposition === 'allowed' ? 'suppressed' : 'allowed';
    },
  },
  {
    label: 'alertInjected',
    mutate: fatigue => { fatigue.alertInjected = !fatigue.alertInjected; },
  },
  {
    label: 'shouldRecordSpend',
    mutate: fatigue => { fatigue.shouldRecordSpend = !fatigue.shouldRecordSpend; },
  },
  {
    label: 'spendDecision',
    mutate: fatigue => {
      fatigue.spendDecision = fatigue.spendDecision === 'free' ? 'charged' : 'free';
    },
  },
  {
    label: 'spendReason',
    mutate: fatigue => {
      fatigue.spendReason = fatigue.spendReason === 'machine_intelligence_response'
        ? 'peer_not_machine_intelligence'
        : 'machine_intelligence_response';
    },
  },
  {
    label: 'peer MI classification',
    mutate: fatigue => {
      fatigue.peer.isMachineIntelligence = fatigue.peer.isMachineIntelligence !== true;
    },
  },
  {
    label: 'actor role classification',
    mutate: fatigue => {
      fatigue.triggeringAuthor.role = fatigue.triggeringAuthor.role === 'machine_intelligence'
        ? 'human'
        : 'machine_intelligence';
    },
  },
  {
    label: 'actor MI classification',
    mutate: fatigue => {
      fatigue.triggeringAuthor.isMachineIntelligence =
        fatigue.triggeringAuthor.isMachineIntelligence !== true;
    },
  },
  {
    label: 'peer/actor channel identity',
    mutate: fatigue => { fatigue.triggeringAuthor.channelAuthorId = 'forged-author'; },
  },
  {
    label: 'relationshipClass',
    mutate: fatigue => {
      fatigue.relationshipClass = fatigue.relationshipClass === 'non_machine_intelligence'
        ? 'known_mi'
        : 'non_machine_intelligence';
    },
  },
  {
    label: 'policyState',
    mutate: fatigue => {
      fatigue.policyState = fatigue.policyState === 'overcharge_eligible'
        ? 'hard_exhausted'
        : 'overcharge_eligible';
    },
  },
  {
    label: 'intent/overcharge qualification',
    mutate: fatigue => {
      fatigue.intent = fatigue.intent === 'work' ? 'social' : 'work';
    },
  },
  {
    label: 'overchargeEligible',
    mutate: fatigue => { fatigue.overchargeEligible = !fatigue.overchargeEligible; },
  },
  {
    label: 'overchargePermitted',
    mutate: fatigue => { fatigue.overchargePermitted = !fatigue.overchargePermitted; },
  },
  {
    label: 'overchargeReasons',
    mutate: fatigue => {
      fatigue.overchargeReasons = fatigue.overchargeEligible ? [] : ['work_intent_wrapup'];
    },
  },
  {
    label: 'overchargeBlockedReasons',
    mutate: fatigue => {
      fatigue.overchargeBlockedReasons = fatigue.overchargeEligible
        ? fatigue.overchargePermitted
          ? ['overcharge_reserve_exhausted']
          : []
        : ['forged_reason'];
    },
  },
  {
    label: 'policyBaseState',
    mutate: fatigue => {
      const mutatedState = fatigue.decision === 'allowed_charged'
        ? 'soft_exhausted'
        : fatigue.decision === 'wrap_up_charged'
          ? 'normal'
          : fatigue.decision === 'allowed_free'
            ? 'hard_exhausted'
            : 'normal';
      fatigue.policyBaseState = mutatedState;
      fatigue.policyState = fatigue.overchargeEligible ? 'overcharge_eligible' : mutatedState;
    },
  },
  {
    label: 'scope peer identity',
    mutate: fatigue => { fatigue.scope.peerContactId = 'forged-contact'; },
  },
  {
    label: 'actor contact identity',
    mutate: fatigue => { fatigue.triggeringAuthor.contactId = 'forged-contact'; },
  },
  {
    label: 'peer/actor display identity',
    mutate: fatigue => { fatigue.triggeringAuthor.displayName = 'Forged Actor'; },
  },
  {
    label: 'scope day key',
    mutate: fatigue => { fatigue.scope.dayKey = 'not-a-day'; },
  },
  {
    label: 'peer-not-MI block coupling',
    mutate: fatigue => {
      const reason = 'peer_not_machine_intelligence';
      fatigue.overchargeBlockedReasons = fatigue.overchargeBlockedReasons.includes(reason)
        ? fatigue.overchargeBlockedReasons.filter(value => value !== reason)
        : [reason, ...fatigue.overchargeBlockedReasons];
    },
  },
  {
    label: 'non-spending-turn block coupling',
    mutate: fatigue => {
      const reason = 'turn_does_not_spend_fatigue';
      const withoutReason = fatigue.overchargeBlockedReasons.filter(value => value !== reason);
      fatigue.overchargeBlockedReasons = fatigue.overchargeBlockedReasons.includes(reason)
        ? withoutReason
        : [
            ...withoutReason.slice(0, withoutReason.includes('peer_not_machine_intelligence') ? 2 : 1),
            reason,
            ...withoutReason.slice(withoutReason.includes('peer_not_machine_intelligence') ? 2 : 1),
          ];
    },
  },
  {
    label: 'normal-allowance block coupling',
    mutate: fatigue => {
      const reason = 'normal_allowance_not_exhausted';
      const withoutReason = fatigue.overchargeBlockedReasons.filter(value => value !== reason);
      fatigue.overchargeBlockedReasons = fatigue.overchargeBlockedReasons.includes(reason)
        ? withoutReason
        : [...withoutReason, reason];
    },
  },
  {
    label: 'budget amount',
    mutate: fatigue => { fatigue.budget.amount = fatigue.budget.amount === 0 ? 1 : 2; },
  },
  {
    label: 'budget spentBefore',
    mutate: fatigue => { fatigue.budget.spentBefore += 1; },
  },
  {
    label: 'budget remainingBefore',
    mutate: fatigue => { fatigue.budget.remainingBefore += 1; },
  },
  {
    label: 'budget allowance/hardLimit',
    mutate: fatigue => { fatigue.budget.allowance += 1; },
  },
  {
    label: 'budget normalSpentBefore',
    mutate: fatigue => { fatigue.budget.normalSpentBefore += 1; },
  },
  {
    label: 'budget overchargeSpentBefore',
    mutate: fatigue => { fatigue.budget.overchargeSpentBefore += 1; },
  },
  {
    label: 'budget overchargeRemainingBefore',
    mutate: fatigue => { fatigue.budget.overchargeRemainingBefore += 1; },
  },
  {
    label: 'budget spentAfterProjected',
    mutate: fatigue => { fatigue.budget.spentAfterProjected += 1; },
  },
  {
    label: 'budget remainingAfterProjected',
    mutate: fatigue => { fatigue.budget.remainingAfterProjected += 1; },
  },
  {
    label: 'budget normalSpentAfterProjected',
    mutate: fatigue => { fatigue.budget.normalSpentAfterProjected += 1; },
  },
  {
    label: 'budget overchargeSpentAfterProjected',
    mutate: fatigue => { fatigue.budget.overchargeSpentAfterProjected += 1; },
  },
  {
    label: 'budget overchargeAllowance',
    mutate: fatigue => { fatigue.budget.overchargeAllowance += 1; },
  },
  {
    label: 'budget overchargeRemainingAfterProjected',
    mutate: fatigue => { fatigue.budget.overchargeRemainingAfterProjected += 1; },
  },
];

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

  it('rejects an evaluated fatigue correlation without enforcement metadata', () => {
    expect(() => parseIcpRecoveryResponse({
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        icpCorrelation: chargedCorrelation,
      },
    }, {
      label: 'test recovery response',
    })).toThrow(/fatigue.*not_evaluated/i);
  });

  it.each(fatigueDecisionFixtures)(
    'accepts the complete production fatigue invariant for $label',
    ({ response }) => {
      expect(parseIcpRecoveryResponse(response, {
        label: 'test recovery response',
      })).toEqual(response);
    },
  );

  it.each(fatigueDecisionFixtures.flatMap(fixture => (
    fatigueMutations.map(mutation => ({ fixture, mutation }))
  )))(
    'rejects $fixture.label with mutated $mutation.label',
    ({ fixture, mutation }) => {
      const malformed = structuredClone(fixture.response);
      mutation.mutate(malformed.metadata.fatigue);

      expect(() => parseIcpRecoveryResponse(malformed, {
        label: 'test recovery response',
      })).toThrow(/fatigue.*(?:production invariant|binding)/i);
    },
  );

  it.each(fatigueDecisionFixtures)(
    'rejects $label with contradictory correlation fatigue decision',
    ({ response }) => {
      const malformed = structuredClone(response);
      malformed.metadata.icpCorrelation.fatigueDecision = 'not_evaluated';

      expect(() => parseIcpRecoveryResponse(malformed, {
        label: 'test recovery response',
      })).toThrow(/fatigue.*binding/i);
    },
  );

  it.each(fatigueDecisionFixtures)(
    'rejects $label with contradictory pending-spend ownership',
    ({ response }) => {
      const malformed = structuredClone(response);
      if (malformed.metadata.fatiguePendingSpend) {
        delete malformed.metadata.fatiguePendingSpend;
      } else {
        malformed.metadata.fatiguePendingSpend = buildPendingSpend(
          malformed.metadata.fatigue,
          malformed.metadata.icpCorrelation,
        );
      }

      expect(() => parseIcpRecoveryResponse(malformed, {
        label: 'test recovery response',
      })).toThrow(/fatigue.*binding/i);
    },
  );

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
  ])('rejects a recorded fatigue event with forged %s', (_label, eventOverrides) => {
    const malformed = recoveryWithFatigue({
      fatigue: {
        ...fatigueMetadata,
        recordedEvent: { ...fatigueRecordedEvent, ...eventOverrides },
      },
    });

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/recorded.*event.*binding/i);
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
