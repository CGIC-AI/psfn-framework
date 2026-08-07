import { isRecord } from '../../../shared/utils/types.js';
import {
  toBoolean,
  toInterval,
  toNumberAtLeast,
  toPositiveInteger,
  toPositiveUnitFactor,
} from './primitives.js';

/** Per-class weight profile (charter 6.24: time-sensitive vs trivial differ). */
interface WeightedThoughtClassProfileConfig {
  baseWeight: number;
  halflifeMs: number;
}

interface WeightedThoughtReinforcementConfig {
  repeatBoost: number;
  emotionalChargeWeight: number;
}

/** Deterministic weighted-thought lifecycle math config (bead 1xb.4). */
interface WeightedThoughtLifecycleSettings {
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
