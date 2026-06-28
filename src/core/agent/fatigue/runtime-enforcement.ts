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
import { makeFatigueDayKey, type FatigueBudgetEvaluation, type FatigueBudgetPort } from './fatigue-budget.js';
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
  if (input.channelMeta.privacyLevel === 'public' || input.channelMeta.privacyLevel === 'broadcast') {
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
}): FatigueEnforcementDecision {
  if (!input.spendsFatigue) {
    return 'allowed_free';
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
}): FatigueEnforcementMetadata {
  const suppressModel = input.decision === 'suppressed_hard_exhausted';
  const shouldRecordSpend = !suppressModel
    && input.policy.spend.spendsFatigue
    && input.evaluation.amount > 0;
  return {
    schemaVersion: 1,
    decision: input.decision,
    modelDisposition: suppressModel ? 'suppressed' : 'allowed',
    alertInjected: input.decision === 'wrap_up_charged',
    shouldRecordSpend,
    spendDecision: input.evaluation.decision,
    spendReason: input.evaluation.reason,
    policyState: input.policy.state,
    policyBaseState: input.policy.baseState,
    intent: input.policy.intent,
    relationshipClass: input.policy.relationshipClass,
    channelSetting: input.policy.channelSetting,
    overchargeEligible: input.policy.overcharge.eligible,
    overchargePermitted: false,
    overchargeBlockedReasons: [...input.policy.overcharge.blockedReasons],
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
    },
  };
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
  const recentHumanMessageCount = triggerAuthorKind === 'human' ? 1 : 0;
  const recentHumanParticipantCount = triggerAuthorKind === 'human' ? 1 : 0;
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
      humanParticipantCount: recentHumanParticipantCount,
      machineIntelligenceParticipantCount: peer.isMachineIntelligence === true ? 1 : 0,
      recentMessageCount: 1,
      recentHumanMessageCount,
    },
    recentHumanParticipation: {
      messageCount: recentHumanMessageCount,
      participantCount: recentHumanParticipantCount,
      ...(recentHumanMessageCount > 0 ? { latestMessageAgeMs: 0 } : {}),
    },
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
    },
  });
  const policy = evaluateFatiguePolicy({
    ...policyInputBase,
    spent: stateBefore.spent,
  });
  const evaluation = input.fatigueBudget.evaluate({
    localCompanionId: input.localCompanionId,
    channelId: input.channelId,
    peer,
    triggeringAuthor,
    limits: {
      softLimit: policy.softTarget,
      hardLimit: policy.hardCap,
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
  const decision = resolveEnforcementDecision({
    spendsFatigue: policy.spend.spendsFatigue,
    baseState: policy.baseState,
    hardState: evaluation.stateBefore.hardState,
  });
  const metadata = createMetadata({ decision, policy, evaluation });
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
    'The runtime is allowing this model call so you can author the outward response yourself.',
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
    recordedEvent: {
      timestampMs: event.timestampMs,
      amount: event.amount,
      decision: event.decision,
      reason: event.reason,
      spentAfter: event.spentAfter,
      remainingAllowance: event.remainingAllowance,
      softState: event.softState,
      hardState: event.hardState,
    },
  };
}
