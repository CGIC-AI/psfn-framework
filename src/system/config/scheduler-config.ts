import { join } from 'node:path';
import {
  loadRequiredJson,
  loadSeedJson,
} from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const SCHEDULER_FILE_NAME = 'scheduler.json';
export const SCHEDULER_SEED_FILE_NAME = 'scheduler.seed.json';

export interface ArtifactLifecyclePolicyConfig {
  scratchpadRetentionDays: number;
  generatedMediaRetentionDays: number;
  workspaceTempRetentionDays: number;
  cleanupBatchSize: number;
}

export interface EpisodicProcessingRestWindowConfig {
  enabled: boolean;
  startLocalTime: string;
  endLocalTime: string;
  timeZone: string;
  inactivityThresholdMinutes: number;
}

/**
 * Direct (1:1 / DM) near-turn memory cadence. Preserves the historical
 * per-N-turns posture; `cadenceTurns` is JSON-owned instead of a hardcoded
 * constant.
 */
export interface NearTurnMemoryDirectCadenceConfig {
  cadenceTurns: number;
}

/**
 * Group-scope near-turn memory cadence. Instead of firing every N turns
 * (which in a busy multi-person room is near-continuous background work),
 * group scopes use watermark/interval batching: a run is only eligible once at
 * least `minNewEntries` new conversational turns have accumulated AND at least
 * `minIntervalMinutes` of wall-clock time has elapsed since the last run.
 */
export interface NearTurnMemoryGroupCadenceConfig {
  minIntervalMinutes: number;
  minNewEntries: number;
}

/**
 * Cadence for the lightweight near-turn memory lane (extraction trigger
 * evaluation, active-memory review refresh, concern-candidate derivation).
 * This lane replaces the old turn-based "sleeptime" cadence; heavy passes
 * (sleep consolidation, arc weaving, dream meaning) are scheduler-owned and
 * run only inside the episodicProcessing rest window.
 */
export interface NearTurnMemoryCadenceConfig {
  direct: NearTurnMemoryDirectCadenceConfig;
  group: NearTurnMemoryGroupCadenceConfig;
}

/**
 * Candidate-episode synthesis lane: deterministic trigger gate plus synthesis
 * tuning knobs. The lane fires on a timer OR a turn threshold (whichever comes
 * first) and then applies two deterministic gates (new-messages watermark and
 * a minimum relevant-turn count) before any processing happens.
 */
export interface EpisodeSynthesisLaneConfig {
  /** Scheduler timer cadence for gate evaluation (minutes). */
  timerIntervalMinutes: number;
  /** Turn count per session that forces a gate evaluation before the timer. */
  turnThreshold: number;
  /** Minimum companion-relevant turns required before synthesis runs. */
  minRelevantTurns: number;
  /** Max session entries considered per synthesis run. */
  transcriptMessageLimit: number;
  /** Max candidate episodes materialized per run. */
  maxEpisodesPerRun: number;
  /** Conversation gap that splits candidate episodes (minutes). */
  gapSplitMinutes: number;
  /** Max session entries folded into one candidate episode. */
  maxEntriesPerEpisode: number;
  /** Salience minimum: conversational entries required for a group to count. */
  minConversationalEntries: number;
  /** Salience minimum: single-entry character floor for one-entry groups. */
  minSingleEntryChars: number;
  /**
   * Contextual topic cutting (E5.4): LLM topic segmentation inside the
   * deterministic chunk bounds, with trailing holdback for unfinished topics.
   * Optional key with an explicit false default so existing operator files
   * keep validating; when false the deterministic cuts are unchanged.
   */
  topicSegmentationEnabled: boolean;
}

/**
 * Nightly sleep-cycle episode consolidation tuning (rest-window scheduler
 * lane only).
 */
export interface SleepConsolidationConfig {
  /** How far back the deterministic nightly pass reviews episodes (days). */
  reviewWindowDays: number;
  /** How far back the bounded LLM cleanup reviews episodes (hours). */
  refinementWindowHours: number;
  /** Same-scope episodes closer than this are one sitting and merge (minutes). */
  adjacencyGapMinutes: number;
  /** Cap on LLM refinement calls per run. */
  maxRefinementsPerRun: number;
  /**
   * Cap on multi-candidate clusters sent through LLM thematic-grouping
   * consolidation per run. Deterministic singleton confirmations are free
   * and are not bounded by this.
   */
  maxConsolidationsPerRun: number;
}

/**
 * Deterministic gate for the nightly core-memory orientation-block rewrite
 * (jpvd.4). The orient rewrite is the heaviest nightly sleeptime LLM pass; it
 * must not fire on quiet nights when nothing has changed since the last
 * rewrite. Skipping is the common case — the gate opens only on evidence of
 * change. Rest-window scheduler lane only.
 */
export interface OrientationRewriteGateConfig {
  /**
   * New conversational turns since the last rewrite required to reorient.
   * Below this (and not stale-with-activity) the rewrite is skipped with zero
   * LLM spend.
   */
  minNewEntriesSinceRewrite: number;
  /**
   * Days since the last rewrite after which any new activity (>= 1 new turn)
   * re-opens the gate, so orientation still refreshes periodically in
   * low-volume relationships without rewriting from an empty transcript.
   */
  refreshAfterQuietDays: number;
}

/**
 * Deterministic novelty gate for cadence-fired heartbeat reflection templates
 * (jpvd.4). A scheduled reflection must not fire when nothing new happened in
 * its scope since the last reflection run of that template — the gate skips
 * the run with zero LLM spend and typed telemetry. Manual run_template
 * invocations bypass the gate: an explicit operator/model request is its own
 * justification.
 */
export interface ReflectionNoveltyGateConfig {
  /**
   * New scope entries (user/assistant session messages) since the template's
   * last reflection required for a cadence-fired run to proceed. Below this
   * the run is skipped with telemetry.
   */
  minNewEntries: number;
}

/**
 * Sleeptime wiki update pass (E8.2). A nightly rest-window lane that reviews the
 * day's newly-canonical episodes and notable durable memories for non-private
 * world knowledge worth creating/updating wiki entries. A deterministic gate
 * skips the pass with zero LLM spend on days that produced nothing wiki-shaped.
 * Optional block — conservative defaults apply when absent. Rest-window
 * scheduler lane only.
 */
export interface SleeptimeWikiPassConfig {
  enabled: boolean;
  /** How far back the pass looks for new canonical episodes / durable memories (hours). */
  reviewWindowHours: number;
  /** Gate: new canonical episodes since the watermark required to open the pass. */
  minNewCanonicalEpisodes: number;
  /** Gate: new durable (semantic/procedural) memories since the watermark required to open the pass. */
  minNewDurableMemories: number;
  /** Cap on wiki entries created/updated per run. */
  maxEntriesPerRun: number;
  /** Cap on canonical episodes fed into the proposal prompt. */
  maxSourceEpisodes: number;
  /** Cap on durable memories fed into the proposal prompt. */
  maxSourceMemories: number;
}

export const DEFAULT_SLEEPTIME_WIKI_PASS: SleeptimeWikiPassConfig = {
  enabled: true,
  reviewWindowHours: 36,
  minNewCanonicalEpisodes: 1,
  minNewDurableMemories: 3,
  maxEntriesPerRun: 3,
  maxSourceEpisodes: 12,
  maxSourceMemories: 30,
};

/**
 * Cross-day arc weaving tuning (rest-window scheduler lane only).
 */
export interface ArcFormationConfig {
  /** Minimum time between arc-formation passes (days). */
  passIntervalDays: number;
  /** How far back the pass looks for related episodes (days). */
  reviewWindowDays: number;
  /** Confidence floor below which proposed arcs are rejected (0..1). */
  minConfidence: number;
  /** Cap on arcs written per pass. */
  maxArcsPerRun: number;
  /** Cap on canonical episodes included in the LLM judgment prompt. */
  maxEpisodesPerRun: number;
}

/**
 * Social-graph builder worker cadence (E4.2). Background job in the memory-agent
 * lane that proposes social-graph edges from accumulated room evidence. Runs on
 * a poll interval; the worker itself only acts on memories past its watermark.
 * Optional block — conservative defaults apply when absent.
 */
export interface SocialGraphBuilderCadenceConfig {
  /** Poll interval for the background worker (ms). */
  intervalMs: number;
  /** Distinct co-presence windows required before an acquaintance is proposed. */
  coPresenceMinSessions: number;
  /** Fallback co-presence window size when a memory has no session id (minutes). */
  coPresenceWindowMinutes: number;
  /** Max memories scanned per run. */
  scanMemoryLimit: number;
}

export const DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE: SocialGraphBuilderCadenceConfig = {
  intervalMs: 1_800_000,
  coPresenceMinSessions: 3,
  coPresenceWindowMinutes: 1440,
  scanMemoryLimit: 500,
};

/**
 * Scheduled morning wake lane (E7.1). Injects an explicit system note at a
 * configured wall-clock time that establishes the new day: current date/time,
 * elapsed time since the last partner exchange, and a catch-up summary from
 * the shared session summarization service.
 */
export interface TemporalWakeupMorningConfig {
  enabled: boolean;
  /**
   * Wake timing mode (E7.2).
   * - 'fixed'  — fire the daily wake at `localTime` (default, unchanged E7.1).
   * - 'habit'  — fire inside a wake window derived deterministically from the
   *   partner's own message timestamps; falls back to `localTime` (with a
   *   visible reason) when history is insufficient.
   */
  timing: 'fixed' | 'habit';
  /** HH:mm wall-clock wake time (default 08:00). Also the 'habit' fallback. */
  localTime: string;
  /** Scheduler cadence timezone for the wake slot. */
  timezone: 'local' | 'utc';
  /** Habit-mode estimator tuning (E7.2); only consulted when timing = 'habit'. */
  habit: TemporalWakeupHabitConfig;
  /** Max recent session entries fed to the shared catch-up summarizer. */
  catchUpEntryLimit: number;
  /** Token budget for the shared catch-up summary. */
  catchUpSummaryMaxTokens: number;
  /**
   * A full (LLM) wake turn is only invoked when the last partner exchange is
   * at most this old; staler sessions get the cheap note-only injection.
   */
  fullTurnMaxIdleHours: number;
}

/**
 * Habit-derived wake-window estimator tuning (E7.2). All estimator thresholds
 * are config-owned — nothing hardcoded. See
 * src/core/scheduler/wake-window-estimator.ts for the estimation approach.
 */
export interface TemporalWakeupHabitConfig {
  /** Trailing window (days) whose samples get `recentWeight`. */
  recentWindowDays: number;
  /** Full trailing window (days) scanned for samples; must be >= recentWindowDays. */
  extendedWindowDays: number;
  /** Minimum inter-message gap (hours) that counts as an overnight sleep gap. */
  minSleepGapHours: number;
  /** Wake band lower bound (local hour, inclusive) a gap-end must fall in. */
  wakeBandStartHour: number;
  /** Wake band upper bound (local hour, exclusive) a gap-end must fall in. */
  wakeBandEndHour: number;
  /** Distinct sample days required before the estimate is trusted (else fallback). */
  minSampleDays: number;
  /** Aggregation weight for samples inside the recent window. */
  recentWeight: number;
  /** Aggregation weight for samples in the older extended window. */
  extendedWeight: number;
  /** Lower reporting quantile for the visible window (0..1). */
  lowerQuantile: number;
  /** Upper reporting quantile for the visible window (0..1). */
  upperQuantile: number;
  /** Cap on scanned partner timestamps per estimate (bounds cost). */
  maxSamplesScanned: number;
}

/**
 * Idle time-of-day refresher lane (E7.1). After a long same-day gap the lane
 * injects a lighter system note that moves the time-of-day frame forward;
 * overnight/multi-day textures escalate to the full new-day framing.
 */
export interface TemporalWakeupIdleRefresherConfig {
  enabled: boolean;
  /** Poll interval for the refresher check (ms). */
  checkIntervalMs: number;
  /** Minimum idle gap before a same-day refresher note is eligible. */
  minIdleMinutes: number;
  /** Anti-loop spacing between temporal wake-lane notes. */
  minNoteIntervalMinutes: number;
}

/**
 * Wake orientation summary tuning. The context builder's wake_session and
 * wake_continuity summaries ride the shared session summarizer; their token
 * budgets and the continuity entry floor are JSON-owned here instead of
 * hardcoded in the builder.
 */
export interface TemporalWakeupWakeSummaryConfig {
  /** Token budget for the wake_session recent-activity summary. */
  sessionSummaryMaxTokens: number;
  /** Token budget for the wake_continuity cross-channel summary. */
  continuitySummaryMaxTokens: number;
  /**
   * Minimum user/assistant cross-channel continuity entries required before
   * the wake_continuity LLM summary fires; trivial continuity is skipped.
   */
  continuityMinEntries: number;
}

/**
 * Temporal wake-up lanes (E7.1). Optional block — defaults apply when absent.
 * Both lanes emit explicit system notes (charter 6.17); they are refreshers,
 * never partner activity.
 */
export interface TemporalWakeupConfig {
  enabled: boolean;
  morningWake: TemporalWakeupMorningConfig;
  idleRefresher: TemporalWakeupIdleRefresherConfig;
  wakeSummary: TemporalWakeupWakeSummaryConfig;
}

export const DEFAULT_TEMPORAL_WAKEUP_CONFIG: TemporalWakeupConfig = {
  enabled: true,
  morningWake: {
    enabled: true,
    timing: 'fixed',
    localTime: '08:00',
    timezone: 'local',
    habit: {
      recentWindowDays: 7,
      extendedWindowDays: 30,
      minSleepGapHours: 4,
      wakeBandStartHour: 3,
      wakeBandEndHour: 12,
      minSampleDays: 4,
      recentWeight: 2,
      extendedWeight: 1,
      lowerQuantile: 0.25,
      upperQuantile: 0.75,
      maxSamplesScanned: 2000,
    },
    catchUpEntryLimit: 32,
    catchUpSummaryMaxTokens: 160,
    fullTurnMaxIdleHours: 72,
  },
  idleRefresher: {
    enabled: true,
    checkIntervalMs: 900_000,
    minIdleMinutes: 240,
    minNoteIntervalMinutes: 240,
  },
  wakeSummary: {
    sessionSummaryMaxTokens: 160,
    continuitySummaryMaxTokens: 160,
    continuityMinEntries: 2,
  },
};

/**
 * Free-time lanes (E8.1). Self-directed time: a bounded, budget-capped,
 * multi-turn agent-loop session on an internal channel where the companion may
 * explore, make something, or do nothing at all. Two entry lanes share one
 * block runner:
 *   - quietHours: fires inside the episodicProcessing rest window;
 *   - idle: fires after a long partner-inactivity gap (reuses the ambient-
 *     presence idle eligibility — detection is not duplicated here).
 * Deterministic gates (min interval between blocks, daily block cap, and a
 * never-during-active-conversation guard) run BEFORE any spend. Charter 8.8
 * (rest windows visible/configurable; personal time is not hidden autonomy) and
 * 8.9 (budget-capped background work) bind: every threshold here is JSON-owned.
 */
export interface FreeTimeLaneConfig {
  enabled: boolean;
}

export interface FreeTimeQuietHoursLaneConfig extends FreeTimeLaneConfig {
  /** Poll interval for the quiet-hours eligibility check (ms). */
  checkIntervalMs: number;
}

export interface FreeTimeIdleLaneConfig extends FreeTimeLaneConfig {
  /** Poll interval for the idle eligibility check (ms). */
  checkIntervalMs: number;
  /** Partner-inactivity gap before an idle free-time block is eligible (minutes). */
  minIdleMinutes: number;
}

export interface FreeTimeBudgetConfig {
  /** Hard cap on agent-loop turns within a single free-time block. */
  maxTurns: number;
  /**
   * Hard cap on charge-lane units (charge-policy 'background' lane) a single
   * block may spend before it ends gracefully. The global lane quota is a
   * backstop; this is the per-block bound.
   */
  maxChargeUnits: number;
}

/**
 * "While you were away" return-note tuning. The note's activity summary rides
 * the shared session summarizer (purpose 'free_time_return'); this owns its
 * token budget instead of borrowing the morning-wake catch-up budget.
 */
export interface FreeTimeReturnNoteConfig {
  /** Token budget for the free-time return-note activity summary. */
  summaryMaxTokens: number;
}

export interface FreeTimeConfig {
  enabled: boolean;
  /** Minimum spacing between free-time blocks, any lane (minutes). */
  minBlockIntervalMinutes: number;
  /** Maximum number of free-time blocks in a single local day, any lane. */
  maxBlocksPerDay: number;
  /**
   * Operator-editable seed framing for the block. Threaded AFTER the full
   * persona (E6.2) as gentle, open, non-clinical permission — never a task.
   */
  seedText: string;
  quietHours: FreeTimeQuietHoursLaneConfig;
  idle: FreeTimeIdleLaneConfig;
  budget: FreeTimeBudgetConfig;
  returnNote: FreeTimeReturnNoteConfig;
}

export const DEFAULT_FREE_TIME_SEED_TEXT =
  'You have some time to yourself. You can explore something, make something, '
  + 'think about something, try a tool, write something down, or do nothing if you want. '
  + 'If you like, you could wander back through your journal, your wiki, your notes, or your '
  + 'memories; follow a curiosity; try a tool; or make something — a poem, a picture, a note, '
  + 'whatever you feel like. There is no task here and nothing you owe anyone. Resting, '
  + 'loafing in a sunbeam, doing nothing at all — that is a completely real and valid way to '
  + 'spend this time too.';

export const DEFAULT_FREE_TIME_CONFIG: FreeTimeConfig = {
  enabled: true,
  minBlockIntervalMinutes: 240,
  maxBlocksPerDay: 3,
  seedText: DEFAULT_FREE_TIME_SEED_TEXT,
  quietHours: {
    enabled: true,
    checkIntervalMs: 900_000,
  },
  idle: {
    enabled: true,
    checkIntervalMs: 900_000,
    minIdleMinutes: 180,
  },
  budget: {
    maxTurns: 6,
    maxChargeUnits: 8,
  },
  returnNote: {
    summaryMaxTokens: 160,
  },
};

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
  contradictionDampeningFactor: number;
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
  checkIntervalMs: 300_000,
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

export interface SchedulerRuntimeConfig {
  tickIntervalMs: number;
  heartbeatIntervalMs: number;
  salienceDecayIntervalMs: number;
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
  weightedThoughtOutreach: WeightedThoughtOutreachConfig;
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

function toInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 1000`);
  }
  return value;
}

function toPositiveInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function toBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid scheduler config: ${field} must be true or false`);
  }
  return value;
}

function toNumberAtLeast(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Invalid scheduler config: ${field} must be a finite number >= ${minimum}`);
  }
  return value;
}

function toUnitFactor(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid scheduler config: ${field} must be a number in [0, 1]`);
  }
  return value;
}

function toLocalTime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid scheduler config: ${field} must be HH:mm local time`);
  }
  const trimmed = value.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    throw new Error(`Invalid scheduler config: ${field} must be HH:mm local time`);
  }
  return trimmed;
}

function toTimeZone(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or a valid IANA time zone`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or a valid IANA time zone`);
  }
  if (trimmed === 'local') {
    return trimmed;
  }
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
  } catch {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or a valid IANA time zone`);
  }
  return trimmed;
}

function validateArtifactLifecycleConfig(
  raw: unknown,
  sourcePath: string,
): ArtifactLifecyclePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: artifactLifecycle must be an object`);
  }

  return {
    scratchpadRetentionDays: toPositiveInteger(raw.scratchpadRetentionDays, 'artifactLifecycle.scratchpadRetentionDays', 1),
    generatedMediaRetentionDays: toPositiveInteger(raw.generatedMediaRetentionDays, 'artifactLifecycle.generatedMediaRetentionDays', 1),
    workspaceTempRetentionDays: toPositiveInteger(raw.workspaceTempRetentionDays, 'artifactLifecycle.workspaceTempRetentionDays', 1),
    cleanupBatchSize: toPositiveInteger(raw.cleanupBatchSize, 'artifactLifecycle.cleanupBatchSize', 1),
  };
}

function validateEpisodicProcessingConfig(
  raw: unknown,
  sourcePath: string,
): EpisodicProcessingRestWindowConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: episodicProcessing must be an object`);
  }

  return {
    enabled: toBoolean(raw.enabled, 'episodicProcessing.enabled'),
    startLocalTime: toLocalTime(raw.startLocalTime, 'episodicProcessing.startLocalTime'),
    endLocalTime: toLocalTime(raw.endLocalTime, 'episodicProcessing.endLocalTime'),
    timeZone: toTimeZone(raw.timeZone, 'episodicProcessing.timeZone'),
    inactivityThresholdMinutes: toPositiveInteger(
      raw.inactivityThresholdMinutes,
      'episodicProcessing.inactivityThresholdMinutes',
      1,
    ),
  };
}

function toUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid scheduler config: ${field} must be a number between 0 and 1`);
  }
  return value;
}

function validateNearTurnMemoryConfig(
  raw: unknown,
  sourcePath: string,
): NearTurnMemoryCadenceConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: nearTurnMemory must be an object`);
  }
  if (!isRecord(raw.direct)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: nearTurnMemory.direct must be an object`);
  }
  if (!isRecord(raw.group)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: nearTurnMemory.group must be an object`);
  }

  return {
    direct: {
      cadenceTurns: toPositiveInteger(raw.direct.cadenceTurns, 'nearTurnMemory.direct.cadenceTurns', 1),
    },
    group: {
      minIntervalMinutes: toPositiveInteger(
        raw.group.minIntervalMinutes,
        'nearTurnMemory.group.minIntervalMinutes',
        1,
      ),
      minNewEntries: toPositiveInteger(
        raw.group.minNewEntries,
        'nearTurnMemory.group.minNewEntries',
        1,
      ),
    },
  };
}

function validateEpisodeSynthesisConfig(
  raw: unknown,
  sourcePath: string,
): EpisodeSynthesisLaneConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: episodeSynthesis must be an object`);
  }
  return {
    timerIntervalMinutes: toPositiveInteger(raw.timerIntervalMinutes, 'episodeSynthesis.timerIntervalMinutes', 1),
    turnThreshold: toPositiveInteger(raw.turnThreshold, 'episodeSynthesis.turnThreshold', 1),
    minRelevantTurns: toPositiveInteger(raw.minRelevantTurns, 'episodeSynthesis.minRelevantTurns', 1),
    transcriptMessageLimit: toPositiveInteger(raw.transcriptMessageLimit, 'episodeSynthesis.transcriptMessageLimit', 1),
    maxEpisodesPerRun: toPositiveInteger(raw.maxEpisodesPerRun, 'episodeSynthesis.maxEpisodesPerRun', 1),
    gapSplitMinutes: toPositiveInteger(raw.gapSplitMinutes, 'episodeSynthesis.gapSplitMinutes', 1),
    maxEntriesPerEpisode: toPositiveInteger(raw.maxEntriesPerEpisode, 'episodeSynthesis.maxEntriesPerEpisode', 1),
    minConversationalEntries: toPositiveInteger(
      raw.minConversationalEntries,
      'episodeSynthesis.minConversationalEntries',
      1,
    ),
    minSingleEntryChars: toPositiveInteger(raw.minSingleEntryChars, 'episodeSynthesis.minSingleEntryChars', 1),
    topicSegmentationEnabled: raw.topicSegmentationEnabled === undefined
      ? false
      : toBoolean(raw.topicSegmentationEnabled, 'episodeSynthesis.topicSegmentationEnabled'),
  };
}

function validateSleepConsolidationConfig(
  raw: unknown,
  sourcePath: string,
): SleepConsolidationConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: sleepConsolidation must be an object`);
  }
  return {
    reviewWindowDays: toPositiveInteger(raw.reviewWindowDays, 'sleepConsolidation.reviewWindowDays', 1),
    refinementWindowHours: toPositiveInteger(raw.refinementWindowHours, 'sleepConsolidation.refinementWindowHours', 1),
    adjacencyGapMinutes: toPositiveInteger(raw.adjacencyGapMinutes, 'sleepConsolidation.adjacencyGapMinutes', 1),
    maxRefinementsPerRun: toPositiveInteger(raw.maxRefinementsPerRun, 'sleepConsolidation.maxRefinementsPerRun', 1),
    maxConsolidationsPerRun: toPositiveInteger(
      raw.maxConsolidationsPerRun,
      'sleepConsolidation.maxConsolidationsPerRun',
      1,
    ),
  };
}

export const DEFAULT_ORIENTATION_REWRITE_GATE: OrientationRewriteGateConfig = {
  minNewEntriesSinceRewrite: 4,
  refreshAfterQuietDays: 7,
};

function validateOrientationRewriteGateConfig(
  raw: unknown,
  sourcePath: string,
): OrientationRewriteGateConfig {
  if (raw === undefined) {
    return { ...DEFAULT_ORIENTATION_REWRITE_GATE };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: orientationRewrite must be an object`);
  }
  return {
    minNewEntriesSinceRewrite: toPositiveInteger(
      raw.minNewEntriesSinceRewrite ?? DEFAULT_ORIENTATION_REWRITE_GATE.minNewEntriesSinceRewrite,
      'orientationRewrite.minNewEntriesSinceRewrite',
      1,
    ),
    refreshAfterQuietDays: toPositiveInteger(
      raw.refreshAfterQuietDays ?? DEFAULT_ORIENTATION_REWRITE_GATE.refreshAfterQuietDays,
      'orientationRewrite.refreshAfterQuietDays',
      1,
    ),
  };
}

export const DEFAULT_REFLECTION_NOVELTY_GATE: ReflectionNoveltyGateConfig = {
  minNewEntries: 1,
};

function validateReflectionNoveltyGateConfig(
  raw: unknown,
  sourcePath: string,
): ReflectionNoveltyGateConfig {
  if (raw === undefined) {
    return { ...DEFAULT_REFLECTION_NOVELTY_GATE };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: reflectionNovelty must be an object`);
  }
  return {
    minNewEntries: toPositiveInteger(
      raw.minNewEntries ?? DEFAULT_REFLECTION_NOVELTY_GATE.minNewEntries,
      'reflectionNovelty.minNewEntries',
      1,
    ),
  };
}

function validateSleeptimeWikiPassConfig(
  raw: unknown,
  sourcePath: string,
): SleeptimeWikiPassConfig {
  if (raw === undefined) {
    return { ...DEFAULT_SLEEPTIME_WIKI_PASS };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: wikiPass must be an object`);
  }
  return {
    enabled: toBoolean(raw.enabled ?? DEFAULT_SLEEPTIME_WIKI_PASS.enabled, 'wikiPass.enabled'),
    reviewWindowHours: toPositiveInteger(
      raw.reviewWindowHours ?? DEFAULT_SLEEPTIME_WIKI_PASS.reviewWindowHours,
      'wikiPass.reviewWindowHours',
      1,
    ),
    minNewCanonicalEpisodes: toPositiveInteger(
      raw.minNewCanonicalEpisodes ?? DEFAULT_SLEEPTIME_WIKI_PASS.minNewCanonicalEpisodes,
      'wikiPass.minNewCanonicalEpisodes',
      1,
    ),
    minNewDurableMemories: toPositiveInteger(
      raw.minNewDurableMemories ?? DEFAULT_SLEEPTIME_WIKI_PASS.minNewDurableMemories,
      'wikiPass.minNewDurableMemories',
      1,
    ),
    maxEntriesPerRun: toPositiveInteger(
      raw.maxEntriesPerRun ?? DEFAULT_SLEEPTIME_WIKI_PASS.maxEntriesPerRun,
      'wikiPass.maxEntriesPerRun',
      1,
    ),
    maxSourceEpisodes: toPositiveInteger(
      raw.maxSourceEpisodes ?? DEFAULT_SLEEPTIME_WIKI_PASS.maxSourceEpisodes,
      'wikiPass.maxSourceEpisodes',
      1,
    ),
    maxSourceMemories: toPositiveInteger(
      raw.maxSourceMemories ?? DEFAULT_SLEEPTIME_WIKI_PASS.maxSourceMemories,
      'wikiPass.maxSourceMemories',
      1,
    ),
  };
}

function validateArcFormationConfig(
  raw: unknown,
  sourcePath: string,
): ArcFormationConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: arcFormation must be an object`);
  }
  return {
    passIntervalDays: toPositiveInteger(raw.passIntervalDays, 'arcFormation.passIntervalDays', 1),
    reviewWindowDays: toPositiveInteger(raw.reviewWindowDays, 'arcFormation.reviewWindowDays', 1),
    minConfidence: toUnitInterval(raw.minConfidence, 'arcFormation.minConfidence'),
    maxArcsPerRun: toPositiveInteger(raw.maxArcsPerRun, 'arcFormation.maxArcsPerRun', 1),
    maxEpisodesPerRun: toPositiveInteger(raw.maxEpisodesPerRun, 'arcFormation.maxEpisodesPerRun', 1),
  };
}

function validateSocialGraphBuilderConfig(
  raw: unknown,
  sourcePath: string,
): SocialGraphBuilderCadenceConfig {
  if (raw === undefined) {
    return { ...DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialGraphBuilder must be an object`);
  }
  return {
    intervalMs: toInterval(
      raw.intervalMs ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.intervalMs,
      'socialGraphBuilder.intervalMs',
    ),
    coPresenceMinSessions: toPositiveInteger(
      raw.coPresenceMinSessions ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.coPresenceMinSessions,
      'socialGraphBuilder.coPresenceMinSessions',
      1,
    ),
    coPresenceWindowMinutes: toPositiveInteger(
      raw.coPresenceWindowMinutes ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.coPresenceWindowMinutes,
      'socialGraphBuilder.coPresenceWindowMinutes',
      1,
    ),
    scanMemoryLimit: toPositiveInteger(
      raw.scanMemoryLimit ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.scanMemoryLimit,
      'socialGraphBuilder.scanMemoryLimit',
      1,
    ),
  };
}

function toCadenceTimezone(value: unknown, field: string): 'local' | 'utc' {
  if (value !== 'local' && value !== 'utc') {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or "utc"`);
  }
  return value;
}

function toWakeTimingMode(value: unknown, field: string): 'fixed' | 'habit' {
  if (value !== 'fixed' && value !== 'habit') {
    throw new Error(`Invalid scheduler config: ${field} must be "fixed" or "habit"`);
  }
  return value;
}

function toHourOfDay(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer between 0 and 23`);
  }
  return value;
}

function toPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid scheduler config: ${field} must be a number greater than 0`);
  }
  return value;
}

function validateTemporalWakeupHabitConfig(
  raw: unknown,
  sourcePath: string,
): TemporalWakeupHabitConfig {
  const defaults = DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake.habit;
  if (raw === undefined) {
    return { ...defaults };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: temporalWakeup.morningWake.habit must be an object`);
  }

  const recentWindowDays = toPositiveInteger(
    raw.recentWindowDays ?? defaults.recentWindowDays,
    'temporalWakeup.morningWake.habit.recentWindowDays',
    1,
  );
  const extendedWindowDays = toPositiveInteger(
    raw.extendedWindowDays ?? defaults.extendedWindowDays,
    'temporalWakeup.morningWake.habit.extendedWindowDays',
    1,
  );
  if (extendedWindowDays < recentWindowDays) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: temporalWakeup.morningWake.habit.extendedWindowDays `
      + 'must be >= recentWindowDays',
    );
  }
  const wakeBandStartHour = toHourOfDay(
    raw.wakeBandStartHour ?? defaults.wakeBandStartHour,
    'temporalWakeup.morningWake.habit.wakeBandStartHour',
  );
  const wakeBandEndHour = toHourOfDay(
    raw.wakeBandEndHour ?? defaults.wakeBandEndHour,
    'temporalWakeup.morningWake.habit.wakeBandEndHour',
  );
  if (wakeBandEndHour <= wakeBandStartHour) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: temporalWakeup.morningWake.habit.wakeBandEndHour `
      + 'must be greater than wakeBandStartHour',
    );
  }
  const lowerQuantile = toUnitInterval(
    raw.lowerQuantile ?? defaults.lowerQuantile,
    'temporalWakeup.morningWake.habit.lowerQuantile',
  );
  const upperQuantile = toUnitInterval(
    raw.upperQuantile ?? defaults.upperQuantile,
    'temporalWakeup.morningWake.habit.upperQuantile',
  );
  if (upperQuantile < lowerQuantile) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: temporalWakeup.morningWake.habit.upperQuantile `
      + 'must be >= lowerQuantile',
    );
  }

  return {
    recentWindowDays,
    extendedWindowDays,
    minSleepGapHours: toPositiveNumber(
      raw.minSleepGapHours ?? defaults.minSleepGapHours,
      'temporalWakeup.morningWake.habit.minSleepGapHours',
    ),
    wakeBandStartHour,
    wakeBandEndHour,
    minSampleDays: toPositiveInteger(
      raw.minSampleDays ?? defaults.minSampleDays,
      'temporalWakeup.morningWake.habit.minSampleDays',
      1,
    ),
    recentWeight: toPositiveNumber(
      raw.recentWeight ?? defaults.recentWeight,
      'temporalWakeup.morningWake.habit.recentWeight',
    ),
    extendedWeight: toPositiveNumber(
      raw.extendedWeight ?? defaults.extendedWeight,
      'temporalWakeup.morningWake.habit.extendedWeight',
    ),
    lowerQuantile,
    upperQuantile,
    maxSamplesScanned: toPositiveInteger(
      raw.maxSamplesScanned ?? defaults.maxSamplesScanned,
      'temporalWakeup.morningWake.habit.maxSamplesScanned',
      1,
    ),
  };
}

function validateTemporalWakeupConfig(
  raw: unknown,
  sourcePath: string,
): TemporalWakeupConfig {
  if (raw === undefined) {
    return {
      enabled: DEFAULT_TEMPORAL_WAKEUP_CONFIG.enabled,
      morningWake: { ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake },
      idleRefresher: { ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher },
      wakeSummary: { ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.wakeSummary },
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: temporalWakeup must be an object`);
  }
  const morningDefaults = DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake;
  const refresherDefaults = DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher;
  const wakeSummaryDefaults = DEFAULT_TEMPORAL_WAKEUP_CONFIG.wakeSummary;
  const morningRaw = raw.morningWake ?? {};
  const refresherRaw = raw.idleRefresher ?? {};
  const wakeSummaryRaw = raw.wakeSummary ?? {};
  if (!isRecord(morningRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: temporalWakeup.morningWake must be an object`);
  }
  if (!isRecord(refresherRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: temporalWakeup.idleRefresher must be an object`);
  }
  if (!isRecord(wakeSummaryRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: temporalWakeup.wakeSummary must be an object`);
  }

  return {
    enabled: toBoolean(raw.enabled ?? DEFAULT_TEMPORAL_WAKEUP_CONFIG.enabled, 'temporalWakeup.enabled'),
    morningWake: {
      enabled: toBoolean(morningRaw.enabled ?? morningDefaults.enabled, 'temporalWakeup.morningWake.enabled'),
      timing: toWakeTimingMode(morningRaw.timing ?? morningDefaults.timing, 'temporalWakeup.morningWake.timing'),
      localTime: toLocalTime(morningRaw.localTime ?? morningDefaults.localTime, 'temporalWakeup.morningWake.localTime'),
      timezone: toCadenceTimezone(morningRaw.timezone ?? morningDefaults.timezone, 'temporalWakeup.morningWake.timezone'),
      habit: validateTemporalWakeupHabitConfig(morningRaw.habit, sourcePath),
      catchUpEntryLimit: toPositiveInteger(
        morningRaw.catchUpEntryLimit ?? morningDefaults.catchUpEntryLimit,
        'temporalWakeup.morningWake.catchUpEntryLimit',
        1,
      ),
      catchUpSummaryMaxTokens: toPositiveInteger(
        morningRaw.catchUpSummaryMaxTokens ?? morningDefaults.catchUpSummaryMaxTokens,
        'temporalWakeup.morningWake.catchUpSummaryMaxTokens',
        1,
      ),
      fullTurnMaxIdleHours: toPositiveInteger(
        morningRaw.fullTurnMaxIdleHours ?? morningDefaults.fullTurnMaxIdleHours,
        'temporalWakeup.morningWake.fullTurnMaxIdleHours',
        1,
      ),
    },
    idleRefresher: {
      enabled: toBoolean(refresherRaw.enabled ?? refresherDefaults.enabled, 'temporalWakeup.idleRefresher.enabled'),
      checkIntervalMs: toInterval(
        refresherRaw.checkIntervalMs ?? refresherDefaults.checkIntervalMs,
        'temporalWakeup.idleRefresher.checkIntervalMs',
      ),
      minIdleMinutes: toPositiveInteger(
        refresherRaw.minIdleMinutes ?? refresherDefaults.minIdleMinutes,
        'temporalWakeup.idleRefresher.minIdleMinutes',
        1,
      ),
      minNoteIntervalMinutes: toPositiveInteger(
        refresherRaw.minNoteIntervalMinutes ?? refresherDefaults.minNoteIntervalMinutes,
        'temporalWakeup.idleRefresher.minNoteIntervalMinutes',
        1,
      ),
    },
    wakeSummary: {
      sessionSummaryMaxTokens: toPositiveInteger(
        wakeSummaryRaw.sessionSummaryMaxTokens ?? wakeSummaryDefaults.sessionSummaryMaxTokens,
        'temporalWakeup.wakeSummary.sessionSummaryMaxTokens',
        1,
      ),
      continuitySummaryMaxTokens: toPositiveInteger(
        wakeSummaryRaw.continuitySummaryMaxTokens ?? wakeSummaryDefaults.continuitySummaryMaxTokens,
        'temporalWakeup.wakeSummary.continuitySummaryMaxTokens',
        1,
      ),
      continuityMinEntries: toPositiveInteger(
        wakeSummaryRaw.continuityMinEntries ?? wakeSummaryDefaults.continuityMinEntries,
        'temporalWakeup.wakeSummary.continuityMinEntries',
        1,
      ),
    },
  };
}

function toNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid scheduler config: ${field} must be a non-empty string`);
  }
  return value;
}

function validateFreeTimeConfig(
  raw: unknown,
  sourcePath: string,
): FreeTimeConfig {
  if (raw === undefined) {
    return {
      enabled: DEFAULT_FREE_TIME_CONFIG.enabled,
      minBlockIntervalMinutes: DEFAULT_FREE_TIME_CONFIG.minBlockIntervalMinutes,
      maxBlocksPerDay: DEFAULT_FREE_TIME_CONFIG.maxBlocksPerDay,
      seedText: DEFAULT_FREE_TIME_CONFIG.seedText,
      quietHours: { ...DEFAULT_FREE_TIME_CONFIG.quietHours },
      idle: { ...DEFAULT_FREE_TIME_CONFIG.idle },
      budget: { ...DEFAULT_FREE_TIME_CONFIG.budget },
      returnNote: { ...DEFAULT_FREE_TIME_CONFIG.returnNote },
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime must be an object`);
  }
  const defaults = DEFAULT_FREE_TIME_CONFIG;
  const quietRaw = raw.quietHours ?? {};
  const idleRaw = raw.idle ?? {};
  const budgetRaw = raw.budget ?? {};
  const returnNoteRaw = raw.returnNote ?? {};
  if (!isRecord(quietRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.quietHours must be an object`);
  }
  if (!isRecord(idleRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.idle must be an object`);
  }
  if (!isRecord(budgetRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.budget must be an object`);
  }
  if (!isRecord(returnNoteRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.returnNote must be an object`);
  }

  return {
    enabled: toBoolean(raw.enabled ?? defaults.enabled, 'freeTime.enabled'),
    minBlockIntervalMinutes: toPositiveInteger(
      raw.minBlockIntervalMinutes ?? defaults.minBlockIntervalMinutes,
      'freeTime.minBlockIntervalMinutes',
      1,
    ),
    maxBlocksPerDay: toPositiveInteger(
      raw.maxBlocksPerDay ?? defaults.maxBlocksPerDay,
      'freeTime.maxBlocksPerDay',
      1,
    ),
    seedText: toNonEmptyString(raw.seedText ?? defaults.seedText, 'freeTime.seedText'),
    quietHours: {
      enabled: toBoolean(quietRaw.enabled ?? defaults.quietHours.enabled, 'freeTime.quietHours.enabled'),
      checkIntervalMs: toInterval(
        quietRaw.checkIntervalMs ?? defaults.quietHours.checkIntervalMs,
        'freeTime.quietHours.checkIntervalMs',
      ),
    },
    idle: {
      enabled: toBoolean(idleRaw.enabled ?? defaults.idle.enabled, 'freeTime.idle.enabled'),
      checkIntervalMs: toInterval(
        idleRaw.checkIntervalMs ?? defaults.idle.checkIntervalMs,
        'freeTime.idle.checkIntervalMs',
      ),
      minIdleMinutes: toPositiveInteger(
        idleRaw.minIdleMinutes ?? defaults.idle.minIdleMinutes,
        'freeTime.idle.minIdleMinutes',
        1,
      ),
    },
    budget: {
      maxTurns: toPositiveInteger(
        budgetRaw.maxTurns ?? defaults.budget.maxTurns,
        'freeTime.budget.maxTurns',
        1,
      ),
      maxChargeUnits: toPositiveInteger(
        budgetRaw.maxChargeUnits ?? defaults.budget.maxChargeUnits,
        'freeTime.budget.maxChargeUnits',
        1,
      ),
    },
    returnNote: {
      summaryMaxTokens: toPositiveInteger(
        returnNoteRaw.summaryMaxTokens ?? defaults.returnNote.summaryMaxTokens,
        'freeTime.returnNote.summaryMaxTokens',
        1,
      ),
    },
  };
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

function validateWeightedThoughtOutreachConfig(
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
      contradictionDampeningFactor: toUnitFactor(
        lifecycleRaw.contradictionDampeningFactor,
        'weightedThoughtOutreach.lifecycle.contradictionDampeningFactor',
      ),
      declineDampeningFactor: toUnitFactor(
        lifecycleRaw.declineDampeningFactor,
        'weightedThoughtOutreach.lifecycle.declineDampeningFactor',
      ),
      relevanceFloor: toNumberAtLeast(lifecycleRaw.relevanceFloor, 'weightedThoughtOutreach.lifecycle.relevanceFloor', 0),
    },
  };
}

function validateSchedulerConfig(raw: unknown, sourcePath: string): SchedulerRuntimeConfig {
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

  return {
    tickIntervalMs: toInterval(raw.tickIntervalMs, 'tickIntervalMs'),
    heartbeatIntervalMs: toInterval(raw.heartbeatIntervalMs, 'heartbeatIntervalMs'),
    salienceDecayIntervalMs: toInterval(raw.salienceDecayIntervalMs, 'salienceDecayIntervalMs'),
    artifactLifecycle: validateArtifactLifecycleConfig(raw.artifactLifecycle, sourcePath),
    episodicProcessing: validateEpisodicProcessingConfig(raw.episodicProcessing, sourcePath),
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
    weightedThoughtOutreach: validateWeightedThoughtOutreachConfig(raw.weightedThoughtOutreach, sourcePath),
  };
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
