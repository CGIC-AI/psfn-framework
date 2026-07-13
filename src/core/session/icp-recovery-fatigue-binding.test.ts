import { describe, expect, it } from 'vitest';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type {
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
  TurnID,
} from '../../shared/contracts/runtime.js';
import { parseIcpRecoveryResponse } from './icp-delivery-recovery.js';
import {
  FATIGUE_TIMESTAMP_MS,
  PEER,
  chargedCorrelation,
  correlation,
  fatigueBudget,
  fatigueMetadata,
  recoveryResponse,
} from './icp-recovery.test-fixtures.js';
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
    label: 'overcharge_charged for work intent',
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
    label: 'overcharge_charged for recent human participation',
    fatigueDecision: 'allow_overcharge',
    pendingSpend: true,
    fatigue: {
      ...fatigueMetadata,
      decision: 'overcharge_charged',
      alertInjected: true,
      spendDecision: 'overcharge',
      spendReason: 'overcharge_recent_human_participation',
      policyState: 'overcharge_eligible',
      policyBaseState: 'hard_exhausted',
      overchargeEligible: true,
      overchargePermitted: true,
      overchargeBlockedReasons: [],
      overchargeReasons: ['recent_human_participation'],
      budget: overchargeBudget,
    },
  }),
  buildFatigueDecisionFixture({
    label: 'overcharge_charged for dual qualifying reasons',
    fatigueDecision: 'allow_overcharge',
    pendingSpend: true,
    fatigue: {
      ...fatigueMetadata,
      decision: 'overcharge_charged',
      alertInjected: true,
      spendDecision: 'overcharge',
      spendReason: 'overcharge_recent_human_participation',
      policyState: 'overcharge_eligible',
      policyBaseState: 'hard_exhausted',
      intent: 'work',
      overchargeEligible: true,
      overchargePermitted: true,
      overchargeBlockedReasons: [],
      overchargeReasons: ['recent_human_participation', 'work_intent_wrapup'],
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

function requireFatigueDecisionFixture(label: string): FatigueDecisionFixture {
  const fixture = fatigueDecisionFixtures.find(candidate => candidate.label === label);
  if (!fixture) throw new Error(`missing fatigue decision fixture: ${label}`);
  return fixture;
}

const ROOM_CHANNEL = 'companion-room:recovery-room';

function asRoomRecoveryResponse(
  channelSetting: FatigueEnforcementMetadata['channelSetting'],
): FatigueRecoveryTestResponse {
  const response = structuredClone(
    requireFatigueDecisionFixture('allowed_charged').response,
  );
  const roomCorrelation: IcpConversationCorrelation = {
    ...response.metadata.icpCorrelation,
    channelId: ROOM_CHANNEL,
    surface: 'companion_room',
  };
  const pendingSpend = response.metadata.fatiguePendingSpend;
  if (!pendingSpend) throw new Error('room recovery fixture requires pending spend');

  response.channelId = ROOM_CHANNEL;
  response.metadata.icpCorrelation = roomCorrelation;
  response.metadata.fatigue.channelSetting = channelSetting;
  response.metadata.fatigue.scope.channelId = ROOM_CHANNEL;
  pendingSpend.scope.channelId = ROOM_CHANNEL;
  pendingSpend.correlation.channelId = ROOM_CHANNEL;
  pendingSpend.correlation.icpCorrelation = roomCorrelation;
  return response;
}

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
    label: 'channelSetting/ICP surface',
    mutate: fatigue => { fatigue.channelSetting = 'unknown'; },
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

describe('ICP recovery fatigue production invariants', () => {
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

  it.each([
    'busy_human_group',
    'one_human_companion_hosted',
    'quiet_companion_room',
  ] as const)('accepts the %s fatigue setting on an ICP room surface', channelSetting => {
    const response = asRoomRecoveryResponse(channelSetting);
    expect(parseIcpRecoveryResponse(response, {
      label: 'test room recovery response',
    })).toEqual(response);
  });

  it.each(['dm', 'public_group', 'unknown'] as const)(
    'rejects the %s fatigue setting on an ICP room surface',
    channelSetting => {
      const response = asRoomRecoveryResponse(channelSetting);
      expect(() => parseIcpRecoveryResponse(response, {
        label: 'test room recovery response',
      })).toThrow(/fatigue channel setting binding/i);
    },
  );

  it.each([
    'allowed_charged',
    'overcharge_charged for work intent',
  ])('rejects a coherent recorded ledger position below the %s projection', label => {
    const response = structuredClone(requireFatigueDecisionFixture(label).response);
    const pendingSpend = response.metadata.fatiguePendingSpend;
    if (!pendingSpend) throw new Error(`${label} fixture requires pending spend`);
    const normalSpentAfter = response.metadata.fatigue.budget.normalSpentBefore;
    const overchargeSpentAfter = response.metadata.fatigue.budget.overchargeSpentBefore;
    response.metadata.fatigue.recordedEvent = {
      timestampMs: pendingSpend.timestampMs,
      amount: pendingSpend.amount,
      decision: pendingSpend.decision,
      reason: pendingSpend.reason,
      spentAfter: normalSpentAfter + overchargeSpentAfter,
      remainingAllowance: Math.max(0, pendingSpend.limits.hardLimit - normalSpentAfter),
      normalSpentAfter,
      overchargeSpentAfter,
      overchargeAllowance: pendingSpend.limits.overchargeLimit,
      remainingOvercharge: Math.max(
        0,
        pendingSpend.limits.overchargeLimit - overchargeSpentAfter,
      ),
      softState: normalSpentAfter >= pendingSpend.limits.softLimit
        ? 'soft_limit_reached'
        : 'clear',
      hardState: normalSpentAfter >= pendingSpend.limits.hardLimit
        ? 'exhausted'
        : 'available',
    };

    expect(() => parseIcpRecoveryResponse(response, {
      label: 'test recovery response',
    })).toThrow(/fatigue recorded event derived state is inconsistent/i);
  });

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

});
