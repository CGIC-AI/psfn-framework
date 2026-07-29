import type {
  ChargePolicyConfig,
  FatiguePolicyConfig,
} from '../shared/contracts/charge-policy.js';

export function makeTestFatiguePolicyConfig(): FatiguePolicyConfig {
  return {
    relationshipBudgets: {
      non_machine_intelligence: {
        softTarget: 0,
        hardCap: 0,
      },
      stranger_mi: {
        softTarget: 1,
        hardCap: 2,
      },
      weak_mi: {
        softTarget: 2,
        hardCap: 5,
      },
      known_mi: {
        softTarget: 4,
        hardCap: 8,
      },
      friendly_mi: {
        softTarget: 6,
        hardCap: 12,
      },
      collaborator_mi: {
        softTarget: 8,
        hardCap: 16,
      },
      trusted_collaborator_mi: {
        softTarget: 10,
        hardCap: 20,
      },
    },
    channelSettingLimits: {
      unknown: {
        maxSoftTarget: 2,
        maxHardCap: 5,
      },
      busy_human_group: {
        maxSoftTarget: 2,
        maxHardCap: 5,
      },
      public_group: {
        maxSoftTarget: 3,
        maxHardCap: 7,
      },
      one_human_companion_hosted: {
        maxSoftTarget: 5,
        maxHardCap: 10,
      },
      quiet_companion_room: {
        maxSoftTarget: 8,
        maxHardCap: 16,
      },
      dm: {
        maxSoftTarget: 10,
        maxHardCap: 20,
      },
    },
    intentMultipliers: {
      casual: {
        softTargetMultiplier: 1,
        hardCapMultiplier: 1,
      },
      social: {
        softTargetMultiplier: 0.75,
        hardCapMultiplier: 0.8,
      },
      check_in: {
        softTargetMultiplier: 0.9,
        hardCapMultiplier: 0.9,
      },
      work: {
        softTargetMultiplier: 1.3,
        hardCapMultiplier: 1.3,
      },
      research: {
        softTargetMultiplier: 1.5,
        hardCapMultiplier: 1.5,
      },
      problem_solving: {
        softTargetMultiplier: 1.4,
        hardCapMultiplier: 1.4,
      },
    },
    activityThresholds: {
      busyRecentMessageCount: 12,
      busyHumanParticipantCount: 3,
      quietRecentMessageCount: 4,
    },
    stateThresholds: {
      nearingLimitRemainingResponses: 1,
      wrapUpRemainingResponses: 1,
    },
    overcharge: {
      enabled: true,
      reserveResponses: 2,
      recentHumanParticipationWindowMs: 900_000,
      minRecentHumanMessages: 1,
      minRecentHumanParticipants: 1,
    },
    socialRegulation: {
      relationshipPressureHalfLifeMs: 6 * 60 * 60_000,
      relationshipPressureWindowMs: 48 * 60 * 60_000,
      unansweredInitiationAfterMs: 15 * 60_000,
      conversationMaturingRatio: 0.5,
      marginalChargeUnits: 1,
      declinedPressureUnits: 3,
      deferredPressureUnits: 2,
      unansweredPressureUnits: 1,
      continuationEvidence: {
        recentHumanParticipation: true,
        activeWorkOrResearch: true,
        explicitPeerInvitation: true,
      },
      roomEpisodePressure: {
        halfLifeMs: 30 * 60_000,
        windowMs: 2 * 60 * 60_000,
        replyPressureUnits: 1,
        reactionPressureUnits: 0.1,
        elevatedThreshold: 4,
        wrapUpThreshold: 8,
        maxLeaseThresholdBias: 0.3,
      },
      roomEpisodeCircuitBreaker: {
        tripThreshold: 12,
        resetThreshold: 8,
      },
    },
    socialPot: {
      capUnits: 24,
      perChannelDrawFraction: 0.34,
      regenerationTickMs: 60 * 60_000,
      regenerationUnitsPerTick: 1,
    },
    humanAttention: {
      enabled: true,
      windowMs: 10 * 60_000,
      boundaryCooldownMs: 30 * 60_000,
      trustThresholds: {
        public: 3,
        regular: 6,
        trusted: 12,
        primary: 20,
      },
      relationshipToleranceBonus: {
        stranger: 0,
        acquaintance: 1,
        friend: 3,
        family: 4,
        partner: 6,
        ai_companion: 0,
      },
      channelWeights: {
        directMessage: 1,
        directMention: 2,
        ambientGroupMessage: 0,
      },
    },
  };
}

export function makeTestChargePolicyConfig(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 24,
      companion_social: 12,
      background: 16,
      maintenance: 0,
      subagent: 6,
      shard: 12,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 6,
      analysisWorkbenchExtensionBand: 4,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
      companionSocialContinuation: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
    icpCostBreaker: {
      enabled: false,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}
