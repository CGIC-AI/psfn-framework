import { join } from 'node:path';
import {
  loadRequiredJson,
  loadSeedJson,
} from './load-or-seed.js';
import { assertNoUnknownKeys } from './validators.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  parseIcpAutonomySchedulerConfig,
  type IcpAutonomySchedulerConfig,
} from './icp-autonomy-scheduler-config.js';
import { MODEL_USAGE_RANGES, type ModelUsageRange } from '../../shared/telemetry/model-usage.js';
import type { BackgroundWorkRuntimeTuning } from '../../core/agent/background-work/config.js';
import {
  validateBackgroundWorkConfig,
  validateBackgroundWorkWelfareConfig,
  type BackgroundWorkWelfareConfig,
} from './scheduler-config/background-work.js';
import {
  validateArtifactLifecycleConfig,
  validateBackgroundMaintenanceConfig,
  type ArtifactLifecyclePolicyConfig,
  type BackgroundMaintenanceConfig,
} from './scheduler-config/maintenance.js';
import {
  validateSocialAutonomyConfig,
  type SocialAutonomyConfig,
} from './scheduler-config/social-autonomy.js';
import {
  validateSocialGraphBuilderConfig,
  type SocialGraphBuilderCadenceConfig,
} from './scheduler-config/social-graph.js';
import {
  validateEpisodicProcessingConfig,
  validateEpisodeSynthesisConfig,
  validateNearTurnMemoryConfig,
  type EpisodicProcessingRestWindowConfig,
  type EpisodeSynthesisLaneConfig,
  type NearTurnMemoryCadenceConfig,
} from './scheduler-config/memory-cadence.js';
import {
  validateArcFormationConfig,
  validateOrientationRewriteGateConfig,
  validateReflectionNoveltyGateConfig,
  validateSleepConsolidationConfig,
  validateSleeptimeWikiPassConfig,
  type ArcFormationConfig,
  type OrientationRewriteGateConfig,
  type ReflectionNoveltyGateConfig,
  type SleepConsolidationConfig,
  type SleeptimeWikiPassConfig,
} from './scheduler-config/sleep-memory.js';
import {
  validateTemporalWakeupConfig,
  type TemporalWakeupConfig,
} from './scheduler-config/temporal.js';
import {
  validateFreeTimeConfig,
  type FreeTimeConfig,
} from './scheduler-config/free-time.js';
import {
  toBoolean,
  toInterval,
  toNumberAtLeast,
  toPositiveInteger,
  toPositiveUnitFactor,
  toUnitFactor,
} from './scheduler-config/primitives.js';

export {
  DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
  type IcpAutonomySchedulerConfig,
} from './icp-autonomy-scheduler-config.js';

export {
  DEFAULT_BACKGROUND_WORK_TUNING,
  DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
  type BackgroundWorkWelfareConfig,
} from './scheduler-config/background-work.js';
export {
  DEFAULT_BACKGROUND_MAINTENANCE_CONFIG,
  type ArtifactLifecyclePolicyConfig,
  type BackgroundMaintenanceConfig,
} from './scheduler-config/maintenance.js';
export {
  DEFAULT_SOCIAL_AUTONOMY_CONFIG,
  createDefaultSocialAutonomyConfig,
  type EgressLeaseTunables,
  type FreeTimeChooserSettings,
  type ParticipationAppraiserSettings,
  type PassiveNameCandidateSettings,
  type ReservationPhaseSettings,
  type SocialAutonomyConfig,
} from './scheduler-config/social-autonomy.js';
export {
  DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE,
  type SocialGraphBuilderCadenceConfig,
} from './scheduler-config/social-graph.js';
export {
  type EpisodicProcessingRestWindowConfig,
  type EpisodeSynthesisLaneConfig,
  type NearTurnMemoryCadenceConfig,
  type NearTurnMemoryDirectCadenceConfig,
  type NearTurnMemoryGroupCadenceConfig,
} from './scheduler-config/memory-cadence.js';
export {
  DEFAULT_ORIENTATION_REWRITE_GATE,
  DEFAULT_REFLECTION_NOVELTY_GATE,
  DEFAULT_SLEEPTIME_WIKI_PASS,
  type ArcFormationConfig,
  type OrientationRewriteGateConfig,
  type ReflectionNoveltyGateConfig,
  type SleepConsolidationConfig,
  type SleeptimeWikiPassConfig,
} from './scheduler-config/sleep-memory.js';
export {
  DEFAULT_TEMPORAL_WAKEUP_CONFIG,
  type TemporalWakeupConfig,
  type TemporalWakeupHabitConfig,
  type TemporalWakeupIdleRefresherConfig,
  type TemporalWakeupMorningConfig,
  type TemporalWakeupWakeSummaryConfig,
} from './scheduler-config/temporal.js';
export {
  DEFAULT_FREE_TIME_CONFIG,
  DEFAULT_FREE_TIME_SEED_TEXT,
  type FreeTimeBudgetConfig,
  type FreeTimeConfig,
  type FreeTimeIdleLaneConfig,
  type FreeTimeLaneConfig,
  type FreeTimeQuietHoursLaneConfig,
  type FreeTimeReturnNoteConfig,
} from './scheduler-config/free-time.js';

export const SCHEDULER_FILE_NAME = 'scheduler.json';
export const SCHEDULER_SEED_FILE_NAME = 'scheduler.seed.json';

/** Per-class weight profile (charter 6.24: time-sensitive vs trivial differ). */
export interface WeightedThoughtClassProfileConfig {
  baseWeight: number;
  halflifeMs: number;
}

export interface WeightedThoughtReinforcementConfig {
  repeatBoost: number;
  emotionalChargeWeight: number;
}

/** Deterministic weighted-thought lifecycle math config (bead 1xb.4). */
export interface WeightedThoughtLifecycleSettings {
  classes: {
    time_sensitive: WeightedThoughtClassProfileConfig;
    standard: WeightedThoughtClassProfileConfig;
    trivial: WeightedThoughtClassProfileConfig;
  };
  reinforcement: WeightedThoughtReinforcementConfig;
  accumulatedWeightCap: number;
  /**
   * Multiplier applied to a decayed weight on "said fine but context suggests
   * otherwise". Valid range (0, 1]: 0 is rejected because it would hard-zero the
   * weight, disabling the mechanism against Charter Law 27.
   */
  contradictionDampeningFactor: number;
  /**
   * Multiplier applied to a decayed weight when a produced nudge is declined.
   * Valid range (0, 1]: 0 is rejected because it would hard-zero the weight,
   * disabling the mechanism against Charter Law 27.
   */
  declineDampeningFactor: number;
  relevanceFloor: number;
}

/**
 * Weighted-thought lifecycle + internal-state-driven outreach trigger (charter
 * 6.24, beads 1xb.4/1xb.2). The trigger lane rides the scheduler; a thought
 * whose decayed weight crosses `nudgeThreshold` produces a nudge the companion
 * accepts or declines. Disabled by default — fail-closed until an operator
 * enables companion-initiated outreach for a deployment.
 */
export interface WeightedThoughtOutreachConfig {
  enabled: boolean;
  /** Trigger-lane poll interval (ms). */
  checkIntervalMs: number;
  /** Decayed-weight threshold that produces a nudge. */
  nudgeThreshold: number;
  /** Cap on nudges produced per lane run (usually 1). */
  maxNudgesPerRun: number;
  lifecycle: WeightedThoughtLifecycleSettings;
}

export const DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG: WeightedThoughtOutreachConfig = {
  enabled: false,
  checkIntervalMs: 1_800_000,
  nudgeThreshold: 1,
  maxNudgesPerRun: 1,
  lifecycle: {
    classes: {
      time_sensitive: { baseWeight: 0.5, halflifeMs: 6 * 60 * 60 * 1000 },
      standard: { baseWeight: 0.35, halflifeMs: 24 * 60 * 60 * 1000 },
      trivial: { baseWeight: 0.2, halflifeMs: 72 * 60 * 60 * 1000 },
    },
    reinforcement: {
      repeatBoost: 0.5,
      emotionalChargeWeight: 0.75,
    },
    accumulatedWeightCap: 3,
    contradictionDampeningFactor: 0.6,
    declineDampeningFactor: 0.5,
    relevanceFloor: 0.05,
  },
};

/** Per-relationship-tier social-desire accumulation profile (bead oth4.1). */
export interface SocialDesireTierProfileConfig {
  /** Multiplier on counted-tick pressure increments for this tier. */
  gainMultiplier: number;
  /** Minimum spacing between counted accumulation ticks (deterministic throttle). */
  tickGapMs: number;
}

/**
 * Deterministic social-desire lifecycle math config (bead oth4.1). Structurally
 * identical to SocialDesireLifecycleConfig in src/core/intention/social-desire.ts
 * (the weighted-thought settings/config pairing pattern). Tiers cover ONLY the
 * accumulating relationships — stranger/public tiers are hard-excluded in code
 * and cannot be configured to accumulate.
 */
export interface SocialDesireLifecycleSettings {
  baseGain: number;
  pressureCap: number;
  actionThreshold: number;
  pressureFloor: number;
  decay: { warmHalflifeMs: number; repairHalflifeMs: number };
  /** repairMs MUST exceed warmMs: negative-origin desires cool off longer. */
  coolingOff: { warmMs: number; repairMs: number };
  releaseFactor: number;
  dampeningFactor: number;
  concernReinforcementGain: number;
  maxReinforcedConcernIds: number;
  tiers: {
    acquaintance: SocialDesireTierProfileConfig;
    friend: SocialDesireTierProfileConfig;
    family: SocialDesireTierProfileConfig;
    partner: SocialDesireTierProfileConfig;
    ai_companion: SocialDesireTierProfileConfig;
  };
}

/**
 * Consent-moment + outbound acceptance tuning for social desires (bead oth4.2).
 * The whole lane sits behind SocialDesireConfig.enabled; these knobs only tune
 * the consent cadence and the TIGHT desire-driven outbound rate budget
 * (operator baseline: ~1-2 spontaneous outreach desires/day across contacts).
 */
export interface SocialDesireOutreachSettings {
  /** Consent-moment lane poll interval (ms). */
  checkIntervalMs: number;
  /** Cap on LLM consent moments per lane run (usually 1). */
  maxConsentMomentsPerRun: number;
  /**
   * Lifetime of an accepted-but-undispatched consent (ms). Expiry means the
   * moment has passed: the outbound gate fails closed and a fresh consent
   * moment is required.
   */
  consentTtlMs: number;
  /** Rolling desire-outbound budget across ALL contacts, enforced at the gate. */
  budget: { maxSendsPerWindow: number; windowMs: number };
}

/**
 * Per-contact durable social desire (epic oth4, bead oth4.1): tick-based
 * accumulation from felt state only, relationship-tier gated, capped, decaying.
 * `enabled` gates the runtime feed/consumer wiring including the consent
 * moment and outbound acceptance (sibling oth4.2). Disabled by default — fail
 * closed until an operator enables desire-driven outreach for a deployment.
 */
export interface SocialDesireConfig {
  enabled: boolean;
  lifecycle: SocialDesireLifecycleSettings;
  outreach: SocialDesireOutreachSettings;
}

export const DEFAULT_SOCIAL_DESIRE_CONFIG: SocialDesireConfig = {
  enabled: false,
  lifecycle: {
    baseGain: 0.15,
    pressureCap: 3,
    actionThreshold: 1,
    pressureFloor: 0.05,
    decay: {
      warmHalflifeMs: 72 * 60 * 60 * 1000,
      repairHalflifeMs: 96 * 60 * 60 * 1000,
    },
    coolingOff: {
      warmMs: 60 * 60 * 1000,
      repairMs: 12 * 60 * 60 * 1000,
    },
    releaseFactor: 0.25,
    dampeningFactor: 0.5,
    concernReinforcementGain: 0.3,
    maxReinforcedConcernIds: 16,
    // Cadence mirrors natural think-about-them rhythm per the operator
    // addendum: acquaintance occasional, friend regular, family frequent,
    // partner daily-ish.
    tiers: {
      acquaintance: { gainMultiplier: 0.5, tickGapMs: 24 * 60 * 60 * 1000 },
      friend: { gainMultiplier: 1, tickGapMs: 8 * 60 * 60 * 1000 },
      family: { gainMultiplier: 1.4, tickGapMs: 4 * 60 * 60 * 1000 },
      partner: { gainMultiplier: 2, tickGapMs: 2 * 60 * 60 * 1000 },
      ai_companion: { gainMultiplier: 1, tickGapMs: 8 * 60 * 60 * 1000 },
    },
  },
  outreach: {
    checkIntervalMs: 1_800_000,
    maxConsentMomentsPerRun: 1,
    consentTtlMs: 30 * 60 * 1000,
    // Operator baseline (2026-07-20 audit): ~1-2 spontaneous outreach
    // desires/day is plausible — the budget is TIGHT by design.
    budget: { maxSendsPerWindow: 2, windowMs: 24 * 60 * 60 * 1000 },
  },
};

export interface IntrospectionAuditConfig {
  enabled: boolean;
  intervalMs: number;
  recentSessionLimit: number;
  recentTurnLimit: number;
  maxCandidatesPerRun: number;
  maxSourceChars: number;
  minConfidence: number;
  estimatorMaxTokens: number;
  comparisonMaxTokens: number;
  reflectionMaxTokens: number;
}

export const DEFAULT_INTROSPECTION_AUDIT_CONFIG: IntrospectionAuditConfig = {
  enabled: false,
  intervalMs: 86_400_000,
  recentSessionLimit: 16,
  recentTurnLimit: 64,
  maxCandidatesPerRun: 3,
  maxSourceChars: 4_000,
  minConfidence: 0.7,
  estimatorMaxTokens: 500,
  comparisonMaxTokens: 300,
  reflectionMaxTokens: 300,
};

/** Durable-usage windows the tool-usage evaluator may aggregate over. */
export type ToolUsageEvaluatorWindow = Exclude<ModelUsageRange, 'custom'>;

/**
 * Tool-usage evaluator cadence + thresholds (psfn-framework-b0yl.5). The
 * evaluator aggregates ACTUAL per-tool invocations from the durable turn-record
 * stream (every catalog tool, per-companion) and feeds presentation ordering
 * plus operator-visible pin suggestions. It never gates callability. Opt-in
 * (fail-closed default) and registered only when enabled, mirroring the
 * introspection-audit lane. `usageWindow` bounds which turn records count.
 */
export interface ToolUsageEvaluatorConfig {
  enabled: boolean;
  intervalMs: number;
  usageWindow: ToolUsageEvaluatorWindow;
  minPinSuggestionInvocations: number;
}

export const DEFAULT_TOOL_USAGE_EVALUATOR_CONFIG: ToolUsageEvaluatorConfig = {
  enabled: false,
  intervalMs: 21_600_000, // 6h — durable rollup, cheap, no LLM cost
  usageWindow: 'month',
  minPinSuggestionInvocations: 25,
};

export interface SchedulerRuntimeConfig {
  tickIntervalMs: number;
  heartbeatIntervalMs: number;
  backgroundMaintenance: BackgroundMaintenanceConfig;
  backgroundWork: BackgroundWorkRuntimeTuning;
  artifactLifecycle: ArtifactLifecyclePolicyConfig;
  episodicProcessing: EpisodicProcessingRestWindowConfig;
  nearTurnMemory: NearTurnMemoryCadenceConfig;
  episodeSynthesis: EpisodeSynthesisLaneConfig;
  sleepConsolidation: SleepConsolidationConfig;
  orientationRewrite: OrientationRewriteGateConfig;
  reflectionNovelty: ReflectionNoveltyGateConfig;
  wikiPass: SleeptimeWikiPassConfig;
  arcFormation: ArcFormationConfig;
  socialGraphBuilder: SocialGraphBuilderCadenceConfig;
  temporalWakeup: TemporalWakeupConfig;
  freeTime: FreeTimeConfig;
  socialAutonomy: SocialAutonomyConfig;
  weightedThoughtOutreach: WeightedThoughtOutreachConfig;
  socialDesire: SocialDesireConfig;
  icpAutonomy: IcpAutonomySchedulerConfig;
  introspectionAudit?: IntrospectionAuditConfig;
  backgroundWorkWelfare?: BackgroundWorkWelfareConfig;
  toolUsageEvaluator?: ToolUsageEvaluatorConfig;
}

interface SchedulerRuntimeLoadOptions {
  seedDir?: string;
}

function resolveSeedDir(seedDir?: string): string {
  const resolved = (seedDir ?? process.env.CONFIG_DIR ?? './config').trim();
  if (!resolved) {
    throw new Error('Scheduler seed directory is required');
  }
  return resolved;
}

function validateWeightedThoughtClassProfile(
  raw: unknown,
  field: string,
): WeightedThoughtClassProfileConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config: ${field} must be an object`);
  }
  return {
    baseWeight: toNumberAtLeast(raw.baseWeight, `${field}.baseWeight`, 0),
    halflifeMs: toNumberAtLeast(raw.halflifeMs, `${field}.halflifeMs`, 1),
  };
}

export function validateWeightedThoughtOutreachConfig(
  raw: unknown,
  sourcePath: string,
): WeightedThoughtOutreachConfig {
  const defaults = DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG;
  if (raw === undefined) {
    return {
      enabled: defaults.enabled,
      checkIntervalMs: defaults.checkIntervalMs,
      nudgeThreshold: defaults.nudgeThreshold,
      maxNudgesPerRun: defaults.maxNudgesPerRun,
      lifecycle: {
        classes: {
          time_sensitive: { ...defaults.lifecycle.classes.time_sensitive },
          standard: { ...defaults.lifecycle.classes.standard },
          trivial: { ...defaults.lifecycle.classes.trivial },
        },
        reinforcement: { ...defaults.lifecycle.reinforcement },
        accumulatedWeightCap: defaults.lifecycle.accumulatedWeightCap,
        contradictionDampeningFactor: defaults.lifecycle.contradictionDampeningFactor,
        declineDampeningFactor: defaults.lifecycle.declineDampeningFactor,
        relevanceFloor: defaults.lifecycle.relevanceFloor,
      },
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: weightedThoughtOutreach must be an object`);
  }
  const lifecycleRaw = raw.lifecycle;
  if (!isRecord(lifecycleRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: weightedThoughtOutreach.lifecycle must be an object`);
  }
  const classesRaw = lifecycleRaw.classes;
  if (!isRecord(classesRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: weightedThoughtOutreach.lifecycle.classes must be an object`);
  }
  const reinforcementRaw = lifecycleRaw.reinforcement;
  if (!isRecord(reinforcementRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: weightedThoughtOutreach.lifecycle.reinforcement must be an object`);
  }
  return {
    enabled: toBoolean(raw.enabled, 'weightedThoughtOutreach.enabled'),
    checkIntervalMs: toInterval(raw.checkIntervalMs, 'weightedThoughtOutreach.checkIntervalMs'),
    nudgeThreshold: toNumberAtLeast(raw.nudgeThreshold, 'weightedThoughtOutreach.nudgeThreshold', 0),
    maxNudgesPerRun: toPositiveInteger(raw.maxNudgesPerRun, 'weightedThoughtOutreach.maxNudgesPerRun', 1),
    lifecycle: {
      classes: {
        time_sensitive: validateWeightedThoughtClassProfile(
          classesRaw.time_sensitive,
          'weightedThoughtOutreach.lifecycle.classes.time_sensitive',
        ),
        standard: validateWeightedThoughtClassProfile(
          classesRaw.standard,
          'weightedThoughtOutreach.lifecycle.classes.standard',
        ),
        trivial: validateWeightedThoughtClassProfile(
          classesRaw.trivial,
          'weightedThoughtOutreach.lifecycle.classes.trivial',
        ),
      },
      reinforcement: {
        repeatBoost: toNumberAtLeast(reinforcementRaw.repeatBoost, 'weightedThoughtOutreach.lifecycle.reinforcement.repeatBoost', 0),
        emotionalChargeWeight: toNumberAtLeast(
          reinforcementRaw.emotionalChargeWeight,
          'weightedThoughtOutreach.lifecycle.reinforcement.emotionalChargeWeight',
          0,
        ),
      },
      accumulatedWeightCap: toNumberAtLeast(lifecycleRaw.accumulatedWeightCap, 'weightedThoughtOutreach.lifecycle.accumulatedWeightCap', 0),
      contradictionDampeningFactor: toPositiveUnitFactor(
        lifecycleRaw.contradictionDampeningFactor,
        'weightedThoughtOutreach.lifecycle.contradictionDampeningFactor',
      ),
      declineDampeningFactor: toPositiveUnitFactor(
        lifecycleRaw.declineDampeningFactor,
        'weightedThoughtOutreach.lifecycle.declineDampeningFactor',
      ),
      relevanceFloor: toNumberAtLeast(lifecycleRaw.relevanceFloor, 'weightedThoughtOutreach.lifecycle.relevanceFloor', 0),
    },
  };
}

function validateSocialDesireTierProfile(
  raw: unknown,
  field: string,
): SocialDesireTierProfileConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config: ${field} must be an object`);
  }
  const gainMultiplier = toNumberAtLeast(raw.gainMultiplier, `${field}.gainMultiplier`, 0);
  if (!(gainMultiplier > 0)) {
    throw new Error(`Invalid scheduler config: ${field}.gainMultiplier must be > 0`);
  }
  return {
    gainMultiplier,
    tickGapMs: toInterval(raw.tickGapMs, `${field}.tickGapMs`),
  };
}

function cloneDefaultSocialDesireOutreachSettings(): SocialDesireOutreachSettings {
  const defaults = DEFAULT_SOCIAL_DESIRE_CONFIG.outreach;
  return {
    ...defaults,
    budget: { ...defaults.budget },
  };
}

function validateSocialDesireOutreachSettings(
  raw: unknown,
  sourcePath: string,
): SocialDesireOutreachSettings {
  // A pre-oth4.2 scheduler.json has no outreach section; defaults apply the
  // same way an absent socialDesire section does (still fail-closed overall
  // because `enabled` defaults to false and gates the whole lane).
  if (raw === undefined) {
    return cloneDefaultSocialDesireOutreachSettings();
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.outreach must be an object`);
  }
  const budgetRaw = raw.budget;
  if (!isRecord(budgetRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.outreach.budget must be an object`);
  }
  return {
    checkIntervalMs: toInterval(raw.checkIntervalMs, 'socialDesire.outreach.checkIntervalMs'),
    maxConsentMomentsPerRun: toPositiveInteger(
      raw.maxConsentMomentsPerRun,
      'socialDesire.outreach.maxConsentMomentsPerRun',
      1,
    ),
    consentTtlMs: toInterval(raw.consentTtlMs, 'socialDesire.outreach.consentTtlMs'),
    budget: {
      maxSendsPerWindow: toPositiveInteger(
        budgetRaw.maxSendsPerWindow,
        'socialDesire.outreach.budget.maxSendsPerWindow',
        1,
      ),
      windowMs: toInterval(budgetRaw.windowMs, 'socialDesire.outreach.budget.windowMs'),
    },
  };
}

function validateSocialDesireConfig(
  raw: unknown,
  sourcePath: string,
): SocialDesireConfig {
  const defaults = DEFAULT_SOCIAL_DESIRE_CONFIG;
  if (raw === undefined) {
    return {
      enabled: defaults.enabled,
      lifecycle: {
        ...defaults.lifecycle,
        decay: { ...defaults.lifecycle.decay },
        coolingOff: { ...defaults.lifecycle.coolingOff },
        tiers: {
          acquaintance: { ...defaults.lifecycle.tiers.acquaintance },
          friend: { ...defaults.lifecycle.tiers.friend },
          family: { ...defaults.lifecycle.tiers.family },
          partner: { ...defaults.lifecycle.tiers.partner },
          ai_companion: { ...defaults.lifecycle.tiers.ai_companion },
        },
      },
      outreach: cloneDefaultSocialDesireOutreachSettings(),
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire must be an object`);
  }
  const lifecycleRaw = raw.lifecycle;
  if (!isRecord(lifecycleRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle must be an object`);
  }
  const decayRaw = lifecycleRaw.decay;
  if (!isRecord(decayRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.decay must be an object`);
  }
  const coolingOffRaw = lifecycleRaw.coolingOff;
  if (!isRecord(coolingOffRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.coolingOff must be an object`);
  }
  const tiersRaw = lifecycleRaw.tiers;
  if (!isRecord(tiersRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.tiers must be an object`);
  }
  // Stranger/public tiers are hard-excluded from accumulation in code; a config
  // that tries to define them is a contract violation, not a silent no-op.
  assertNoUnknownKeys(
    tiersRaw,
    ['acquaintance', 'friend', 'family', 'partner', 'ai_companion'],
    `${sourcePath}.socialDesire.lifecycle.tiers`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const coolingOff = {
    warmMs: toInterval(coolingOffRaw.warmMs, 'socialDesire.lifecycle.coolingOff.warmMs'),
    repairMs: toInterval(coolingOffRaw.repairMs, 'socialDesire.lifecycle.coolingOff.repairMs'),
  };
  if (!(coolingOff.repairMs > coolingOff.warmMs)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.coolingOff.repairMs must exceed warmMs `
      + '(negative-origin desires cool off longer than warm desires)',
    );
  }
  const baseGain = toNumberAtLeast(lifecycleRaw.baseGain, 'socialDesire.lifecycle.baseGain', 0);
  if (!(baseGain > 0)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.baseGain must be > 0`);
  }
  const pressureCap = toNumberAtLeast(lifecycleRaw.pressureCap, 'socialDesire.lifecycle.pressureCap', 0);
  if (!(pressureCap > 0)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.pressureCap must be > 0`);
  }
  const actionThreshold = toNumberAtLeast(
    lifecycleRaw.actionThreshold,
    'socialDesire.lifecycle.actionThreshold',
    0,
  );
  if (!(actionThreshold > 0)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialDesire.lifecycle.actionThreshold must be > 0`);
  }
  return {
    enabled: toBoolean(raw.enabled, 'socialDesire.enabled'),
    lifecycle: {
      baseGain,
      pressureCap,
      actionThreshold,
      pressureFloor: toNumberAtLeast(lifecycleRaw.pressureFloor, 'socialDesire.lifecycle.pressureFloor', 0),
      decay: {
        warmHalflifeMs: toInterval(decayRaw.warmHalflifeMs, 'socialDesire.lifecycle.decay.warmHalflifeMs'),
        repairHalflifeMs: toInterval(decayRaw.repairHalflifeMs, 'socialDesire.lifecycle.decay.repairHalflifeMs'),
      },
      coolingOff,
      releaseFactor: toUnitFactor(lifecycleRaw.releaseFactor, 'socialDesire.lifecycle.releaseFactor'),
      dampeningFactor: toUnitFactor(lifecycleRaw.dampeningFactor, 'socialDesire.lifecycle.dampeningFactor'),
      concernReinforcementGain: toNumberAtLeast(
        lifecycleRaw.concernReinforcementGain,
        'socialDesire.lifecycle.concernReinforcementGain',
        0,
      ),
      maxReinforcedConcernIds: toPositiveInteger(
        lifecycleRaw.maxReinforcedConcernIds,
        'socialDesire.lifecycle.maxReinforcedConcernIds',
        1,
      ),
      tiers: {
        acquaintance: validateSocialDesireTierProfile(tiersRaw.acquaintance, 'socialDesire.lifecycle.tiers.acquaintance'),
        friend: validateSocialDesireTierProfile(tiersRaw.friend, 'socialDesire.lifecycle.tiers.friend'),
        family: validateSocialDesireTierProfile(tiersRaw.family, 'socialDesire.lifecycle.tiers.family'),
        partner: validateSocialDesireTierProfile(tiersRaw.partner, 'socialDesire.lifecycle.tiers.partner'),
        ai_companion: validateSocialDesireTierProfile(
          tiersRaw.ai_companion,
          'socialDesire.lifecycle.tiers.ai_companion',
        ),
      },
    },
    outreach: validateSocialDesireOutreachSettings(raw.outreach, sourcePath),
  };
}

function toToolUsageEvaluatorWindow(value: unknown, field: string): ToolUsageEvaluatorWindow {
  if (typeof value !== 'string' || value === 'custom' || !MODEL_USAGE_RANGES.includes(value as ModelUsageRange)) {
    throw new Error(
      `Invalid scheduler config: ${field} must be one of `
      + `${MODEL_USAGE_RANGES.filter(range => range !== 'custom').join(', ')}`,
    );
  }
  return value as ToolUsageEvaluatorWindow;
}

function validateToolUsageEvaluatorConfig(
  value: unknown,
  sourcePath: string,
): ToolUsageEvaluatorConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: toolUsageEvaluator must be an object`);
  }
  return {
    enabled: toBoolean(value.enabled, 'toolUsageEvaluator.enabled'),
    intervalMs: toInterval(value.intervalMs, 'toolUsageEvaluator.intervalMs'),
    usageWindow: toToolUsageEvaluatorWindow(value.usageWindow, 'toolUsageEvaluator.usageWindow'),
    minPinSuggestionInvocations: toPositiveInteger(
      value.minPinSuggestionInvocations,
      'toolUsageEvaluator.minPinSuggestionInvocations',
      1,
    ),
  };
}

function validateIntrospectionAuditConfig(
  value: unknown,
  sourcePath: string,
): IntrospectionAuditConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: introspectionAudit must be an object`);
  }
  return {
    enabled: toBoolean(value.enabled, 'introspectionAudit.enabled'),
    intervalMs: toInterval(value.intervalMs, 'introspectionAudit.intervalMs'),
    recentSessionLimit: toPositiveInteger(value.recentSessionLimit, 'introspectionAudit.recentSessionLimit', 1),
    recentTurnLimit: toPositiveInteger(value.recentTurnLimit, 'introspectionAudit.recentTurnLimit', 1),
    maxCandidatesPerRun: toPositiveInteger(value.maxCandidatesPerRun, 'introspectionAudit.maxCandidatesPerRun', 1),
    maxSourceChars: toPositiveInteger(value.maxSourceChars, 'introspectionAudit.maxSourceChars', 256),
    minConfidence: toUnitFactor(value.minConfidence, 'introspectionAudit.minConfidence'),
    estimatorMaxTokens: toPositiveInteger(value.estimatorMaxTokens, 'introspectionAudit.estimatorMaxTokens', 64),
    comparisonMaxTokens: toPositiveInteger(value.comparisonMaxTokens, 'introspectionAudit.comparisonMaxTokens', 64),
    reflectionMaxTokens: toPositiveInteger(value.reflectionMaxTokens, 'introspectionAudit.reflectionMaxTokens', 64),
  };
}

function localTimeMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function assertBackgroundMaintenanceRestWindowCoverage(
  config: Pick<
    SchedulerRuntimeConfig,
    'tickIntervalMs' | 'backgroundMaintenance' | 'episodicProcessing'
  >,
  sourcePath: string,
): void {
  if (!config.episodicProcessing.enabled) return;

  const startMinute = localTimeMinute(config.episodicProcessing.startLocalTime);
  const endMinute = localTimeMinute(config.episodicProcessing.endLocalTime);
  // Equal endpoints mean the gate is open all day, so there is no outside
  // phase for a relative cadence to lock onto.
  if (startMinute === endMinute) return;
  const windowMinutes = (endMinute - startMinute + 24 * 60) % (24 * 60);
  const windowDurationMs = windowMinutes * 60_000;
  const maximumRelativeGapMs = config.backgroundMaintenance.intervalMs
    + config.tickIntervalMs;

  // A relative task can start at any phase. Its longest possible gap includes
  // one scheduler-tick delay, so that gap must be strictly shorter than the
  // daily rest window or every poll could forever land outside the window.
  if (maximumRelativeGapMs >= windowDurationMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.intervalMs `
      + `(${config.backgroundMaintenance.intervalMs}) plus tickIntervalMs (${config.tickIntervalMs}) `
      + `must be less than the episodicProcessing rest-window duration (${windowDurationMs} ms); `
      + 'otherwise the relative cadence can phase-lock outside every rest window',
    );
  }
}

export function validateSchedulerConfig(raw: unknown, sourcePath: string): SchedulerRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: expected object`);
  }
  if (raw.sleeptime !== undefined) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: the "sleeptime" cadence key was removed. `
      + 'The lightweight turn-based lane is now "nearTurnMemory"; heavy sleeptime passes are '
      + 'scheduler-owned via "episodicProcessing", "sleepConsolidation", and "arcFormation". '
      + 'Rename the key and remove any heavy-pass expectations from turn cadence.',
    );
  }
  if (raw.salienceDecayIntervalMs !== undefined) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: salienceDecayIntervalMs was removed; `
      + 'use backgroundMaintenance.intervalMs, the shared cadence Garden labels with every bundled operation',
    );
  }

  const tickIntervalMs = toInterval(raw.tickIntervalMs, 'tickIntervalMs');
  const backgroundMaintenance = validateBackgroundMaintenanceConfig(
    raw.backgroundMaintenance,
    sourcePath,
  );
  const episodicProcessing = validateEpisodicProcessingConfig(raw.episodicProcessing, sourcePath);
  const validated: SchedulerRuntimeConfig = {
    tickIntervalMs,
    heartbeatIntervalMs: toInterval(raw.heartbeatIntervalMs, 'heartbeatIntervalMs'),
    backgroundMaintenance,
    backgroundWork: validateBackgroundWorkConfig(raw.backgroundWork, sourcePath),
    artifactLifecycle: validateArtifactLifecycleConfig(raw.artifactLifecycle, sourcePath),
    episodicProcessing,
    nearTurnMemory: validateNearTurnMemoryConfig(raw.nearTurnMemory, sourcePath),
    episodeSynthesis: validateEpisodeSynthesisConfig(raw.episodeSynthesis, sourcePath),
    sleepConsolidation: validateSleepConsolidationConfig(raw.sleepConsolidation, sourcePath),
    orientationRewrite: validateOrientationRewriteGateConfig(raw.orientationRewrite, sourcePath),
    reflectionNovelty: validateReflectionNoveltyGateConfig(raw.reflectionNovelty, sourcePath),
    wikiPass: validateSleeptimeWikiPassConfig(raw.wikiPass, sourcePath),
    arcFormation: validateArcFormationConfig(raw.arcFormation, sourcePath),
    socialGraphBuilder: validateSocialGraphBuilderConfig(raw.socialGraphBuilder, sourcePath),
    temporalWakeup: validateTemporalWakeupConfig(raw.temporalWakeup, sourcePath),
    freeTime: validateFreeTimeConfig(raw.freeTime, sourcePath),
    socialAutonomy: validateSocialAutonomyConfig(raw.socialAutonomy, sourcePath),
    weightedThoughtOutreach: validateWeightedThoughtOutreachConfig(raw.weightedThoughtOutreach, sourcePath),
    socialDesire: validateSocialDesireConfig(raw.socialDesire, sourcePath),
    icpAutonomy: parseIcpAutonomySchedulerConfig(raw.icpAutonomy),
    ...(raw.introspectionAudit === undefined
      ? {}
      : { introspectionAudit: validateIntrospectionAuditConfig(raw.introspectionAudit, sourcePath) }),
    ...(raw.backgroundWorkWelfare === undefined
      ? {}
      : { backgroundWorkWelfare: validateBackgroundWorkWelfareConfig(raw.backgroundWorkWelfare, sourcePath) }),
    ...(raw.toolUsageEvaluator === undefined
      ? {}
      : { toolUsageEvaluator: validateToolUsageEvaluatorConfig(raw.toolUsageEvaluator, sourcePath) }),
  };
  assertBackgroundMaintenanceRestWindowCoverage(validated, sourcePath);
  return validated;
}

export function loadSchedulerConfig(
  dataDir: string,
  options: SchedulerRuntimeLoadOptions = {},
): SchedulerRuntimeConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadRequiredJson({
    dataPath: join(dataDir, SCHEDULER_FILE_NAME),
    examplePath: join(seedDir, SCHEDULER_SEED_FILE_NAME),
    validate: validateSchedulerConfig,
  });
}

export function loadSchedulerSeedDefaults(
  options: SchedulerRuntimeLoadOptions = {},
): SchedulerRuntimeConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadSeedJson({
    seedPath: join(seedDir, SCHEDULER_SEED_FILE_NAME),
    validate: validateSchedulerConfig,
  });
}

export function saveSchedulerConfig(
  dataDir: string,
  nextConfig: unknown,
): SchedulerRuntimeConfig {
  const validated = validateSchedulerConfig(nextConfig, SCHEDULER_FILE_NAME);
  writeJsonAtomic(join(dataDir, SCHEDULER_FILE_NAME), validated);
  return validated;
}
