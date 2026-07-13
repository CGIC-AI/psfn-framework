export const CHARGE_POLICY_FILE_NAME = 'charge-policy.json';
export const CHARGE_POLICY_SEED_FILE_NAME = 'charge-policy.seed.json';

export const CHARGE_POLICY_RUNTIME_LANE_VALUES = [
  'interactive',
  'companion_social',
  'background',
  'maintenance',
  'subagent',
  'shard',
] as const;

export const CHARGE_POLICY_SURFACE_VALUES = [
  'ownerFileInspection',
  'localFilesystem',
  'memoryRead',
  'memoryWrite',
  'localEmbedding',
  'externalEmbedding',
  'localImageGeneration',
  'paidImageGeneration',
  'analysisWorkbenchExtensionBand',
  'subagentLaunch',
  'shardLaunch',
  'externalModelConsult',
  'moaRoundBase',
  'companionSocialContinuation',
] as const;

export const FATIGUE_CONTINUATION_EVIDENCE_VALUES = [
  'recent_human_participation',
  'active_work_or_research',
  'explicit_peer_invitation',
] as const;

export const FATIGUE_REGULATION_STATE_VALUES = [
  'normal',
  'conversation_maturing',
  'nearing_soft_allowance',
  'charge_lane_active',
  'wrap_up_allowed',
  'hard_exhausted',
  'overcharge_closeout',
  'final_closeout',
  'suppressed',
] as const;

export const CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES = [
  'local',
  'subscription',
  'cheap_cloud',
  'premium_cloud',
] as const;

export const FATIGUE_POLICY_RELATIONSHIP_VALUES = [
  'non_machine_intelligence',
  'stranger_mi',
  'weak_mi',
  'known_mi',
  'friendly_mi',
  'collaborator_mi',
  'trusted_collaborator_mi',
] as const;

export const FATIGUE_POLICY_CHANNEL_SETTING_VALUES = [
  'unknown',
  'busy_human_group',
  'public_group',
  'one_human_companion_hosted',
  'quiet_companion_room',
  'dm',
] as const;

export const FATIGUE_POLICY_INTENT_VALUES = [
  'casual',
  'social',
  'check_in',
  'work',
  'research',
  'problem_solving',
] as const;

export const FATIGUE_POLICY_STATE_VALUES = [
  'normal',
  'nearing_limit',
  'soft_exhausted',
  'wrap_up_allowed',
  'hard_exhausted',
  'overcharge_eligible',
] as const;

export type ChargePolicyRuntimeLane = (typeof CHARGE_POLICY_RUNTIME_LANE_VALUES)[number];
export type ChargePolicySurface = (typeof CHARGE_POLICY_SURFACE_VALUES)[number];
export type ChargePolicyReferenceModelClass = (typeof CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES)[number];
export type FatiguePolicyRelationshipClass = (typeof FATIGUE_POLICY_RELATIONSHIP_VALUES)[number];
export type FatiguePolicyChannelSetting = (typeof FATIGUE_POLICY_CHANNEL_SETTING_VALUES)[number];
export type FatiguePolicyIntent = (typeof FATIGUE_POLICY_INTENT_VALUES)[number];
export type FatiguePolicyState = (typeof FATIGUE_POLICY_STATE_VALUES)[number];
export type FatigueContinuationEvidence = (typeof FATIGUE_CONTINUATION_EVIDENCE_VALUES)[number];
export type FatigueRegulationState = (typeof FATIGUE_REGULATION_STATE_VALUES)[number];

export type ChargePolicyRationaleMap<T extends string> = Partial<Record<T, string>>;

export interface FatiguePolicyResponseBudget {
  softTarget: number;
  hardCap: number;
}

export interface FatiguePolicyChannelSettingLimit {
  maxSoftTarget: number;
  maxHardCap: number;
}

export interface FatiguePolicyIntentMultiplier {
  softTargetMultiplier: number;
  hardCapMultiplier: number;
}

export interface FatiguePolicyActivityThresholds {
  busyRecentMessageCount: number;
  busyHumanParticipantCount: number;
  quietRecentMessageCount: number;
}

export interface FatiguePolicyStateThresholds {
  nearingLimitRemainingResponses: number;
  wrapUpRemainingResponses: number;
}

export interface FatiguePolicyOverchargeConfig {
  enabled: boolean;
  reserveResponses: number;
  recentHumanParticipationWindowMs: number;
  minRecentHumanMessages: number;
  minRecentHumanParticipants: number;
}

export interface FatigueSocialRegulationConfig {
  /** Recent relationship activity decays continuously instead of resetting at UTC midnight. */
  relationshipPressureHalfLifeMs: number;
  /** Bounded history horizon used to keep local ledger reads finite. */
  relationshipPressureWindowMs: number;
  /** Pending pre-model reservations older than this stop blocking new work. */
  reservationTtlMs: number;
  /** Fraction of the soft allowance at which prompt-visible maturation begins. */
  conversationMaturingRatio: number;
  /** Charge-policy units spent by an MI continuation after the soft allowance. */
  marginalChargeUnits: number;
  /** Initiation pressure added by a declined invitation before elapsed-time decay. */
  declinedPressureUnits: number;
  /** Initiation pressure added by a deferred invitation before elapsed-time decay. */
  deferredPressureUnits: number;
  /** Initiation pressure added while an invitation remains unanswered. */
  unansweredPressureUnits: number;
}

export interface FatiguePolicyConfig {
  relationshipBudgets: Record<FatiguePolicyRelationshipClass, FatiguePolicyResponseBudget>;
  channelSettingLimits: Record<FatiguePolicyChannelSetting, FatiguePolicyChannelSettingLimit>;
  intentMultipliers: Record<FatiguePolicyIntent, FatiguePolicyIntentMultiplier>;
  activityThresholds: FatiguePolicyActivityThresholds;
  stateThresholds: FatiguePolicyStateThresholds;
  overcharge: FatiguePolicyOverchargeConfig;
  socialRegulation: FatigueSocialRegulationConfig;
}

export interface ChargePolicyConfig {
  schemaVersion: 1;
  runChargeQuotaByLane: Record<ChargePolicyRuntimeLane, number>;
  surfaceCosts: Record<ChargePolicySurface, number>;
  surfaceRationales?: ChargePolicyRationaleMap<ChargePolicySurface>;
  moa: {
    perRoundMultiplierByReferenceModelClass: Record<ChargePolicyReferenceModelClass, number>;
  };
  referenceModelClassPricing: Record<ChargePolicyReferenceModelClass, number>;
  referenceModelClassPricingRationales?: ChargePolicyRationaleMap<ChargePolicyReferenceModelClass>;
  fatigue: FatiguePolicyConfig;
}
