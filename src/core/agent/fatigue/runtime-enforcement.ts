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
  type FatigueBudgetEvaluation,
  type FatigueBudgetPort,
} from './fatigue-budget.js';
import {
  evaluateFatiguePolicy,
  type FatiguePolicyChannelType,
  type FatiguePolicyTriggerAuthorKind,
} from './policy.js';

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
}): FatiguePolicyIntent {
  const taskKind = input.taskKind?.toLowerCase() ?? '';
  const content = input.content.toLowerCase();
  if (taskKind.includes('research') || content.includes('research')) {
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
    content.includes('debug')
    || content.includes('fix')
    || content.includes('problem')
    || content.includes('why')
    || content.includes('how')
  ) {
    return 'problem_solving';
  }
  if (content.includes('check in') || content.includes('checking in')) {
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
}): FatigueEnforcementMetadata {
  const suppressModel = input.decision === 'suppressed_hard_exhausted';
  const shouldRecordSpend = !suppressModel
    && input.policy.spend.spendsFatigue
    && input.evaluation.amount > 0;
  return {
    schemaVersion: 1,
    decision: input.decision,
    modelDisposition: suppressModel ? 'suppressed' : 'allowed',
    alertInjected: input.decision === 'wrap_up_charged' || input.decision === 'overcharge_charged',
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
  };
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
  const metadata = createMetadata({
    decision,
    policy,
    evaluation,
    overchargePermitted,
    overchargeBlockedReasons,
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
    metadata.overchargePermitted
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
