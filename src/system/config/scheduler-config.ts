import { join } from 'node:path';
import {
  loadRequiredJson,
  loadSeedJson,
} from './load-or-seed.js';
import { isRecord } from '../../shared/utils/types.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { OWNER_FILE_MODE_COMPANION_POLICY } from './owner-file-modes.js';
import type { BackgroundWorkRuntimeTuning } from '../../core/agent/background-work/config.js';
import {
  parseIcpAutonomySchedulerConfig,
  type IcpAutonomySchedulerConfig,
} from './icp-autonomy-scheduler-config.js';
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
  validateWeightedThoughtOutreachConfig,
  type WeightedThoughtOutreachConfig,
} from './scheduler-config/weighted-thought.js';
import {
  validateSocialDesireConfig,
  type SocialDesireConfig,
} from './scheduler-config/social-desire.js';
import {
  validateIntrospectionAuditConfig,
  type IntrospectionAuditConfig,
} from './scheduler-config/introspection.js';
import {
  validateToolUsageEvaluatorConfig,
  type ToolUsageEvaluatorConfig,
} from './scheduler-config/tool-usage.js';
import {
  toInterval,
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
export {
  DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG,
  type WeightedThoughtOutreachConfig,
} from './scheduler-config/weighted-thought.js';
export {
  DEFAULT_SOCIAL_DESIRE_CONFIG,
  type SocialDesireConfig,
} from './scheduler-config/social-desire.js';
export {
  DEFAULT_INTROSPECTION_AUDIT_CONFIG,
  type IntrospectionAuditConfig,
} from './scheduler-config/introspection.js';
export {
  DEFAULT_TOOL_USAGE_EVALUATOR_CONFIG,
  type ToolUsageEvaluatorConfig,
  type ToolUsageEvaluatorWindow,
} from './scheduler-config/tool-usage.js';

export const SCHEDULER_FILE_NAME = 'scheduler.json';
export const SCHEDULER_SEED_FILE_NAME = 'scheduler.seed.json';

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

function localTimeMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
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
  writeJsonAtomic(join(dataDir, SCHEDULER_FILE_NAME), validated, {
    mode: OWNER_FILE_MODE_COMPANION_POLICY,
  });
  return validated;
}
