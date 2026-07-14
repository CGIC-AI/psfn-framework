import type {
  FatigueContinuationEvidence,
  FatiguePolicyConfig,
  FatiguePolicyState,
  FatigueRegulationState,
} from '../../../shared/contracts/charge-policy.js';
import type {
  FatigueEnforcementDecision,
  FatigueSocialRegulationMetadata,
} from '../../../shared/contracts/runtime.js';
import type { FatigueBudgetState } from './fatigue-budget.js';
import { isFatigueWorkIntent } from './policy.js';

function resolveContinuationEvidence(input: {
  policy: FatiguePolicyConfig['socialRegulation']['continuationEvidence'];
  recentHumanParticipation: boolean;
  trustedStructuredWorkIntent: boolean;
  explicitPeerInvitation: boolean;
}): FatigueContinuationEvidence[] {
  return [
    ...(input.policy.recentHumanParticipation && input.recentHumanParticipation
      ? ['recent_human_participation' as const]
      : []),
    ...(input.policy.activeWorkOrResearch && input.trustedStructuredWorkIntent
      ? ['active_work_or_research' as const]
      : []),
    ...(input.policy.explicitPeerInvitation && input.explicitPeerInvitation
      ? ['explicit_peer_invitation' as const]
      : []),
  ];
}

function resolveState(input: {
  decision: FatigueEnforcementDecision;
  policyBaseState: Exclude<FatiguePolicyState, 'overcharge_eligible'>;
  spentBefore: number;
  softLimit: number;
  maturingRatio: number;
  overchargeRemainingBefore: number;
  amount: number;
}): FatigueRegulationState {
  if (input.decision === 'suppressed_hard_exhausted') return 'suppressed';
  if (input.decision === 'overcharge_charged') {
    return input.overchargeRemainingBefore === input.amount
      ? 'final_closeout'
      : 'overcharge_closeout';
  }
  if (input.policyBaseState === 'hard_exhausted') return 'hard_exhausted';
  if (input.policyBaseState === 'wrap_up_allowed') return 'wrap_up_allowed';
  if (input.policyBaseState === 'soft_exhausted') return 'charge_lane_active';
  if (input.policyBaseState === 'nearing_limit') return 'nearing_soft_allowance';
  const maturingAt = Math.max(1, Math.ceil(input.softLimit * input.maturingRatio));
  return input.spentBefore >= maturingAt ? 'conversation_maturing' : 'normal';
}

export function projectFatigueSocialRegulation(input: {
  config: FatiguePolicyConfig;
  decision: FatigueEnforcementDecision;
  policyBaseState: Exclude<FatiguePolicyState, 'overcharge_eligible'>;
  intent: Parameters<typeof isFatigueWorkIntent>[0];
  taskKind?: string;
  hasRecentHumanParticipation: boolean;
  explicitPeerInvitation?: boolean;
  continuationEvidenceOverride?: readonly FatigueContinuationEvidence[];
  stateBefore: FatigueBudgetState;
  amount: number;
}): FatigueSocialRegulationMetadata {
  // ICP closeout evidence must come from trusted structured runtime context.
  // Keyword-derived message intent is deliberately not accepted here.
  const structuredTaskKind = input.taskKind?.trim().toLowerCase() ?? '';
  const trustedStructuredWorkIntent = isFatigueWorkIntent(input.intent)
    && (structuredTaskKind === 'work'
      || structuredTaskKind === 'research'
      || structuredTaskKind === 'problem_solving');
  const continuationEvidence = input.continuationEvidenceOverride
    ? [...input.continuationEvidenceOverride]
    : resolveContinuationEvidence({
        policy: input.config.socialRegulation.continuationEvidence,
        recentHumanParticipation: input.hasRecentHumanParticipation,
        trustedStructuredWorkIntent,
        explicitPeerInvitation: input.explicitPeerInvitation === true,
      });
  const state = resolveState({
    decision: input.decision,
    policyBaseState: input.policyBaseState,
    spentBefore: input.stateBefore.regulation?.relationshipPressure
      ?? input.stateBefore.normalSpent,
    softLimit: input.stateBefore.softLimit,
    maturingRatio: input.config.socialRegulation.conversationMaturingRatio,
    overchargeRemainingBefore: input.stateBefore.remainingOvercharge,
    amount: input.amount,
  });
  const regulation = input.stateBefore.regulation;
  const chargedLane = regulation !== undefined && (state === 'charge_lane_active'
    || state === 'wrap_up_allowed'
    || state === 'hard_exhausted'
    || state === 'overcharge_closeout'
    || state === 'final_closeout');
  return {
    state,
    chargeLane: chargedLane ? 'companion_social' : 'interactive',
    relationshipPressure: regulation?.relationshipPressure ?? input.stateBefore.normalSpent,
    rootNormalSpent: regulation?.rootNormalSpent ?? input.stateBefore.normalSpent,
    rootOverchargeSpent: regulation?.rootOverchargeSpent ?? input.stateBefore.overchargeSpent,
    contributingEventCount: regulation?.contributingEventCount ?? 0,
    marginalChargeUnits: chargedLane
      ? input.config.socialRegulation.marginalChargeUnits
      : 0,
    closeoutReserveRemainingBefore: input.stateBefore.remainingOvercharge,
    closeoutReserveRemainingAfterProjected: Math.max(
      0,
      input.stateBefore.remainingOvercharge
        - (input.decision === 'overcharge_charged' ? input.amount : 0),
    ),
    continuationEvidence,
    ...(regulation ? { rootInitiationId: regulation.rootInitiationId } : {}),
  };
}
