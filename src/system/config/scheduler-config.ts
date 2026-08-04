import { join } from 'node:path';
import {
  loadRequiredJson,
  loadSeedJson,
} from './load-or-seed.js';
import { assertNoUnknownKeys, assertPositiveInteger } from './validators.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  parseIcpAutonomySchedulerConfig,
  type IcpAutonomySchedulerConfig,
} from './icp-autonomy-scheduler-config.js';
import {
  createDefaultEgressLeaseTunables,
  createDefaultParticipationAppraiserSettings,
  createDefaultPassiveNameCandidateSettings,
  createDefaultReservationPhaseSettings,
  parseEgressLeaseTunables,
  parseParticipationAppraiserSettings,
  parsePassiveNameCandidateSettings,
  parseReservationPhaseSettings,
  type EgressLeaseTunables,
  type ParticipationAppraiserSettings,
  type PassiveNameCandidateSettings,
  type ReservationPhaseSettings,
} from './participation-config.js';
import {
  createDefaultFreeTimeChooserSettings,
  parseFreeTimeChooserSettings,
  type FreeTimeChooserSettings,
} from './free-time-chooser-config.js';
import { MODEL_USAGE_RANGES, type ModelUsageRange } from '../../shared/telemetry/model-usage.js';
import type { BackgroundWorkRuntimeTuning } from '../../core/agent/background-work/config.js';

export {
  DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
  type IcpAutonomySchedulerConfig,
} from './icp-autonomy-scheduler-config.js';

/**
 * Social-autonomy participation tunables (jp36.8.2). Homes the room-participation
 * gate knobs — passive-name candidate creation, the cheap participation
 * appraiser, the two-phase speaking arbiter (reservation + egress-lease), and the
 * free-time chooser (incl. the rest / silence-persistence window) — in the
 * per-companion scheduler owner file so they are Garden-editable via the raw
 * owner-file editor. The egress-lease `enabled` flag is intentionally NOT part of
 * this surface: autonomous sending is code-pinned OFF until qgqw.3 (P1), so only
 * its tunables are exposed (see participation-config.ts EgressLeaseTunables).
 */
export interface SocialAutonomyConfig {
  passiveNameCandidate: PassiveNameCandidateSettings;
  appraiser: ParticipationAppraiserSettings;
  reservationPhase: ReservationPhaseSettings;
  egressLease: EgressLeaseTunables;
  freeTimeChooser: FreeTimeChooserSettings;
}

export function createDefaultSocialAutonomyConfig(): SocialAutonomyConfig {
  return {
    passiveNameCandidate: createDefaultPassiveNameCandidateSettings(),
    appraiser: createDefaultParticipationAppraiserSettings(),
    reservationPhase: createDefaultReservationPhaseSettings(),
    egressLease: createDefaultEgressLeaseTunables(),
    freeTimeChooser: createDefaultFreeTimeChooserSettings(),
  };
}

export const DEFAULT_SOCIAL_AUTONOMY_CONFIG: SocialAutonomyConfig =
  createDefaultSocialAutonomyConfig();

export {
  type EgressLeaseTunables,
  type ParticipationAppraiserSettings,
  type PassiveNameCandidateSettings,
  type ReservationPhaseSettings,
} from './participation-config.js';
export { type FreeTimeChooserSettings } from './free-time-chooser-config.js';

export const SCHEDULER_FILE_NAME = 'scheduler.json';
export const SCHEDULER_SEED_FILE_NAME = 'scheduler.seed.json';

export const DEFAULT_BACKGROUND_WORK_TUNING: BackgroundWorkRuntimeTuning = {
  supervisor: {
    maxConcurrentSessions: 4,
    leaseDurationMs: 5 * 60_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 5 * 60_000,
    shutdownTimeoutMs: 5_000,
    terminalRetentionMs: 7 * 24 * 60 * 60_000,
    cleanupIntervalMs: 60 * 60_000,
  },
  postTurn: {
    extractionDrainRequeueDelayMs: 1_000,
    foregroundPreemptionDeferDelayMs: 1_000,
  },
};

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
  /**
   * Cap on prior-episode candidates pulled for consolidation/dedup lookups
   * (zet.7). Optional key with an explicit default (24, mirrors
   * DEFAULT_MAX_PRIOR_CANDIDATES in the synthesizer) so existing operator
   * files keep validating.
   */
  maxPriorCandidates: number;
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
  /**
   * Messages pulled per episode transcript during consolidation (zet.7).
   * Optional key with an explicit default (200, mirrors
   * DEFAULT_TRANSCRIPT_MESSAGE_LIMIT in the consolidator) so existing
   * operator files keep validating.
   */
  transcriptMessageLimit: number;
  /**
   * Per-episode transcript character cap during consolidation (zet.7).
   * Optional key with an explicit default (6000, mirrors
   * DEFAULT_MAX_TRANSCRIPT_CHARS in the consolidator) so existing operator
   * files keep validating.
   */
  maxTranscriptCharsPerEpisode: number;
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
 * Deterministic novelty gate for cadence-fired reflection templates
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
 * Shared cadence for cheap background housekeeping. The runtime exposes every
 * operation attached to this tick in Garden; this is deliberately one honest
 * knob rather than a hidden alias or one interval per maintenance operation.
 */
export interface BackgroundMaintenanceConfig {
  /** Shared poll interval for every operation listed by the bundled task. */
  intervalMs: number;
  /** Bounded approved shared-world projection drift checks per maintenance tick. */
  sharedWorldWikiCaretaker: {
    batchSize: number;
  };
  /** Ambient-presence eligibility thresholds evaluated on the shared tick. */
  ambientPresence: {
    minIdleMinutes: number;
    minNoteIntervalMinutes: number;
  };
  /** Concern-set grooming threshold evaluated on the shared tick. */
  concernGrooming: {
    maxActiveConcerns: number;
  };
}

export const DEFAULT_BACKGROUND_MAINTENANCE_CONFIG: BackgroundMaintenanceConfig = {
  intervalMs: 3_600_000,
  sharedWorldWikiCaretaker: {
    batchSize: 25,
  },
  ambientPresence: {
    minIdleMinutes: 180,
    minNoteIntervalMinutes: 360,
  },
  concernGrooming: {
    maxActiveConcerns: 7,
  },
};

/**
 * Anti-starvation welfare reserve for durable background work (mmo9.7.4). A
 * background/reflection job repeatedly deferred by sustained foreground turns
 * accrues durable defer pressure; once it has been foreground-deferred
 * `deferThreshold` times OR its first foreground defer is at least
 * `ageThresholdMs` old, it becomes eligible to be admitted past the foreground
 * exclusion into one of `reserveSlots` globally bounded welfare slots, then runs
 * to a protected completion. This is Charter 8.8/8.9's ethical floor: reflection
 * and rest yield to conversation but are guaranteed a bounded slice rather than
 * being starved forever. Optional block — the conservative defaults apply when
 * absent. `reserveSlots: 0` disables welfare admission (fail-closed to FIFO).
 */
export interface BackgroundWorkWelfareConfig {
  deferThreshold: number;
  ageThresholdMs: number;
  reserveSlots: number;
}

export const DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG: BackgroundWorkWelfareConfig = {
  deferThreshold: 8,
  ageThresholdMs: 300_000,
  reserveSlots: 1,
};

/**
 * Social-graph builder worker tuning (E4.2). The worker proposes social-graph
 * edges from accumulated room evidence and only acts on memories past its
 * watermark. Its cadence is the shared `backgroundMaintenance.intervalMs`.
 * Optional block — conservative thresholds apply when absent.
 */
export interface SocialGraphBuilderCadenceConfig {
  /** Distinct co-presence windows required before an acquaintance is proposed. */
  coPresenceMinSessions: number;
  /** Fallback co-presence window size when a memory has no session id (minutes). */
  coPresenceWindowMinutes: number;
  /** Max memories scanned per run. */
  scanMemoryLimit: number;
}

export const DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE: SocialGraphBuilderCadenceConfig = {
  coPresenceMinSessions: 3,
  coPresenceWindowMinutes: 1440,
  scanMemoryLimit: 500,
};

/**
 * Scheduled morning wake lane (E7.1). At a configured wall-clock time, a warm
 * private channel may receive one model response turn. Its new-day note is
 * persisted only after that delivery; cold channels receive no scheduler row.
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
  /**
   * Partner-idle recency guard for the morning wake (minutes). At wake time,
   * partner activity younger than this means the temporal frame is already
   * current — the partner is actively conversing — so the morning note is
   * suppressed. Only a partner speaking right now blocks the note: a partner who
   * spoke overnight (e.g. 00:42 before an 08:00 wake) does NOT. 0 disables the
   * guard entirely. Non-negative.
   */
  minPartnerIdleMinutes: number;
  /** Max recent session entries fed to the shared catch-up summarizer. */
  catchUpEntryLimit: number;
  /** Token budget for the shared catch-up summary. */
  catchUpSummaryMaxTokens: number;
  /**
   * A full (LLM) wake turn is only invoked when the last partner exchange is
   * at most this old; staler sessions get no scheduler write or LLM call and
   * receive a fresh ephemeral frame only when they next become active.
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
 * Latest-only active-turn temporal frame (E7.1). After a long gap, the next
 * real model turn receives one freshly derived prompt frame. Idle clock
 * changes are never polled into, queued for, or persisted in session history.
 */
export interface TemporalWakeupIdleRefresherConfig {
  enabled: boolean;
  /** Retained owner-file field; active-turn derivation performs no polling. */
  checkIntervalMs: number;
  /** Minimum idle gap before the next active turn receives a temporal frame. */
  minIdleMinutes: number;
  /** Retained owner-file field; latest-only active-turn derivation cannot loop. */
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
  /**
   * Lookback window (hours) for wake-note fan-out (bead psfn-framework-2x37.3).
   * A channel is "recently active" — and therefore a fan-out target for the
   * morning wake / idle refresher internal notes — when it has partner
   * (role 'user') activity within this window. Notes fan out to every such
   * channel; outward delivery still targets only the single most-recent
   * partner channel. Positive integer.
   */
  activeChannelLookbackHours: number;
  morningWake: TemporalWakeupMorningConfig;
  idleRefresher: TemporalWakeupIdleRefresherConfig;
  wakeSummary: TemporalWakeupWakeSummaryConfig;
}

export const DEFAULT_TEMPORAL_WAKEUP_CONFIG: TemporalWakeupConfig = {
  enabled: true,
  activeChannelLookbackHours: 72,
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
    minPartnerIdleMinutes: 60,
    catchUpEntryLimit: 32,
    catchUpSummaryMaxTokens: 160,
    fullTurnMaxIdleHours: 72,
  },
  idleRefresher: {
    enabled: true,
    checkIntervalMs: 900_000,
    minIdleMinutes: 120,
    minNoteIntervalMinutes: 120,
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

function toInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 1000`);
  }
  return value;
}

function toBackgroundWorkPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid scheduler config: ${field} must be a positive safe integer`);
  }
  return value;
}

function toBackgroundWorkNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid scheduler config: ${field} must be a non-negative safe integer`);
  }
  return value;
}

function validateBackgroundWorkConfig(
  raw: unknown,
  sourcePath: string,
): BackgroundWorkRuntimeTuning {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: backgroundWork must be an object`);
  }
  assertNoUnknownKeys(raw, ['supervisor', 'postTurn'], `${sourcePath}.backgroundWork`, {
    errorPrefix: 'Invalid scheduler config',
  });
  if (!isRecord(raw.supervisor)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundWork.supervisor must be an object`,
    );
  }
  if (!isRecord(raw.postTurn)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundWork.postTurn must be an object`,
    );
  }
  assertNoUnknownKeys(
    raw.supervisor,
    [
      'maxConcurrentSessions',
      'leaseDurationMs',
      'retryBaseDelayMs',
      'retryMaxDelayMs',
      'shutdownTimeoutMs',
      'terminalRetentionMs',
      'cleanupIntervalMs',
    ],
    `${sourcePath}.backgroundWork.supervisor`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  assertNoUnknownKeys(
    raw.postTurn,
    ['extractionDrainRequeueDelayMs', 'foregroundPreemptionDeferDelayMs'],
    `${sourcePath}.backgroundWork.postTurn`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const supervisor = {
    maxConcurrentSessions: toBackgroundWorkPositiveInteger(
      raw.supervisor.maxConcurrentSessions,
      'backgroundWork.supervisor.maxConcurrentSessions',
    ),
    leaseDurationMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.leaseDurationMs,
      'backgroundWork.supervisor.leaseDurationMs',
    ),
    retryBaseDelayMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.retryBaseDelayMs,
      'backgroundWork.supervisor.retryBaseDelayMs',
    ),
    retryMaxDelayMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.retryMaxDelayMs,
      'backgroundWork.supervisor.retryMaxDelayMs',
    ),
    shutdownTimeoutMs: toBackgroundWorkNonNegativeInteger(
      raw.supervisor.shutdownTimeoutMs,
      'backgroundWork.supervisor.shutdownTimeoutMs',
    ),
    terminalRetentionMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.terminalRetentionMs,
      'backgroundWork.supervisor.terminalRetentionMs',
    ),
    cleanupIntervalMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.cleanupIntervalMs,
      'backgroundWork.supervisor.cleanupIntervalMs',
    ),
  };
  if (supervisor.retryMaxDelayMs < supervisor.retryBaseDelayMs) {
    throw new Error(
      'Invalid scheduler config: backgroundWork.supervisor.retryMaxDelayMs '
      + 'must be greater than or equal to backgroundWork.supervisor.retryBaseDelayMs',
    );
  }
  return {
    supervisor,
    postTurn: {
      extractionDrainRequeueDelayMs: toBackgroundWorkPositiveInteger(
        raw.postTurn.extractionDrainRequeueDelayMs,
        'backgroundWork.postTurn.extractionDrainRequeueDelayMs',
      ),
      foregroundPreemptionDeferDelayMs: toBackgroundWorkPositiveInteger(
        raw.postTurn.foregroundPreemptionDeferDelayMs,
        'backgroundWork.postTurn.foregroundPreemptionDeferDelayMs',
      ),
    },
  };
}

function toPositiveInteger(value: unknown, field: string, minimum: number): number {
  return assertPositiveInteger(value, field, {
    min: minimum,
    message: ({ fieldLabel, min }) => `Invalid scheduler config: ${fieldLabel} must be an integer >= ${min}`,
  });
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

/**
 * A dampening factor multiplied against a decayed weight. The valid range is the
 * half-open interval (0, 1]: a factor of 0 would hard-zero the weight on the
 * first application, silently disabling the mechanism and contradicting the
 * charter invariant that dampening "reduces weight rather than zeroing it out"
 * (Law 27 / 6.24). Fail closed — reject 0 and out-of-range rather than clamp.
 */
function toPositiveUnitFactor(value: unknown, field: string): number {
  const factor = toUnitFactor(value, field);
  if (!(factor > 0)) {
    throw new Error(
      `Invalid scheduler config: ${field} must be in (0, 1] — a factor of 0 hard-zeroes the weighted thought, disabling the dampening mechanism against Charter Law 27; use a small positive value to dampen without zeroing`,
    );
  }
  return factor;
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
    // zet.7: optional key, default mirrors DEFAULT_MAX_PRIOR_CANDIDATES (24)
    // in src/faculties/memory/episodic/synthesis.ts — keep in lockstep.
    maxPriorCandidates: raw.maxPriorCandidates === undefined
      ? 24
      : toPositiveInteger(raw.maxPriorCandidates, 'episodeSynthesis.maxPriorCandidates', 1),
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
    // zet.7: optional keys, defaults mirror DEFAULT_TRANSCRIPT_MESSAGE_LIMIT
    // (200) and DEFAULT_MAX_TRANSCRIPT_CHARS (6000) in
    // src/faculties/memory/episodic/sleep-consolidation.ts — keep in lockstep.
    transcriptMessageLimit: raw.transcriptMessageLimit === undefined
      ? 200
      : toPositiveInteger(raw.transcriptMessageLimit, 'sleepConsolidation.transcriptMessageLimit', 1),
    maxTranscriptCharsPerEpisode: raw.maxTranscriptCharsPerEpisode === undefined
      ? 6000
      : toPositiveInteger(raw.maxTranscriptCharsPerEpisode, 'sleepConsolidation.maxTranscriptCharsPerEpisode', 1),
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
  if (raw.intervalMs !== undefined) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: socialGraphBuilder.intervalMs was removed; `
      + 'the worker now uses backgroundMaintenance.intervalMs with the other bundled operations',
    );
  }
  return {
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

function validateBackgroundMaintenanceConfig(
  raw: unknown,
  sourcePath: string,
): BackgroundMaintenanceConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: backgroundMaintenance must be an object`);
  }
  if (!isRecord(raw.ambientPresence)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.ambientPresence must be an object`,
    );
  }
  if (!isRecord(raw.sharedWorldWikiCaretaker)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.sharedWorldWikiCaretaker must be an object`,
    );
  }
  assertNoUnknownKeys(
    raw.sharedWorldWikiCaretaker,
    ['batchSize'],
    `${sourcePath}.backgroundMaintenance.sharedWorldWikiCaretaker`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  if (!isRecord(raw.concernGrooming)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.concernGrooming must be an object`,
    );
  }
  return {
    intervalMs: toInterval(raw.intervalMs, 'backgroundMaintenance.intervalMs'),
    sharedWorldWikiCaretaker: {
      batchSize: toPositiveInteger(
        raw.sharedWorldWikiCaretaker.batchSize,
        'backgroundMaintenance.sharedWorldWikiCaretaker.batchSize',
        1,
      ),
    },
    ambientPresence: {
      minIdleMinutes: toPositiveInteger(
        raw.ambientPresence.minIdleMinutes,
        'backgroundMaintenance.ambientPresence.minIdleMinutes',
        1,
      ),
      minNoteIntervalMinutes: toPositiveInteger(
        raw.ambientPresence.minNoteIntervalMinutes,
        'backgroundMaintenance.ambientPresence.minNoteIntervalMinutes',
        1,
      ),
    },
    concernGrooming: {
      maxActiveConcerns: toPositiveInteger(
        raw.concernGrooming.maxActiveConcerns,
        'backgroundMaintenance.concernGrooming.maxActiveConcerns',
        1,
      ),
    },
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
      activeChannelLookbackHours: DEFAULT_TEMPORAL_WAKEUP_CONFIG.activeChannelLookbackHours,
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
    activeChannelLookbackHours: toPositiveInteger(
      raw.activeChannelLookbackHours ?? DEFAULT_TEMPORAL_WAKEUP_CONFIG.activeChannelLookbackHours,
      'temporalWakeup.activeChannelLookbackHours',
      1,
    ),
    morningWake: {
      enabled: toBoolean(morningRaw.enabled ?? morningDefaults.enabled, 'temporalWakeup.morningWake.enabled'),
      timing: toWakeTimingMode(morningRaw.timing ?? morningDefaults.timing, 'temporalWakeup.morningWake.timing'),
      localTime: toLocalTime(morningRaw.localTime ?? morningDefaults.localTime, 'temporalWakeup.morningWake.localTime'),
      timezone: toCadenceTimezone(morningRaw.timezone ?? morningDefaults.timezone, 'temporalWakeup.morningWake.timezone'),
      habit: validateTemporalWakeupHabitConfig(morningRaw.habit, sourcePath),
      minPartnerIdleMinutes: toNumberAtLeast(
        morningRaw.minPartnerIdleMinutes ?? morningDefaults.minPartnerIdleMinutes,
        'temporalWakeup.morningWake.minPartnerIdleMinutes',
        0,
      ),
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

function toNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 0`);
  }
  return value;
}

function validateBackgroundWorkWelfareConfig(
  value: unknown,
  sourcePath: string,
): BackgroundWorkWelfareConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: backgroundWorkWelfare must be an object`);
  }
  const reserveSlots = toNonNegativeInteger(
    value.reserveSlots ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG.reserveSlots,
    'backgroundWorkWelfare.reserveSlots',
  );
  // reserveSlots: 0 disables welfare; the aging thresholds are then irrelevant
  // but still validated for shape so a later enable cannot ship a bad value.
  return {
    deferThreshold: toPositiveInteger(
      value.deferThreshold ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG.deferThreshold,
      'backgroundWorkWelfare.deferThreshold',
      1,
    ),
    ageThresholdMs: toNonNegativeInteger(
      value.ageThresholdMs ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG.ageThresholdMs,
      'backgroundWorkWelfare.ageThresholdMs',
    ),
    reserveSlots,
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

function validateSocialAutonomyConfig(raw: unknown, sourcePath: string): SocialAutonomyConfig {
  if (raw === undefined) {
    return createDefaultSocialAutonomyConfig();
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialAutonomy must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['passiveNameCandidate', 'appraiser', 'reservationPhase', 'egressLease', 'freeTimeChooser'],
    `${sourcePath}.socialAutonomy`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  return {
    passiveNameCandidate: parsePassiveNameCandidateSettings(
      raw.passiveNameCandidate,
      `${sourcePath}.socialAutonomy.passiveNameCandidate`,
    ),
    appraiser: parseParticipationAppraiserSettings(
      raw.appraiser,
      `${sourcePath}.socialAutonomy.appraiser`,
    ),
    reservationPhase: parseReservationPhaseSettings(
      raw.reservationPhase,
      `${sourcePath}.socialAutonomy.reservationPhase`,
    ),
    egressLease: parseEgressLeaseTunables(
      raw.egressLease,
      `${sourcePath}.socialAutonomy.egressLease`,
    ),
    freeTimeChooser: parseFreeTimeChooserSettings(
      raw.freeTimeChooser,
      `${sourcePath}.socialAutonomy.freeTimeChooser`,
    ),
  };
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
