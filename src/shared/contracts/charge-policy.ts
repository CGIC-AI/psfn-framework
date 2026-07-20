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

export const HUMAN_ATTENTION_TRUST_LEVEL_VALUES = [
  'public',
  'regular',
  'trusted',
  'primary',
] as const;

export const HUMAN_ATTENTION_RELATIONSHIP_VALUES = [
  'stranger',
  'acquaintance',
  'friend',
  'family',
  'partner',
  'ai_companion',
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

export const ICP_COST_PURPOSE_VALUES = [
  'conversation_turn',
  'tool',
  'summary',
  'extraction',
  'sidecar',
] as const;
export type IcpCostPurpose = (typeof ICP_COST_PURPOSE_VALUES)[number];

export type IcpCostBreakerConfig =
  | {
      /** Disabled until an owner selects thresholds from verified prices and observed usage. */
      enabled: false;
    }
  | {
      enabled: true;
      /** Ordinary ICP work may not reserve into this threshold's closeout band. */
      warningThresholdUsd: number;
      /** Absolute projected conversation ceiling; no importance signal can bypass it. */
      hardLimitUsd: number;
      /** Exact hard-limit band reserved for fatigue-authorized final closeout turns. */
      finalCloseoutReserveUsd: number;
      /** Pending reservations older than this remain charged but project as stale for operators. */
      pendingReservationStaleAfterMs: number;
      /** Explicit owner declaration of which canonical ICP work classes share the ceiling. */
      includedCostPurposes: Record<IcpCostPurpose, boolean>;
    };

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

/**
 * Per-channel aggregate machine-pressure pacing (design bible §12.2, adjudication
 * decision 8). This is **non-monetary**: it shapes conversation (raises the
 * autonomous-lease bar, invites wrap-up) but is never spent — the social pot is
 * money, room-episode pressure is pacing. It is per-channel, so two rooms are
 * independent, and it is derived from the same durable fatigue ledger rather
 * than an arbiter-local store. Human-triggered turns contribute zero (they are
 * never recorded as charged machine turns), preserving the human-uncharged
 * invariant.
 */
export interface FatigueRoomEpisodePressureConfig {
  /** Continuous decay half-life for aggregate per-channel machine pressure. */
  halfLifeMs: number;
  /** Bounded history horizon used to keep per-channel ledger reads finite (>= halfLifeMs). */
  windowMs: number;
  /** Pressure contributed by one machine reply before elapsed-time decay. */
  replyPressureUnits: number;
  /** Pressure contributed by one machine reaction before decay (near-zero, <= replyPressureUnits). */
  reactionPressureUnits: number;
  /** Pressure at which the autonomous-lease confidence bar begins to rise. */
  elevatedThreshold: number;
  /** Pressure at which graceful wrap-up is invited (> elevatedThreshold). */
  wrapUpThreshold: number;
  /** Maximum additive lease-confidence bias applied at/above the wrap-up threshold. */
  maxLeaseThresholdBias: number;
}

/**
 * Law 36 hard-suppression circuit breaker (charter §8.11 "Soft Guidance Before
 * Behavioral Circuit Breakers"; design bible §12.2/§20.2 "hard suppression
 * remains the final safety mechanism"). This is the operational fallback that
 * sits ABOVE the room-episode pressure ladder: soft pressure raises the lease
 * bar and invites graceful wrap-up first, and only a runaway room that keeps
 * flooding *past* the wrap-up band trips the breaker and suppresses the next
 * autonomous speaking lease. It is proportionate (the narrowest interruption:
 * one autonomous lease, never human turns, never room history) and its state is
 * derived from the same decaying pressure, so recovery is automatic.
 */
export interface FatigueRoomEpisodeCircuitBreakerConfig {
  /**
   * Aggregate room-episode pressure at which the breaker trips and suppresses
   * the next autonomous lease. Must sit strictly ABOVE
   * `roomEpisodePressure.wrapUpThreshold` (charter §8.11: a circuit breaker is
   * set above ordinary healthy use), so graceful wrap-up is always invited
   * before hard suppression — no abrupt tap-out.
   */
  tripThreshold: number;
  /**
   * Pressure at or below which a tripped breaker releases into its half-open
   * probe window, then closes. Must satisfy `0 < resetThreshold < tripThreshold`
   * so the hysteresis band prevents the breaker from flapping open/closed on
   * pressure jitter. Recovery follows the continuous pressure decay; no calendar
   * reset is involved.
   */
  resetThreshold: number;
}

export interface FatigueSocialRegulationConfig {
  /** Recent relationship activity decays continuously instead of resetting at UTC midnight. */
  relationshipPressureHalfLifeMs: number;
  /** Bounded history horizon used to keep local ledger reads finite. */
  relationshipPressureWindowMs: number;
  /** Age after which an unanswered invitation contributes relationship pressure. */
  unansweredInitiationAfterMs: number;
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
  /** Owner-selected structured facts that may justify a bounded continuation. */
  continuationEvidence: {
    recentHumanParticipation: boolean;
    activeWorkOrResearch: boolean;
    explicitPeerInvitation: boolean;
  };
  /** Per-channel aggregate machine-pressure pacing (non-monetary; §12.2). */
  roomEpisodePressure: FatigueRoomEpisodePressureConfig;
  /** Law 36 hard-suppression breaker layered above the pressure ladder (§8.11). */
  roomEpisodeCircuitBreaker: FatigueRoomEpisodeCircuitBreakerConfig;
}

export interface FatigueSocialPotConfig {
  /** Full per-companion social pot ceiling, in charge-policy units. */
  capUnits: number;
  /**
   * Bounded fraction (0 < x <= 1) of the pot remaining at draw time that any
   * one channel may draw (~1/3), so one busy room cannot starve the others.
   */
  perChannelDrawFraction: number;
  /**
   * Interval between continuous regeneration ticks that replace the daily
   * reset cliff (hourly).
   */
  regenerationTickMs: number;
  /**
   * Units credited to the pot per regeneration tick (cap/24), clamped so the
   * pot never exceeds capUnits.
   */
  regenerationUnitsPerTick: number;
}

/**
 * Human-authored attention pressure is a consent/moderation signal, not an
 * MI-loop fatigue budget. Reaching a threshold may add internal context to the
 * ordinary turn; it never suppresses the human or emits canned outward text.
 */
export interface HumanAttentionPressureConfig {
  enabled: boolean;
  windowMs: number;
  boundaryCooldownMs: number;
  trustThresholds: Record<
    (typeof HUMAN_ATTENTION_TRUST_LEVEL_VALUES)[number],
    number
  >;
  relationshipToleranceBonus: Record<
    (typeof HUMAN_ATTENTION_RELATIONSHIP_VALUES)[number],
    number
  >;
  channelWeights: {
    directMessage: number;
    directMention: number;
    ambientGroupMessage: number;
  };
}

export interface FatiguePolicyConfig {
  relationshipBudgets: Record<FatiguePolicyRelationshipClass, FatiguePolicyResponseBudget>;
  channelSettingLimits: Record<FatiguePolicyChannelSetting, FatiguePolicyChannelSettingLimit>;
  intentMultipliers: Record<FatiguePolicyIntent, FatiguePolicyIntentMultiplier>;
  activityThresholds: FatiguePolicyActivityThresholds;
  stateThresholds: FatiguePolicyStateThresholds;
  overcharge: FatiguePolicyOverchargeConfig;
  socialRegulation: FatigueSocialRegulationConfig;
  socialPot: FatigueSocialPotConfig;
  humanAttention: HumanAttentionPressureConfig;
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
  icpCostBreaker: IcpCostBreakerConfig;
  fatigue: FatiguePolicyConfig;
}
