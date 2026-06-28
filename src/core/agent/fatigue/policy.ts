import type {
  FatiguePolicyChannelSetting,
  FatiguePolicyConfig,
  FatiguePolicyIntent,
  FatiguePolicyRelationshipClass,
  FatiguePolicyResponseBudget,
  FatiguePolicyState,
} from '../../../shared/contracts/charge-policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { RelationshipType } from '../../contacts/types.js';

export type FatiguePolicyChannelType = 'dm' | 'group' | 'companion_room' | 'public_group' | 'unknown';
export type FatiguePolicyTriggerAuthorKind = 'machine_intelligence' | 'human' | 'system' | 'unknown';

export type FatiguePolicySpendReason =
  | 'peer_machine_intelligence_turn'
  | 'human_authored_turn'
  | 'peer_not_machine_intelligence'
  | 'non_machine_intelligence_author';

export type FatiguePolicyOverchargeReason =
  | 'recent_human_participation'
  | 'work_intent_wrapup';

export type FatiguePolicyOverchargeBlockedReason =
  | 'overcharge_disabled'
  | 'peer_not_machine_intelligence'
  | 'turn_does_not_spend_fatigue'
  | 'normal_allowance_not_exhausted'
  | 'no_qualifying_overcharge_trigger';

export interface FatiguePolicyPeerInput {
  contactId: string;
  isMachineIntelligence: boolean;
  relationshipType: RelationshipType;
  trustLevel: TrustLevel;
}

export interface FatiguePolicyChannelInput {
  channelId?: string;
  type: FatiguePolicyChannelType;
  setting?: FatiguePolicyChannelSetting;
  companionFocused?: boolean;
  companionHosted?: boolean;
  humanParticipantCount: number;
  machineIntelligenceParticipantCount: number;
  recentMessageCount: number;
  recentHumanMessageCount: number;
}

export interface FatiguePolicyRecentHumanParticipationInput {
  messageCount: number;
  participantCount: number;
  latestMessageAgeMs?: number;
}

export interface EvaluateFatiguePolicyInput {
  config: FatiguePolicyConfig;
  peer: FatiguePolicyPeerInput;
  channel: FatiguePolicyChannelInput;
  recentHumanParticipation: FatiguePolicyRecentHumanParticipationInput;
  intent: FatiguePolicyIntent;
  spent: number;
  triggerAuthorKind: FatiguePolicyTriggerAuthorKind;
}

export interface FatiguePolicySpendResult {
  spendsFatigue: boolean;
  amount: 0 | 1;
  reason: FatiguePolicySpendReason;
}

export interface FatiguePolicyOverchargeInputs {
  enabled: boolean;
  peerIsMachineIntelligence: boolean;
  turnSpendsFatigue: boolean;
  recentHumanMessageCount: number;
  recentHumanParticipantCount: number;
  latestHumanMessageAgeMs?: number;
  recentHumanParticipationWindowMs: number;
  reserveResponses: number;
  hasRecentHumanParticipation: boolean;
  intent: FatiguePolicyIntent;
  hasWorkIntentWrapup: boolean;
  baseState: Exclude<FatiguePolicyState, 'overcharge_eligible'>;
}

export interface FatiguePolicyOverchargeResult {
  eligible: boolean;
  reasons: FatiguePolicyOverchargeReason[];
  blockedReasons: FatiguePolicyOverchargeBlockedReason[];
  inputs: FatiguePolicyOverchargeInputs;
}

export interface FatiguePolicyEvaluation {
  peerContactId: string;
  relationshipClass: FatiguePolicyRelationshipClass;
  channelSetting: FatiguePolicyChannelSetting;
  intent: FatiguePolicyIntent;
  softTarget: number;
  hardCap: number;
  spent: number;
  state: FatiguePolicyState;
  baseState: Exclude<FatiguePolicyState, 'overcharge_eligible'>;
  spend: FatiguePolicySpendResult;
  overcharge: FatiguePolicyOverchargeResult;
  telemetry: {
    peerIsMachineIntelligence: boolean;
    relationshipType: RelationshipType;
    trustLevel: TrustLevel;
    channelId?: string;
    channelType: FatiguePolicyChannelType;
    humanParticipantCount: number;
    machineIntelligenceParticipantCount: number;
    recentMessageCount: number;
    recentHumanMessageCount: number;
  };
}

function assertNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid fatigue policy input: ${fieldName} must be a finite integer >= 0`);
  }
  return value;
}

function trustedRelationship(relationshipType: RelationshipType): boolean {
  return relationshipType === 'ai_companion'
    || relationshipType === 'friend'
    || relationshipType === 'family'
    || relationshipType === 'partner';
}

export function resolveFatigueRelationshipClass(
  peer: FatiguePolicyPeerInput,
): FatiguePolicyRelationshipClass {
  if (!peer.isMachineIntelligence) {
    return 'non_machine_intelligence';
  }
  if (peer.relationshipType === 'stranger' || peer.trustLevel === 'public') {
    return 'stranger_mi';
  }
  if (peer.trustLevel === 'primary') {
    return 'trusted_collaborator_mi';
  }
  if (peer.trustLevel === 'trusted') {
    return trustedRelationship(peer.relationshipType)
      ? 'trusted_collaborator_mi'
      : 'collaborator_mi';
  }
  if (peer.relationshipType === 'ai_companion') {
    return 'collaborator_mi';
  }
  if (peer.relationshipType === 'friend') {
    return 'friendly_mi';
  }
  if (peer.relationshipType === 'family' || peer.relationshipType === 'partner') {
    return 'known_mi';
  }
  return 'weak_mi';
}

export function resolveFatigueChannelSetting(
  channel: FatiguePolicyChannelInput,
  config: FatiguePolicyConfig,
): FatiguePolicyChannelSetting {
  if (channel.setting) {
    return channel.setting;
  }
  if (channel.type === 'dm') {
    return 'dm';
  }

  const humanParticipantCount = Math.max(0, channel.humanParticipantCount);
  const recentMessageCount = Math.max(0, channel.recentMessageCount);
  const recentHumanMessageCount = Math.max(0, channel.recentHumanMessageCount);
  const thresholds = config.activityThresholds;
  const busyByHumans = humanParticipantCount >= thresholds.busyHumanParticipantCount;
  const busyByMessages = recentMessageCount >= thresholds.busyRecentMessageCount
    && recentHumanMessageCount > 0;

  if (busyByHumans || busyByMessages) {
    return 'busy_human_group';
  }
  if (channel.companionFocused && channel.companionHosted && humanParticipantCount === 1) {
    return 'one_human_companion_hosted';
  }
  if (
    channel.companionFocused
    && (channel.type === 'companion_room' || recentMessageCount <= thresholds.quietRecentMessageCount)
  ) {
    return 'quiet_companion_room';
  }
  if (channel.type === 'group' || channel.type === 'public_group') {
    return 'public_group';
  }
  return 'unknown';
}

function computeLimits(input: {
  config: FatiguePolicyConfig;
  relationshipClass: FatiguePolicyRelationshipClass;
  channelSetting: FatiguePolicyChannelSetting;
  intent: FatiguePolicyIntent;
}): FatiguePolicyResponseBudget {
  const relationship = input.config.relationshipBudgets[input.relationshipClass];
  const channel = input.config.channelSettingLimits[input.channelSetting];
  const intent = input.config.intentMultipliers[input.intent];
  const rawSoftTarget = Math.ceil(relationship.softTarget * intent.softTargetMultiplier);
  const rawHardCap = Math.ceil(relationship.hardCap * intent.hardCapMultiplier);
  const softTarget = Math.min(rawSoftTarget, channel.maxSoftTarget);
  const hardCap = Math.min(Math.max(rawHardCap, softTarget), channel.maxHardCap);
  return { softTarget, hardCap };
}

function computeSpend(input: EvaluateFatiguePolicyInput): FatiguePolicySpendResult {
  if (!input.peer.isMachineIntelligence) {
    return {
      spendsFatigue: false,
      amount: 0,
      reason: 'peer_not_machine_intelligence',
    };
  }
  if (input.triggerAuthorKind === 'human') {
    return {
      spendsFatigue: false,
      amount: 0,
      reason: 'human_authored_turn',
    };
  }
  if (input.triggerAuthorKind !== 'machine_intelligence') {
    return {
      spendsFatigue: false,
      amount: 0,
      reason: 'non_machine_intelligence_author',
    };
  }
  return {
    spendsFatigue: true,
    amount: 1,
    reason: 'peer_machine_intelligence_turn',
  };
}

function computeBaseState(input: {
  spent: number;
  softTarget: number;
  hardCap: number;
  config: FatiguePolicyConfig;
  fatigueApplies: boolean;
}): Exclude<FatiguePolicyState, 'overcharge_eligible'> {
  if (!input.fatigueApplies) {
    return 'normal';
  }
  if (input.spent >= input.hardCap) {
    return 'hard_exhausted';
  }
  if (input.hardCap - input.spent <= input.config.stateThresholds.wrapUpRemainingResponses) {
    return 'wrap_up_allowed';
  }
  if (input.spent >= input.softTarget) {
    return 'soft_exhausted';
  }
  if (input.softTarget - input.spent <= input.config.stateThresholds.nearingLimitRemainingResponses) {
    return 'nearing_limit';
  }
  return 'normal';
}

function computeOvercharge(input: {
  config: FatiguePolicyConfig;
  peerIsMachineIntelligence: boolean;
  spend: FatiguePolicySpendResult;
  recentHumanParticipation: FatiguePolicyRecentHumanParticipationInput;
  baseState: Exclude<FatiguePolicyState, 'overcharge_eligible'>;
  intent: FatiguePolicyIntent;
}): FatiguePolicyOverchargeResult {
  const latestHumanMessageAgeMs = input.recentHumanParticipation.latestMessageAgeMs;
  const hasKnownRecentHumanMessage = typeof latestHumanMessageAgeMs === 'number'
    && Number.isFinite(latestHumanMessageAgeMs)
    && latestHumanMessageAgeMs >= 0
    && latestHumanMessageAgeMs <= input.config.overcharge.recentHumanParticipationWindowMs;
  const hasRecentHumanParticipation = hasKnownRecentHumanMessage
    && input.recentHumanParticipation.messageCount >= input.config.overcharge.minRecentHumanMessages
    && input.recentHumanParticipation.participantCount >= input.config.overcharge.minRecentHumanParticipants;
  const hasWorkIntentWrapup = input.intent === 'work'
    || input.intent === 'research'
    || input.intent === 'problem_solving';

  const inputs: FatiguePolicyOverchargeInputs = {
    enabled: input.config.overcharge.enabled,
    peerIsMachineIntelligence: input.peerIsMachineIntelligence,
    turnSpendsFatigue: input.spend.spendsFatigue,
    recentHumanMessageCount: input.recentHumanParticipation.messageCount,
    recentHumanParticipantCount: input.recentHumanParticipation.participantCount,
    ...(latestHumanMessageAgeMs !== undefined ? { latestHumanMessageAgeMs } : {}),
    recentHumanParticipationWindowMs: input.config.overcharge.recentHumanParticipationWindowMs,
    reserveResponses: input.config.overcharge.reserveResponses,
    hasRecentHumanParticipation,
    intent: input.intent,
    hasWorkIntentWrapup,
    baseState: input.baseState,
  };

  const blockedReasons: FatiguePolicyOverchargeBlockedReason[] = [];
  if (!input.config.overcharge.enabled) {
    blockedReasons.push('overcharge_disabled');
  }
  if (!input.peerIsMachineIntelligence) {
    blockedReasons.push('peer_not_machine_intelligence');
  }
  if (!input.spend.spendsFatigue) {
    blockedReasons.push('turn_does_not_spend_fatigue');
  }
  if (input.baseState !== 'hard_exhausted') {
    blockedReasons.push('normal_allowance_not_exhausted');
  }
  if (!hasRecentHumanParticipation && !hasWorkIntentWrapup) {
    blockedReasons.push('no_qualifying_overcharge_trigger');
  }

  if (blockedReasons.length > 0) {
    return {
      eligible: false,
      reasons: [],
      blockedReasons,
      inputs,
    };
  }

  return {
    eligible: true,
    reasons: [
      ...(hasRecentHumanParticipation ? ['recent_human_participation' as const] : []),
      ...(hasWorkIntentWrapup ? ['work_intent_wrapup' as const] : []),
    ],
    blockedReasons: [],
    inputs,
  };
}

export function evaluateFatiguePolicy(input: EvaluateFatiguePolicyInput): FatiguePolicyEvaluation {
  const spent = assertNonNegativeInteger(input.spent, 'spent');
  assertNonNegativeInteger(input.channel.humanParticipantCount, 'channel.humanParticipantCount');
  assertNonNegativeInteger(input.channel.machineIntelligenceParticipantCount, 'channel.machineIntelligenceParticipantCount');
  assertNonNegativeInteger(input.channel.recentMessageCount, 'channel.recentMessageCount');
  assertNonNegativeInteger(input.channel.recentHumanMessageCount, 'channel.recentHumanMessageCount');
  assertNonNegativeInteger(input.recentHumanParticipation.messageCount, 'recentHumanParticipation.messageCount');
  assertNonNegativeInteger(input.recentHumanParticipation.participantCount, 'recentHumanParticipation.participantCount');

  const relationshipClass = resolveFatigueRelationshipClass(input.peer);
  const channelSetting = resolveFatigueChannelSetting(input.channel, input.config);
  const limits = computeLimits({
    config: input.config,
    relationshipClass,
    channelSetting,
    intent: input.intent,
  });
  const spend = computeSpend(input);
  const baseState = computeBaseState({
    spent,
    softTarget: limits.softTarget,
    hardCap: limits.hardCap,
    config: input.config,
    fatigueApplies: input.peer.isMachineIntelligence,
  });
  const overcharge = computeOvercharge({
    config: input.config,
    peerIsMachineIntelligence: input.peer.isMachineIntelligence,
    spend,
    recentHumanParticipation: input.recentHumanParticipation,
    baseState,
    intent: input.intent,
  });

  return {
    peerContactId: input.peer.contactId,
    relationshipClass,
    channelSetting,
    intent: input.intent,
    softTarget: limits.softTarget,
    hardCap: limits.hardCap,
    spent,
    state: overcharge.eligible ? 'overcharge_eligible' : baseState,
    baseState,
    spend,
    overcharge,
    telemetry: {
      peerIsMachineIntelligence: input.peer.isMachineIntelligence,
      relationshipType: input.peer.relationshipType,
      trustLevel: input.peer.trustLevel,
      ...(input.channel.channelId ? { channelId: input.channel.channelId } : {}),
      channelType: input.channel.type,
      humanParticipantCount: input.channel.humanParticipantCount,
      machineIntelligenceParticipantCount: input.channel.machineIntelligenceParticipantCount,
      recentMessageCount: input.channel.recentMessageCount,
      recentHumanMessageCount: input.channel.recentHumanMessageCount,
    },
  };
}
