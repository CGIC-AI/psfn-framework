import { isRecord } from '../../../shared/utils/types.js';
import {
  toBoolean,
  toCadenceTimezone,
  toHourOfDay,
  toInterval,
  toLocalTime,
  toNumberAtLeast,
  toPositiveInteger,
  toPositiveNumber,
  toUnitInterval,
  toWakeTimingMode,
} from './primitives.js';

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

export function validateTemporalWakeupConfig(
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
