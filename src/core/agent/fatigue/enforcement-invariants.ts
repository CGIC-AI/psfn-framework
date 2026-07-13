import type {
  FatigueBudgetActorSnapshot,
  FatigueBudgetDecision,
  FatigueBudgetPeerSnapshot,
  FatigueBudgetReason,
  FatigueEnforcementMetadata,
} from '../../../shared/contracts/runtime.js';
import {
  FATIGUE_CONTINUATION_EVIDENCE_VALUES,
  FATIGUE_REGULATION_STATE_VALUES,
} from '../../../shared/contracts/charge-policy.js';
import {
  isFatigueWorkIntent,
  resolveFatigueOverchargeDeterministicBlockedReasons,
} from './policy.js';

const OVERCHARGE_REASON_ORDER = [
  'recent_human_participation',
  'work_intent_wrapup',
] as const;
const OVERCHARGE_REASONS = new Set<string>(OVERCHARGE_REASON_ORDER);
const OVERCHARGE_BLOCKED_REASON_ORDER = [
  'overcharge_disabled',
  'peer_not_machine_intelligence',
  'turn_does_not_spend_fatigue',
  'normal_allowance_not_exhausted',
  'no_qualifying_overcharge_trigger',
  'overcharge_reserve_exhausted',
] as const;
const OVERCHARGE_BLOCKED_REASONS = new Set<string>(OVERCHARGE_BLOCKED_REASON_ORDER);
const FATIGUE_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface FatigueSpendUnit {
  decision: Extract<FatigueBudgetDecision, 'charged' | 'free'>;
  reason: Extract<
    FatigueBudgetReason,
    | 'machine_intelligence_response'
    | 'peer_not_machine_intelligence'
    | 'triggering_author_not_machine_intelligence'
  >;
  amount: 0 | 1;
}

export function resolveFatigueSpendUnit(input: {
  peer: FatigueBudgetPeerSnapshot;
  triggeringAuthor: FatigueBudgetActorSnapshot;
}): FatigueSpendUnit {
  if (input.peer.isMachineIntelligence !== true) {
    return { decision: 'free', reason: 'peer_not_machine_intelligence', amount: 0 };
  }
  if (input.triggeringAuthor.isMachineIntelligence !== true) {
    return {
      decision: 'free',
      reason: 'triggering_author_not_machine_intelligence',
      amount: 0,
    };
  }
  return { decision: 'charged', reason: 'machine_intelligence_response', amount: 1 };
}

export interface FatigueEnforcementContract {
  correlationDecision: 'allow' | 'allow_overcharge' | 'suppress';
  pendingSpend: 'required' | 'forbidden';
}

const DECISION_CONTRACTS = {
  allowed_free: {
    modelDisposition: 'allowed',
    alertInjected: false,
    spendDecision: 'free',
    correlationDecision: 'allow',
    pendingSpend: 'forbidden',
    overchargePermitted: false,
    policyBaseStates: [
      'normal',
      'nearing_limit',
      'soft_exhausted',
      'wrap_up_allowed',
      'hard_exhausted',
    ],
  },
  allowed_charged: {
    modelDisposition: 'allowed',
    alertInjected: false,
    spendDecision: 'charged',
    correlationDecision: 'allow',
    pendingSpend: 'required',
    overchargePermitted: false,
    policyBaseStates: ['normal', 'nearing_limit'],
  },
  wrap_up_charged: {
    modelDisposition: 'allowed',
    alertInjected: true,
    spendDecision: 'charged',
    correlationDecision: 'allow',
    pendingSpend: 'required',
    overchargePermitted: false,
    policyBaseStates: ['soft_exhausted', 'wrap_up_allowed'],
  },
  overcharge_charged: {
    modelDisposition: 'allowed',
    alertInjected: true,
    spendDecision: 'overcharge',
    correlationDecision: 'allow_overcharge',
    pendingSpend: 'required',
    overchargePermitted: true,
    policyBaseStates: ['hard_exhausted'],
  },
  suppressed_hard_exhausted: {
    modelDisposition: 'suppressed',
    alertInjected: false,
    spendDecision: 'charged',
    correlationDecision: 'suppress',
    pendingSpend: 'forbidden',
    overchargePermitted: false,
    policyBaseStates: ['hard_exhausted'],
  },
} as const satisfies Record<
  FatigueEnforcementMetadata['decision'],
  {
    modelDisposition: FatigueEnforcementMetadata['modelDisposition'];
    alertInjected: boolean;
    spendDecision: FatigueEnforcementMetadata['spendDecision'];
    correlationDecision: FatigueEnforcementContract['correlationDecision'];
    pendingSpend: FatigueEnforcementContract['pendingSpend'];
    overchargePermitted: boolean;
    policyBaseStates: readonly FatigueEnforcementMetadata['policyBaseState'][];
  }
>;

function fail(field: string): never {
  throw new Error(`Fatigue production invariant is inconsistent: ${field}`);
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasCanonicalOrder(
  values: readonly string[],
  canonicalOrder: readonly string[],
): boolean {
  let previousIndex = -1;
  for (const value of values) {
    const index = canonicalOrder.indexOf(value);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function assertSnapshotInvariants(metadata: FatigueEnforcementMetadata): void {
  if (!metadata.scope.localCompanionId.trim()
    || !metadata.scope.peerContactId.trim()
    || !metadata.scope.channelId.trim()
    || !FATIGUE_DAY_KEY_PATTERN.test(metadata.scope.dayKey)
    || metadata.scope.peerContactId !== metadata.peer.contactId) {
    fail('scope and peer identity');
  }
  if (metadata.triggeringAuthor.contactId !== undefined
    && metadata.triggeringAuthor.contactId !== metadata.peer.contactId) {
    fail('triggering author contact identity');
  }
  if (metadata.peer.displayName !== metadata.triggeringAuthor.displayName) {
    fail('peer and triggering author display identity');
  }
}

function assertPolicyStateBudgetInvariants(metadata: FatigueEnforcementMetadata): void {
  const peerIsMachineIntelligence = metadata.peer.isMachineIntelligence === true;
  const { normalSpentBefore, softLimit, hardLimit } = metadata.budget;
  if (!peerIsMachineIntelligence) {
    if (metadata.policyBaseState !== 'normal') fail('non-MI policy base state');
    return;
  }
  const hardExhausted = normalSpentBefore >= hardLimit;
  if ((metadata.policyBaseState === 'hard_exhausted') !== hardExhausted) {
    fail('hard-exhausted policy base state');
  }
  if ((metadata.policyBaseState === 'normal'
      || metadata.policyBaseState === 'nearing_limit')
    && normalSpentBefore >= softLimit) {
    fail('pre-soft-limit policy base state');
  }
  if (metadata.policyBaseState === 'soft_exhausted'
    && (normalSpentBefore < softLimit || hardExhausted)) {
    fail('soft-exhausted policy base state');
  }
}

function assertBudgetInvariants(metadata: FatigueEnforcementMetadata): void {
  const { budget } = metadata;
  if (Object.values(budget).some(value => !Number.isInteger(value) || value < 0)) {
    fail('budget response counts must be non-negative integers');
  }
  if (budget.softLimit > budget.hardLimit || budget.allowance !== budget.hardLimit) {
    fail('budget limits');
  }
  if (budget.spentBefore !== budget.normalSpentBefore + budget.overchargeSpentBefore
    || budget.remainingBefore !== Math.max(0, budget.allowance - budget.normalSpentBefore)
    || budget.overchargeRemainingBefore
      !== Math.max(0, budget.overchargeAllowance - budget.overchargeSpentBefore)) {
    fail('budget state before');
  }
  const expectedNormalAfter = budget.normalSpentBefore
    + (metadata.spendDecision === 'charged' ? budget.amount : 0);
  const expectedOverchargeAfter = budget.overchargeSpentBefore
    + (metadata.spendDecision === 'overcharge' ? budget.amount : 0);
  if (budget.normalSpentAfterProjected !== expectedNormalAfter
    || budget.overchargeSpentAfterProjected !== expectedOverchargeAfter
    || budget.spentAfterProjected !== expectedNormalAfter + expectedOverchargeAfter
    || budget.remainingAfterProjected !== Math.max(0, budget.allowance - expectedNormalAfter)
    || budget.overchargeRemainingAfterProjected
      !== Math.max(0, budget.overchargeAllowance - expectedOverchargeAfter)) {
    fail('budget state after');
  }
}

function assertSocialRegulationInvariants(metadata: FatigueEnforcementMetadata): void {
  const regulation = metadata.socialRegulation;
  if (!FATIGUE_REGULATION_STATE_VALUES.includes(regulation.state)
    || !['interactive', 'companion_social'].includes(regulation.chargeLane)
    || [
      regulation.relationshipPressure,
      regulation.rootNormalSpent,
      regulation.rootOverchargeSpent,
      regulation.contributingEventCount,
      regulation.marginalChargeUnits,
      regulation.closeoutReserveRemainingBefore,
      regulation.closeoutReserveRemainingAfterProjected,
    ].some(value => !Number.isFinite(value) || value < 0)
    || !Number.isInteger(regulation.rootNormalSpent)
    || !Number.isInteger(regulation.rootOverchargeSpent)
    || !Number.isInteger(regulation.contributingEventCount)
    || !Number.isInteger(regulation.marginalChargeUnits)
    || !Number.isInteger(regulation.closeoutReserveRemainingBefore)
    || !Number.isInteger(regulation.closeoutReserveRemainingAfterProjected)
    || !hasUniqueValues(regulation.continuationEvidence)
    || regulation.continuationEvidence.some(evidence => (
      !FATIGUE_CONTINUATION_EVIDENCE_VALUES.includes(evidence)
    ))) {
    fail('social regulation metadata');
  }
  const afterAllowance = regulation.state === 'charge_lane_active'
    || regulation.state === 'wrap_up_allowed'
    || regulation.state === 'hard_exhausted'
    || regulation.state === 'overcharge_closeout'
    || regulation.state === 'final_closeout';
  const icpRegulated = regulation.rootInitiationId !== undefined;
  if ((regulation.chargeLane === 'companion_social') !== (afterAllowance && icpRegulated)
    || (regulation.marginalChargeUnits > 0) !== (afterAllowance && icpRegulated)
    || (regulation.state === 'suppressed') !== (metadata.modelDisposition === 'suppressed')
    || regulation.closeoutReserveRemainingBefore !== metadata.budget.overchargeRemainingBefore
    || regulation.closeoutReserveRemainingAfterProjected
      !== metadata.budget.overchargeRemainingAfterProjected) {
    fail('social regulation decision coupling');
  }
  const expectedAlert = metadata.modelDisposition === 'allowed'
    && metadata.decision !== 'allowed_free'
    && regulation.state !== 'normal';
  if (metadata.alertInjected !== expectedAlert) {
    fail('social regulation prompt guidance');
  }
}

export function assertFatigueEnforcementMetadataInvariants(
  metadata: FatigueEnforcementMetadata,
): FatigueEnforcementContract {
  const contract = DECISION_CONTRACTS[metadata.decision];
  assertSocialRegulationInvariants(metadata);
  assertSnapshotInvariants(metadata);
  const actorIsMachineIntelligence = metadata.triggeringAuthor.isMachineIntelligence === true;
  if ((metadata.triggeringAuthor.role === 'machine_intelligence')
    !== actorIsMachineIntelligence) {
    fail('triggering author classification');
  }
  if (!metadata.peer.channelAuthorId
    || !metadata.triggeringAuthor.channelAuthorId
    || metadata.peer.channelAuthorId !== metadata.triggeringAuthor.channelAuthorId) {
    fail('peer and triggering author channel identity');
  }
  const peerIsMachineIntelligence = metadata.peer.isMachineIntelligence === true;
  if ((metadata.relationshipClass === 'non_machine_intelligence') === peerIsMachineIntelligence) {
    fail('peer relationship classification');
  }

  const baseSpend = resolveFatigueSpendUnit({
    peer: metadata.peer,
    triggeringAuthor: metadata.triggeringAuthor,
  });
  const expectedReason: FatigueBudgetReason = metadata.decision === 'overcharge_charged'
    ? metadata.overchargeReasons.includes('recent_human_participation')
      ? 'overcharge_recent_human_participation'
      : 'overcharge_work_intent_wrapup'
    : baseSpend.reason;
  const expectedAmount = contract.spendDecision === 'free' ? 0 : 1;
  const expectedShouldRecordSpend = contract.pendingSpend === 'required';
  if (metadata.modelDisposition !== contract.modelDisposition
    || metadata.shouldRecordSpend !== expectedShouldRecordSpend
    || metadata.spendDecision !== contract.spendDecision
    || metadata.spendReason !== expectedReason
    || metadata.budget.amount !== expectedAmount
    || metadata.overchargePermitted !== contract.overchargePermitted
    || !(contract.policyBaseStates as readonly FatigueEnforcementMetadata['policyBaseState'][])
      .includes(metadata.policyBaseState)) {
    fail('decision coupling');
  }
  if (metadata.decision === 'allowed_free' && baseSpend.decision !== 'free') {
    fail('free decision classification');
  }
  if (metadata.decision !== 'allowed_free' && baseSpend.decision !== 'charged') {
    fail('machine-intelligence response classification');
  }

  if (!hasUniqueValues(metadata.overchargeReasons)
    || metadata.overchargeReasons.some(reason => !OVERCHARGE_REASONS.has(reason))
    || !hasCanonicalOrder(metadata.overchargeReasons, OVERCHARGE_REASON_ORDER)) {
    fail('overcharge reasons');
  }
  if (!hasUniqueValues(metadata.overchargeBlockedReasons)
    || metadata.overchargeBlockedReasons.some(reason => !OVERCHARGE_BLOCKED_REASONS.has(reason))
    || !hasCanonicalOrder(
      metadata.overchargeBlockedReasons,
      OVERCHARGE_BLOCKED_REASON_ORDER,
    )) {
    fail('overcharge blocked reasons');
  }
  const workIntent = isFatigueWorkIntent(metadata.intent);
  if (metadata.overchargeEligible) {
    if (metadata.policyState !== 'overcharge_eligible'
      || metadata.policyBaseState !== 'hard_exhausted'
      || metadata.overchargeReasons.length === 0
      || metadata.overchargeReasons.includes('work_intent_wrapup') !== workIntent) {
      fail('overcharge eligibility');
    }
    const expectedBlockedReasons = metadata.overchargePermitted
      ? []
      : ['overcharge_reserve_exhausted'];
    if (JSON.stringify(metadata.overchargeBlockedReasons)
      !== JSON.stringify(expectedBlockedReasons)) {
      fail('overcharge reserve availability');
    }
  } else if (metadata.policyState !== metadata.policyBaseState
    || metadata.overchargeReasons.length !== 0
    || metadata.overchargeBlockedReasons.length === 0
    || metadata.overchargeBlockedReasons.includes('overcharge_reserve_exhausted')
    || (workIntent
      && metadata.overchargeBlockedReasons.includes('no_qualifying_overcharge_trigger'))) {
    fail('ineligible overcharge policy');
  }
  const deterministicBlockedReasons = resolveFatigueOverchargeDeterministicBlockedReasons({
    peerIsMachineIntelligence,
    turnSpendsFatigue: baseSpend.decision === 'charged',
    baseState: metadata.policyBaseState,
  });
  for (const reason of [
    'peer_not_machine_intelligence',
    'turn_does_not_spend_fatigue',
    'normal_allowance_not_exhausted',
  ] as const) {
    if (metadata.overchargeBlockedReasons.includes(reason)
      !== deterministicBlockedReasons.includes(reason)) {
      fail(`${reason} overcharge block`);
    }
  }
  if (metadata.decision === 'overcharge_charged' && !metadata.overchargeEligible) {
    fail('permitted overcharge eligibility');
  }
  if (metadata.decision !== 'overcharge_charged'
    && metadata.decision !== 'suppressed_hard_exhausted'
    && metadata.overchargeEligible) {
    fail('unexpected overcharge eligibility');
  }

  assertBudgetInvariants(metadata);
  assertPolicyStateBudgetInvariants(metadata);
  return {
    correlationDecision: contract.correlationDecision,
    pendingSpend: contract.pendingSpend,
  };
}
