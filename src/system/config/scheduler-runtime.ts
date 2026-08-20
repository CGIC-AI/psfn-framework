import {
  loadSchedulerConfig,
  type SchedulerRuntimeConfig,
} from './scheduler-config.js';

interface ResolveRuntimeSchedulerConfigOptions {
  dataDir: string;
  seedDir?: string;
}

export function resolveRuntimeSchedulerConfig(
  options: ResolveRuntimeSchedulerConfigOptions,
): SchedulerRuntimeConfig {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
  if (!options || typeof options !== 'object') {
    throw new TypeError('resolveRuntimeSchedulerConfig expects an options object argument');
  }
  if (typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0) {
    throw new TypeError('resolveRuntimeSchedulerConfig requires options.dataDir');
  }

  const persisted = loadSchedulerConfig(options.dataDir, {
    seedDir: options.seedDir,
  });

  return {
    tickIntervalMs: persisted.tickIntervalMs,
    heartbeatIntervalMs: persisted.heartbeatIntervalMs,
    backgroundMaintenance: {
      intervalMs: persisted.backgroundMaintenance.intervalMs,
      sharedWorldWikiCaretaker: {
        ...persisted.backgroundMaintenance.sharedWorldWikiCaretaker,
      },
      ambientPresence: { ...persisted.backgroundMaintenance.ambientPresence },
      concernGrooming: { ...persisted.backgroundMaintenance.concernGrooming },
    },
    artifactLifecycle: { ...persisted.artifactLifecycle },
    episodicProcessing: { ...persisted.episodicProcessing },
    nearTurnMemory: {
      direct: { ...persisted.nearTurnMemory.direct },
      group: { ...persisted.nearTurnMemory.group },
    },
    episodeSynthesis: { ...persisted.episodeSynthesis },
    sleepConsolidation: { ...persisted.sleepConsolidation },
    orientationRewrite: { ...persisted.orientationRewrite },
    reflectionNovelty: { ...persisted.reflectionNovelty },
    wikiPass: { ...persisted.wikiPass },
    arcFormation: { ...persisted.arcFormation },
    socialGraphBuilder: { ...persisted.socialGraphBuilder },
    temporalWakeup: {
      enabled: persisted.temporalWakeup.enabled,
      activeChannelLookbackHours: persisted.temporalWakeup.activeChannelLookbackHours,
      morningWake: { ...persisted.temporalWakeup.morningWake },
      idleRefresher: { ...persisted.temporalWakeup.idleRefresher },
      wakeSummary: { ...persisted.temporalWakeup.wakeSummary },
    },
    freeTime: {
      enabled: persisted.freeTime.enabled,
      minBlockIntervalMinutes: persisted.freeTime.minBlockIntervalMinutes,
      maxBlocksPerDay: persisted.freeTime.maxBlocksPerDay,
      seedText: persisted.freeTime.seedText,
      quietHours: { ...persisted.freeTime.quietHours },
      idle: { ...persisted.freeTime.idle },
      budget: { ...persisted.freeTime.budget },
      returnNote: { ...persisted.freeTime.returnNote },
    },
    weightedThoughtOutreach: {
      enabled: persisted.weightedThoughtOutreach.enabled,
      checkIntervalMs: persisted.weightedThoughtOutreach.checkIntervalMs,
      nudgeThreshold: persisted.weightedThoughtOutreach.nudgeThreshold,
      maxNudgesPerRun: persisted.weightedThoughtOutreach.maxNudgesPerRun,
      lifecycle: {
        classes: {
          time_sensitive: { ...persisted.weightedThoughtOutreach.lifecycle.classes.time_sensitive },
          standard: { ...persisted.weightedThoughtOutreach.lifecycle.classes.standard },
          trivial: { ...persisted.weightedThoughtOutreach.lifecycle.classes.trivial },
        },
        reinforcement: { ...persisted.weightedThoughtOutreach.lifecycle.reinforcement },
        accumulatedWeightCap: persisted.weightedThoughtOutreach.lifecycle.accumulatedWeightCap,
        contradictionDampeningFactor: persisted.weightedThoughtOutreach.lifecycle.contradictionDampeningFactor,
        declineDampeningFactor: persisted.weightedThoughtOutreach.lifecycle.declineDampeningFactor,
        relevanceFloor: persisted.weightedThoughtOutreach.lifecycle.relevanceFloor,
      },
    },
    socialDesire: {
      enabled: persisted.socialDesire.enabled,
      lifecycle: {
        ...persisted.socialDesire.lifecycle,
        decay: { ...persisted.socialDesire.lifecycle.decay },
        coolingOff: { ...persisted.socialDesire.lifecycle.coolingOff },
        tiers: {
          acquaintance: { ...persisted.socialDesire.lifecycle.tiers.acquaintance },
          friend: { ...persisted.socialDesire.lifecycle.tiers.friend },
          family: { ...persisted.socialDesire.lifecycle.tiers.family },
          partner: { ...persisted.socialDesire.lifecycle.tiers.partner },
          ai_companion: { ...persisted.socialDesire.lifecycle.tiers.ai_companion },
        },
      },
      outreach: {
        ...persisted.socialDesire.outreach,
        budget: { ...persisted.socialDesire.outreach.budget },
      },
    },
    intentionFollowUp: { ...persisted.intentionFollowUp },
    icpAutonomy: {
      enabled: persisted.icpAutonomy.enabled,
      candidate: { ...persisted.icpAutonomy.candidate },
      permit: { ...persisted.icpAutonomy.permit },
      policyHolds: { ...persisted.icpAutonomy.policyHolds },
      availability: { ...persisted.icpAutonomy.availability },
    },
    backgroundWork: {
      supervisor: { ...persisted.backgroundWork.supervisor },
      postTurn: { ...persisted.backgroundWork.postTurn },
    },
    socialAutonomy: {
      passiveNameCandidate: { ...persisted.socialAutonomy.passiveNameCandidate },
      appraiser: { ...persisted.socialAutonomy.appraiser },
      reservationPhase: { ...persisted.socialAutonomy.reservationPhase },
      egressLease: { ...persisted.socialAutonomy.egressLease },
      freeTimeChooser: { ...persisted.socialAutonomy.freeTimeChooser },
    },
    ...(persisted.backgroundWorkWelfare
      ? { backgroundWorkWelfare: { ...persisted.backgroundWorkWelfare } }
      : {}),
    ...(persisted.toolUsageEvaluator
      ? { toolUsageEvaluator: { ...persisted.toolUsageEvaluator } }
      : {}),
    ...(persisted.introspectionAudit
      ? { introspectionAudit: { ...persisted.introspectionAudit } }
      : {}),
  };
}
