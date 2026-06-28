import type { FatiguePolicyConfig } from '../shared/contracts/charge-policy.js';

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
      recentHumanParticipationWindowMs: 900_000,
      minRecentHumanMessages: 1,
      minRecentHumanParticipants: 1,
    },
  };
}
