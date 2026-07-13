import type {
  FatiguePolicyConfig,
  FatiguePolicyIntent,
} from '../../../shared/contracts/charge-policy.js';
import type {
  CorrelationMetadata,
  FatigueBudgetActorSnapshot,
  FatigueBudgetEvent,
  FatigueBudgetPeerSnapshot,
  FatigueEnforcementDecision,
  FatigueEnforcementMetadata,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { RelationshipType } from '../../contacts/types.js';
import {
  createOverchargeFatigueEvaluation,
  makeFatigueDayKey,
  rebaseFatigueEvaluation,
  type FatigueBudgetEvaluation,
  type FatigueBudgetPort,
} from './fatigue-budget.js';
import { assertFatigueEnforcementMetadataInvariants } from './enforcement-invariants.js';
import {
  evaluateFatiguePolicy,
  type FatiguePolicyChannelType,
  type FatiguePolicyTriggerAuthorKind,
} from './policy.js';
import { projectFatigueSocialRegulation } from './social-regulation.js';
import type { IcpFatigueReservationResult } from './regulation-reservation.js';

export interface FatigueAuthorPolicyContext {
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  resolvedUserName: string;
  speakingWithIsMachineIntelligence?: boolean;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  relationshipType?: RelationshipType;
}

export interface FatigueTurnDecision {
  metadata: FatigueEnforcementMetadata;
  evaluation: FatigueBudgetEvaluation;
  suppressModel: boolean;
  shouldRecordSpend: boolean;
}

export interface FatigueRecentHumanParticipation {
  messageCount: number;
  participantCount: number;
  latestMessageAgeMs?: number;
}

export interface EvaluateFatigueForTurnInput {
  fatigueBudget: FatigueBudgetPort;
  fatiguePolicy: FatiguePolicyConfig;
  localCompanionId: string;
  message: SubstrateMessage;
  authorContext: FatigueAuthorPolicyContext;
  channelId: string;
  channelType?: string;
  channelMeta: ChannelMeta;
  taskKind?: string;
  recentHumanParticipation?: FatigueRecentHumanParticipation;
  timestampMs: number;
  correlation: CorrelationMetadata;
}

function resolveTriggerAuthorKind(author: FatigueAuthorPolicyContext): FatiguePolicyTriggerAuthorKind {
  if (author.speakingWithIsMachineIntelligence === true) {
    return 'machine_intelligence';
  }
  if (author.speakerRole === 'system') {
    return 'system';
  }
  return 'human';
}

function resolvePolicyChannelType(input: {
  message: SubstrateMessage;
  channelType?: string;
  channelMeta: ChannelMeta;
}): FatiguePolicyChannelType {
  if (input.message.isDirectMessage === true || input.channelMeta.isDirectMessage === true) {
    return 'dm';
  }
  if (input.message.channelId.includes('companion')) {
    return 'companion_room';
  }
  if (input.channelMeta.privacyLevel === 'public') {
    return 'public_group';
  }
  if (input.channelType === 'discord' || input.channelType === 'telegram') {
    return 'group';
  }
  return 'unknown';
}

function resolveFatigueIntent(input: {
  taskKind?: string;
  content: string;
  structuredOnly?: boolean;
}): FatiguePolicyIntent {
  const taskKind = input.taskKind?.toLowerCase() ?? '';
  const content = input.content.toLowerCase();
  if (taskKind.includes('research') || (!input.structuredOnly && content.includes('research'))) {
    return 'research';
  }
  if (
    taskKind.includes('tool')
    || taskKind.includes('work')
    || taskKind.includes('maintenance')
  ) {
    return 'work';
  }
  if (
    !input.structuredOnly && (
      content.includes('debug')
    || content.includes('fix')
    || content.includes('problem')
    || content.includes('why')
    || content.includes('how')
    )
  ) {
    return 'problem_solving';
  }
  if (!input.structuredOnly && (content.includes('check in') || content.includes('checking in'))) {
    return 'check_in';
  }
  return 'casual';
}

function buildPeerSnapshot(input: {
  message: SubstrateMessage;
  authorContext: FatigueAuthorPolicyContext;
}): FatigueBudgetPeerSnapshot {
  const contactId = input.authorContext.canonicalContactKey
    ?? input.authorContext.subjectIdentityKey
    ?? input.message.authorId;
  return {
    contactId,
    channelAuthorId: input.message.authorId,
    displayName: input.authorContext.resolvedUserName || input.message.authorName,
    ...(input.authorContext.speakingWithIsMachineIntelligence === true ? { isMachineIntelligence: true } : {}),
  };
}

function buildTriggeringAuthorSnapshot(input: {
  message: SubstrateMessage;
  authorContext: FatigueAuthorPolicyContext;
  kind: FatiguePolicyTriggerAuthorKind;
}): FatigueBudgetActorSnapshot {
  return {
    role: input.kind,
    ...(input.authorContext.canonicalContactKey ? { contactId: input.authorContext.canonicalContactKey } : {}),
    channelAuthorId: input.message.authorId,
    displayName: input.authorContext.resolvedUserName || input.message.authorName,
    ...(input.authorContext.speakingWithIsMachineIntelligence === true ? { isMachineIntelligence: true } : {}),
  };
}

function resolveEnforcementDecision(input: {
  spendsFatigue: boolean;
  baseState: FatigueEnforcementMetadata['policyBaseState'];
  hardState: FatigueBudgetEvaluation['stateBefore']['hardState'];
  overchargePermitted: boolean;
}): FatigueEnforcementDecision {
  if (!input.spendsFatigue) {
    return 'allowed_free';
  }
  if (input.overchargePermitted) {
    return 'overcharge_charged';
  }
  if (input.baseState === 'hard_exhausted' || input.hardState === 'exhausted') {
    return 'suppressed_hard_exhausted';
  }
  if (input.baseState === 'soft_exhausted' || input.baseState === 'wrap_up_allowed') {
    return 'wrap_up_charged';
  }
  return 'allowed_charged';
}

function createMetadata(input: {
  decision: FatigueEnforcementDecision;
  policy: ReturnType<typeof evaluateFatiguePolicy>;
  evaluation: FatigueBudgetEvaluation;
  overchargePermitted: boolean;
  overchargeBlockedReasons: string[];
  socialRegulation: FatigueEnforcementMetadata['socialRegulation'];
}): FatigueEnforcementMetadata {
  const suppressModel = input.decision === 'suppressed_hard_exhausted';
  const shouldRecordSpend = !suppressModel
    && input.policy.spend.spendsFatigue
    && input.evaluation.amount > 0;
  const metadata: FatigueEnforcementMetadata = {
    schemaVersion: 1,
    decision: input.decision,
    modelDisposition: suppressModel ? 'suppressed' : 'allowed',
    alertInjected: input.decision !== 'suppressed_hard_exhausted'
      && input.decision !== 'allowed_free'
      && input.socialRegulation.state !== 'normal',
    shouldRecordSpend,
    spendDecision: input.evaluation.decision,
    spendReason: input.evaluation.reason,
    policyState: input.policy.state,
    policyBaseState: input.policy.baseState,
    intent: input.policy.intent,
    relationshipClass: input.policy.relationshipClass,
    channelSetting: input.policy.channelSetting,
    overchargeEligible: input.policy.overcharge.eligible,
    overchargePermitted: input.overchargePermitted,
    overchargeBlockedReasons: [...input.overchargeBlockedReasons],
    overchargeReasons: [...input.policy.overcharge.reasons],
    scope: { ...input.evaluation.scope },
    peer: { ...input.evaluation.peer },
    triggeringAuthor: { ...input.evaluation.triggeringAuthor },
    budget: {
      spentBefore: input.evaluation.stateBefore.spent,
      remainingBefore: input.evaluation.stateBefore.remainingAllowance,
      allowance: input.evaluation.stateBefore.allowance,
      softLimit: input.evaluation.stateBefore.softLimit,
      hardLimit: input.policy.hardCap,
      amount: input.evaluation.amount,
      spentAfterProjected: input.evaluation.stateAfter.spent,
      remainingAfterProjected: input.evaluation.stateAfter.remainingAllowance,
      normalSpentBefore: input.evaluation.stateBefore.normalSpent,
      normalSpentAfterProjected: input.evaluation.stateAfter.normalSpent,
      overchargeSpentBefore: input.evaluation.stateBefore.overchargeSpent,
      overchargeSpentAfterProjected: input.evaluation.stateAfter.overchargeSpent,
      overchargeAllowance: input.evaluation.stateBefore.overchargeAllowance,
      overchargeRemainingBefore: input.evaluation.stateBefore.remainingOvercharge,
      overchargeRemainingAfterProjected: input.evaluation.stateAfter.remainingOvercharge,
    },
    socialRegulation: {
      ...input.socialRegulation,
      continuationEvidence: [...input.socialRegulation.continuationEvidence],
    },
  };
  assertFatigueEnforcementMetadataInvariants(metadata);
  return metadata;
}

function resolveRecentHumanParticipation(input: {
  triggerAuthorKind: FatiguePolicyTriggerAuthorKind;
  recentHumanParticipation?: FatigueRecentHumanParticipation;
}): FatigueRecentHumanParticipation {
  if (input.recentHumanParticipation) {
    return input.recentHumanParticipation;
  }
  return input.triggerAuthorKind === 'human'
    ? { messageCount: 1, participantCount: 1, latestMessageAgeMs: 0 }
    : { messageCount: 0, participantCount: 0 };
}

function selectOverchargeReason(
  policy: ReturnType<typeof evaluateFatiguePolicy>,
): 'overcharge_recent_human_participation' | 'overcharge_work_intent_wrapup' {
  return policy.overcharge.reasons.includes('recent_human_participation')
    ? 'overcharge_recent_human_participation'
    : 'overcharge_work_intent_wrapup';
}

export function evaluateFatigueForTurn(input: EvaluateFatigueForTurnInput): FatigueTurnDecision {
  const triggerAuthorKind = resolveTriggerAuthorKind(input.authorContext);
  const peer = buildPeerSnapshot(input);
  const triggeringAuthor = buildTriggeringAuthorSnapshot({
    message: input.message,
    authorContext: input.authorContext,
    kind: triggerAuthorKind,
  });
  const channelType = resolvePolicyChannelType({
    message: input.message,
    channelType: input.channelType,
    channelMeta: input.channelMeta,
  });
  const recentHumanParticipation = resolveRecentHumanParticipation({
    triggerAuthorKind,
    recentHumanParticipation: input.recentHumanParticipation,
  });
  const policyInputBase = {
    config: input.fatiguePolicy,
    peer: {
      contactId: peer.contactId,
      isMachineIntelligence: peer.isMachineIntelligence === true,
      relationshipType: input.authorContext.relationshipType ?? 'stranger',
      trustLevel: input.authorContext.trustLevel,
    },
    channel: {
      channelId: input.channelId,
      type: channelType,
      companionFocused: channelType === 'companion_room',
      companionHosted: channelType === 'companion_room',
      humanParticipantCount: recentHumanParticipation.participantCount,
      machineIntelligenceParticipantCount: peer.isMachineIntelligence === true ? 1 : 0,
      recentMessageCount: 1,
      recentHumanMessageCount: recentHumanParticipation.messageCount,
    },
    recentHumanParticipation,
    intent: resolveFatigueIntent({
      taskKind: input.taskKind,
      content: input.message.content,
      structuredOnly: input.message.routing?.icpCorrelation !== undefined,
    }),
    triggerAuthorKind,
  };
  const preliminaryPolicy = evaluateFatiguePolicy({
    ...policyInputBase,
    spent: 0,
  });
  const stateBefore = input.fatigueBudget.readState({
    localCompanionId: input.localCompanionId,
    peerContactId: peer.contactId,
    channelId: input.channelId,
    dayKey: makeFatigueDayKey(input.timestampMs),
    limits: {
      softLimit: preliminaryPolicy.softTarget,
      hardLimit: preliminaryPolicy.hardCap,
      overchargeLimit: preliminaryPolicy.overcharge.inputs.reserveResponses,
    },
    ...(input.message.routing?.icpCorrelation
      ? {
          regulation: {
            rootInitiationId: input.message.routing.icpCorrelation.rootInitiationId,
            timestampMs: input.timestampMs,
            relationshipPressureHalfLifeMs:
              input.fatiguePolicy.socialRegulation.relationshipPressureHalfLifeMs,
            relationshipPressureWindowMs:
              input.fatiguePolicy.socialRegulation.relationshipPressureWindowMs,
          },
        }
      : {}),
  });
  const policy = evaluateFatiguePolicy({
    ...policyInputBase,
    spent: stateBefore.normalSpent,
  });
  const baseEvaluation = input.fatigueBudget.evaluate({
    localCompanionId: input.localCompanionId,
    channelId: input.channelId,
    peer,
    triggeringAuthor,
    limits: {
      softLimit: policy.softTarget,
      hardLimit: policy.hardCap,
      overchargeLimit: policy.overcharge.inputs.reserveResponses,
    },
    timestampMs: input.timestampMs,
    correlation: input.correlation,
    details: {
      policyState: policy.state,
      policyBaseState: policy.baseState,
      relationshipClass: policy.relationshipClass,
      channelSetting: policy.channelSetting,
      intent: policy.intent,
      overchargeEligible: policy.overcharge.eligible,
      overchargePermitted: false,
    },
    ...(input.message.routing?.icpCorrelation
      ? {
          regulation: {
            rootInitiationId: input.message.routing.icpCorrelation.rootInitiationId,
            timestampMs: input.timestampMs,
            relationshipPressureHalfLifeMs:
              input.fatiguePolicy.socialRegulation.relationshipPressureHalfLifeMs,
            relationshipPressureWindowMs:
              input.fatiguePolicy.socialRegulation.relationshipPressureWindowMs,
          },
        }
      : {}),
  });
  const reserveAvailable = baseEvaluation.stateBefore.remainingOvercharge >= baseEvaluation.amount
    && baseEvaluation.amount > 0;
  const overchargeBlockedReasons = [
    ...policy.overcharge.blockedReasons,
    ...(policy.overcharge.eligible && !reserveAvailable ? ['overcharge_reserve_exhausted'] : []),
  ];
  const overchargePermitted = policy.overcharge.eligible && reserveAvailable;
  const evaluation = overchargePermitted
    ? createOverchargeFatigueEvaluation(baseEvaluation, selectOverchargeReason(policy))
    : baseEvaluation;
  const decision = resolveEnforcementDecision({
    spendsFatigue: policy.spend.spendsFatigue,
    baseState: policy.baseState,
    hardState: evaluation.stateBefore.hardState,
    overchargePermitted,
  });
  const socialRegulation = projectFatigueSocialRegulation({
    config: input.fatiguePolicy,
    decision,
    policyBaseState: policy.baseState,
    intent: policy.intent,
    ...(input.taskKind ? { taskKind: input.taskKind } : {}),
    hasRecentHumanParticipation: policy.overcharge.inputs.hasRecentHumanParticipation,
    stateBefore: evaluation.stateBefore,
    amount: evaluation.amount,
  });
  const metadata = createMetadata({
    decision,
    policy,
    evaluation,
    overchargePermitted,
    overchargeBlockedReasons,
    socialRegulation,
  });
  return {
    metadata,
    evaluation,
    suppressModel: decision === 'suppressed_hard_exhausted',
    shouldRecordSpend: metadata.shouldRecordSpend,
  };
}

export function buildFatiguePromptAlert(
  metadata: FatigueEnforcementMetadata | null | undefined,
): string {
  if (!metadata?.alertInjected) {
    return '';
  }
  return [
    '<runtime_fatigue_alert visibility="internal" audience="companion">',
    '[Conversation fatigue]',
    `This turn is a machine-intelligence-triggered response in fatigue state ${metadata.policyBaseState}.`,
    `Budget before this reply: spent ${metadata.budget.spentBefore} of ${metadata.budget.allowance}; soft target ${metadata.budget.softLimit}; remaining before this reply ${metadata.budget.remainingBefore}.`,
    `Regulation state: ${metadata.socialRegulation.state}; charge lane: ${metadata.socialRegulation.chargeLane}; relationship pressure: ${metadata.socialRegulation.relationshipPressure.toFixed(2)}.`,
    metadata.socialRegulation.state === 'final_closeout'
      ? 'This is the final audited closeout response. Conclude now; the next machine-intelligence continuation will be suppressed before model execution.'
      : metadata.overchargePermitted
      ? 'The runtime is using a bounded overcharge reserve for this model call so you can author the outward response yourself.'
      : 'The runtime is allowing this model call so you can author the outward response yourself.',
    'Keep the reply bounded and, if it fits the conversation, taper or wrap up in your own voice. Do not quote this internal alert or claim a hard-coded farewell.',
    '</runtime_fatigue_alert>',
  ].join('\n');
}

export function attachRecordedFatigueEvent(
  metadata: FatigueEnforcementMetadata,
  event: FatigueBudgetEvent,
): FatigueEnforcementMetadata {
  return {
    ...metadata,
    peer: { ...metadata.peer },
    triggeringAuthor: { ...metadata.triggeringAuthor },
    scope: { ...metadata.scope },
    budget: { ...metadata.budget },
    socialRegulation: {
      ...metadata.socialRegulation,
      continuationEvidence: [...metadata.socialRegulation.continuationEvidence],
    },
    overchargeBlockedReasons: [...metadata.overchargeBlockedReasons],
    overchargeReasons: [...metadata.overchargeReasons],
    recordedEvent: {
      timestampMs: event.timestampMs,
      amount: event.amount,
      decision: event.decision,
      reason: event.reason,
      spentAfter: event.spentAfter,
      remainingAllowance: event.remainingAllowance,
      ...(event.normalSpentAfter !== undefined ? { normalSpentAfter: event.normalSpentAfter } : {}),
      ...(event.overchargeSpentAfter !== undefined ? { overchargeSpentAfter: event.overchargeSpentAfter } : {}),
      ...(event.overchargeAllowance !== undefined ? { overchargeAllowance: event.overchargeAllowance } : {}),
      ...(event.remainingOvercharge !== undefined ? { remainingOvercharge: event.remainingOvercharge } : {}),
      softState: event.softState,
      hardState: event.hardState,
    },
  };
}

function resolveReconciledPolicyBaseState(input: {
  config: FatiguePolicyConfig;
  normalSpentBefore: number;
  softLimit: number;
  hardLimit: number;
}): FatigueEnforcementMetadata['policyBaseState'] {
  if (input.normalSpentBefore >= input.hardLimit) return 'hard_exhausted';
  if (input.hardLimit - input.normalSpentBefore
    <= input.config.stateThresholds.wrapUpRemainingResponses) {
    return 'wrap_up_allowed';
  }
  if (input.normalSpentBefore >= input.softLimit) return 'soft_exhausted';
  if (input.softLimit - input.normalSpentBefore
    <= input.config.stateThresholds.nearingLimitRemainingResponses) {
    return 'nearing_limit';
  }
  return 'normal';
}

function resolveReconciledOverchargeReasons(
  metadata: FatigueEnforcementMetadata,
): Array<'recent_human_participation' | 'work_intent_wrapup'> {
  return [
    ...(metadata.socialRegulation.continuationEvidence.includes('recent_human_participation')
      ? ['recent_human_participation' as const]
      : []),
    ...(metadata.socialRegulation.continuationEvidence.includes('active_work_or_research')
      ? ['work_intent_wrapup' as const]
      : []),
  ];
}

/** Rebuild the complete turn decision from the shared pre-turn snapshot. */
export function reconcileFatigueWithReservationSnapshot(input: {
  fatigueDecision: FatigueTurnDecision;
  reservation: IcpFatigueReservationResult;
  fatiguePolicy: FatiguePolicyConfig;
  decision: 'charged' | 'overcharge';
}): FatigueTurnDecision {
  if (input.reservation.outcome === 'exhausted') {
    throw new Error('A reserved fatigue snapshot is required for reconciliation');
  }
  const reasons = resolveReconciledOverchargeReasons(input.fatigueDecision.metadata);
  const reason = input.decision === 'overcharge'
    ? reasons.includes('recent_human_participation')
      ? 'overcharge_recent_human_participation' as const
      : 'overcharge_work_intent_wrapup' as const
    : 'machine_intelligence_response' as const;
  const evaluation = rebaseFatigueEvaluation({
    evaluation: input.fatigueDecision.evaluation,
    decision: input.decision,
    reason,
    normalSpentBefore: input.reservation.normalSpentBefore,
    overchargeSpentBefore: input.reservation.overchargeSpentBefore,
    relationshipPressure: input.reservation.relationshipPressure,
    rootNormalSpent: input.reservation.rootNormalSpent,
    rootOverchargeSpent: input.reservation.rootOverchargeSpent,
    contributingEventCount: input.reservation.contributingReservationCount,
  });
  const policyBaseState = resolveReconciledPolicyBaseState({
    config: input.fatiguePolicy,
    normalSpentBefore: evaluation.stateBefore.normalSpent,
    softLimit: evaluation.stateBefore.softLimit,
    hardLimit: evaluation.stateBefore.allowance,
  });
  if (input.decision === 'charged' && policyBaseState === 'hard_exhausted') {
    throw new Error('Shared fatigue reservation returned a charged slot after hard exhaustion');
  }
  const overchargeEligible = policyBaseState === 'hard_exhausted'
    && input.fatiguePolicy.overcharge.enabled
    && reasons.length > 0;
  if (input.decision === 'overcharge' && !overchargeEligible) {
    throw new Error('Shared fatigue reservation returned an ineligible overcharge slot');
  }
  const overchargeBlockedReasons = overchargeEligible
    ? []
    : [
        ...(!input.fatiguePolicy.overcharge.enabled
          ? ['overcharge_disabled' as const]
          : []),
        ...(policyBaseState !== 'hard_exhausted'
          ? ['normal_allowance_not_exhausted' as const]
          : []),
        ...(reasons.length === 0
          ? ['no_qualifying_overcharge_trigger' as const]
          : []),
      ];
  const decision: FatigueEnforcementDecision = input.decision === 'overcharge'
    ? 'overcharge_charged'
    : policyBaseState === 'soft_exhausted' || policyBaseState === 'wrap_up_allowed'
      ? 'wrap_up_charged'
      : 'allowed_charged';
  const socialRegulation = projectFatigueSocialRegulation({
    config: input.fatiguePolicy,
    decision,
    policyBaseState,
    intent: input.fatigueDecision.metadata.intent,
    hasRecentHumanParticipation:
      input.fatigueDecision.metadata.socialRegulation.continuationEvidence
        .includes('recent_human_participation'),
    continuationEvidenceOverride:
      input.fatigueDecision.metadata.socialRegulation.continuationEvidence,
    stateBefore: evaluation.stateBefore,
    amount: evaluation.amount,
  });
  const metadata: FatigueEnforcementMetadata = {
    ...input.fatigueDecision.metadata,
    decision,
    modelDisposition: 'allowed',
    alertInjected: socialRegulation.state !== 'normal',
    shouldRecordSpend: true,
    spendDecision: input.decision,
    spendReason: reason,
    policyState: overchargeEligible ? 'overcharge_eligible' : policyBaseState,
    policyBaseState,
    overchargeEligible,
    overchargePermitted: input.decision === 'overcharge',
    overchargeBlockedReasons,
    overchargeReasons: overchargeEligible ? reasons : [],
    budget: {
      spentBefore: evaluation.stateBefore.spent,
      remainingBefore: evaluation.stateBefore.remainingAllowance,
      allowance: evaluation.stateBefore.allowance,
      softLimit: evaluation.stateBefore.softLimit,
      hardLimit: evaluation.stateBefore.allowance,
      amount: evaluation.amount,
      spentAfterProjected: evaluation.stateAfter.spent,
      remainingAfterProjected: evaluation.stateAfter.remainingAllowance,
      normalSpentBefore: evaluation.stateBefore.normalSpent,
      normalSpentAfterProjected: evaluation.stateAfter.normalSpent,
      overchargeSpentBefore: evaluation.stateBefore.overchargeSpent,
      overchargeSpentAfterProjected: evaluation.stateAfter.overchargeSpent,
      overchargeAllowance: evaluation.stateBefore.overchargeAllowance,
      overchargeRemainingBefore: evaluation.stateBefore.remainingOvercharge,
      overchargeRemainingAfterProjected: evaluation.stateAfter.remainingOvercharge,
    },
    socialRegulation,
  };
  assertFatigueEnforcementMetadataInvariants(metadata);
  return {
    metadata,
    evaluation,
    suppressModel: false,
    shouldRecordSpend: true,
  };
}

/**
 * Reconcile a locally allowed turn with the shared Postgres concurrency fence.
 * A losing last-slot racer is converted to the ordinary zero-model suppression
 * contract, carrying the shared relationship/root snapshot for audit.
 */
export function suppressFatigueAfterReservationExhaustion(
  metadata: FatigueEnforcementMetadata,
  reservation: IcpFatigueReservationResult,
  fatiguePolicy: FatiguePolicyConfig,
): FatigueEnforcementMetadata {
  if (reservation.outcome !== 'exhausted') {
    throw new Error('Fatigue reservation reconciliation requires an exhausted snapshot');
  }
  const normalSpentBefore = Math.max(
    metadata.budget.hardLimit,
    reservation.normalSpentBefore,
  );
  const overchargeSpentBefore = reservation.overchargeSpentBefore;
  const overchargeReasons = resolveReconciledOverchargeReasons(metadata);
  const overchargeEligible = fatiguePolicy.overcharge.enabled
    && overchargeReasons.length > 0;
  const overchargeRemaining = Math.max(
    0,
    metadata.budget.overchargeAllowance - overchargeSpentBefore,
  );
  const suppressed: FatigueEnforcementMetadata = {
    ...metadata,
    decision: 'suppressed_hard_exhausted',
    modelDisposition: 'suppressed',
    alertInjected: false,
    shouldRecordSpend: false,
    spendDecision: 'charged',
    spendReason: 'machine_intelligence_response',
    policyState: overchargeEligible ? 'overcharge_eligible' : 'hard_exhausted',
    policyBaseState: 'hard_exhausted',
    overchargeEligible,
    overchargePermitted: false,
    overchargeBlockedReasons: overchargeEligible
      ? ['overcharge_reserve_exhausted']
      : [
          ...(!fatiguePolicy.overcharge.enabled
            ? ['overcharge_disabled' as const]
            : []),
          ...(overchargeReasons.length === 0
            ? ['no_qualifying_overcharge_trigger' as const]
            : []),
        ],
    overchargeReasons: overchargeEligible ? overchargeReasons : [],
    budget: {
      ...metadata.budget,
      spentBefore: normalSpentBefore + overchargeSpentBefore,
      remainingBefore: 0,
      amount: 1,
      spentAfterProjected: normalSpentBefore + overchargeSpentBefore + 1,
      remainingAfterProjected: 0,
      normalSpentBefore,
      normalSpentAfterProjected: normalSpentBefore + 1,
      overchargeSpentBefore,
      overchargeSpentAfterProjected: overchargeSpentBefore,
      overchargeRemainingBefore: overchargeRemaining,
      overchargeRemainingAfterProjected: overchargeRemaining,
    },
    socialRegulation: {
      ...metadata.socialRegulation,
      state: 'suppressed',
      chargeLane: 'interactive',
      relationshipPressure: reservation.relationshipPressure,
      rootNormalSpent: reservation.rootNormalSpent,
      rootOverchargeSpent: reservation.rootOverchargeSpent,
      contributingEventCount: reservation.contributingReservationCount,
      marginalChargeUnits: 0,
      closeoutReserveRemainingBefore: overchargeRemaining,
      closeoutReserveRemainingAfterProjected: overchargeRemaining,
      continuationEvidence: [...metadata.socialRegulation.continuationEvidence],
    },
  };
  assertFatigueEnforcementMetadataInvariants(suppressed);
  return suppressed;
}
