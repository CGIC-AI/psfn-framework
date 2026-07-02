// ── Habit-derived wake-window estimator (E7.2) ──
// A deterministic, no-LLM estimator that infers the partner's morning wake
// window from the timestamps of their own messages (role 'user') over a
// trailing history, then lets the morning-wake lane fire inside that estimated
// window instead of a fixed wall-clock time.
//
// Estimation approach (documented decision):
//
//  1. Nightly sleep gap → wake time. People stop messaging when they sleep and
//     resume when they wake. For each local calendar day we find the largest
//     inter-message gap whose END (the first message after the silence) lands
//     in a plausible morning "wake band" (default 03:00–12:00 local) and whose
//     duration clears a minimum sleep-gap threshold (default 4h). The local
//     time of that gap-end message is that day's WAKE SAMPLE. Restricting the
//     gap end to a morning band means every sample is a linear minute-of-day
//     inside a single non-midnight-wrapping window, so we can aggregate with
//     ordinary arithmetic and never need circular statistics.
//
//  2. Robust aggregation. One sample per day (the largest qualifying gap wins,
//     so a 3 a.m. "woke to pee" blip loses to the real morning resumption).
//     Across days we take WEIGHTED QUANTILES of the samples: the trailing
//     recent window (default 7 days) is weighted more heavily than the older
//     extended window (default 30 days) so a genuine schedule shift is followed
//     while a single odd day cannot swing the estimate. Quantiles (not mean)
//     make the estimate robust to outliers.
//
//  3. Deterministic firing point. The scheduled wake fires at the WEIGHTED
//     MEDIAN (p50) sample — a single defined point, never randomised. The
//     reported window is [lowerQuantile, upperQuantile] (default p25..p75) and
//     exists only for visibility; the fire time is always the median.
//
//  4. Fail-closed sufficiency. If fewer than `minSampleDays` distinct days
//     contribute a sample, the estimate is INSUFFICIENT and the caller falls
//     back to the fixed configured wake time with a visible reason. An
//     irregular sleeper (no recurring overnight gap ending in the wake band)
//     therefore never produces a confident-but-wrong window.
//
// Data source: partner message timestamps only. Callers feed timestamps pulled
// from the cheapest existing session surface (SessionManager.getRecentSessionEntries
// / the session store's getRecent tail) filtered to role 'user'. This module
// adds NO new projection; it is pure arithmetic over timestamps.
//
// Future extension (do NOT build here): a SensorIngestPort feed
// (src/shared/telemetry/sensor-ingest-port.ts — heart rate, motion, activity)
// could sharpen "woke up to pee at 3 a.m." vs "actually awake and doing
// things" by supplying non-message wake evidence. That evidence would enter
// this estimator as additional dated wake samples with their own weight; the
// aggregation math below is intentionally sample-source-agnostic so the port
// can be wired later without reshaping the estimator. Sensor ingestion itself
// is charter Phase 11 and out of scope for E7.2.

import type { TemporalWakeupHabitConfig } from '../../system/config/scheduler-config.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTES_PER_DAY = 24 * 60;

export type WakeWindowInsufficientReason =
  | 'no_history'
  | 'no_recurring_sleep_gap'
  | 'insufficient_sample_days';

export interface WakeWindowSample {
  /** Local calendar day (YYYY-MM-DD) the wake sample belongs to. */
  dateKey: string;
  /** Local minute-of-day (0..1439) of the gap-end message. */
  wakeMinuteOfDay: number;
  /** Duration of the qualifying overnight gap that produced this sample (ms). */
  sleepGapMs: number;
  /** Weight applied during aggregation (recent window weighted heavier). */
  weight: number;
}

export type WakeWindowEstimate =
  | {
    sufficient: true;
    /** Deterministic fire point: weighted-median local minute-of-day (0..1439). */
    wakeMinuteOfDay: number;
    /** Visibility-only window lower bound: weighted lowerQuantile minute-of-day. */
    windowStartMinuteOfDay: number;
    /** Visibility-only window upper bound: weighted upperQuantile minute-of-day. */
    windowEndMinuteOfDay: number;
    /** Distinct local days that contributed a wake sample. */
    sampleDays: number;
    /** The per-day samples used, ascending by day. */
    samples: readonly WakeWindowSample[];
    /** Local time zone the estimate was computed in. */
    timeZone: string;
  }
  | {
    sufficient: false;
    reason: WakeWindowInsufficientReason;
    /** Distinct local days that contributed a wake sample (may be 0). */
    sampleDays: number;
    samples: readonly WakeWindowSample[];
    timeZone: string;
  };

export interface WakeWindowEstimateInput {
  /** Partner (role 'user') message timestamps in ms; order does not matter. */
  partnerTimestampsMs: readonly number[];
  /** Reference "now" (ms) anchoring the trailing windows. */
  nowMs: number;
  /** IANA zone (or resolved local) the wake time is expressed in. */
  timeZone: string;
  config: TemporalWakeupHabitConfig;
}

interface LocalWallClock {
  dateKey: string;
  minuteOfDay: number;
  hour: number;
}

/**
 * Local wall-clock breakdown of a timestamp in the given zone. Uses the same
 * Intl-based local-time semantics the temporal wake-up lanes already use.
 */
function localWallClock(timestampMs: number, timeZone: string): LocalWallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  // Intl can render midnight as hour '24' under hour12:false; normalize.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute) % 60;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute,
    hour,
  };
}

/**
 * Weighted quantile over samples sorted ascending by value, using the "lower"
 * convention: the smallest sample value whose cumulative weight fraction
 * reaches `quantile`. Deterministic (stable order, defined tie-break).
 */
function weightedQuantile(
  sorted: readonly { value: number; weight: number }[],
  totalWeight: number,
  quantile: number,
): number {
  if (sorted.length === 0) return 0;
  const target = quantile * totalWeight;
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += sample.weight;
    if (cumulative >= target) return sample.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/**
 * Estimate the partner's morning wake window from their message timestamps.
 * Pure and deterministic: identical inputs always yield an identical estimate.
 */
export function estimateWakeWindow(input: WakeWindowEstimateInput): WakeWindowEstimate {
  const { timeZone, nowMs, config } = input;
  const minSleepGapMs = config.minSleepGapHours * HOUR_MS;
  const extendedCutoff = nowMs - config.extendedWindowDays * DAY_MS;
  const recentCutoff = nowMs - config.recentWindowDays * DAY_MS;

  // Bound the scan and keep only in-window timestamps, ascending.
  const timestamps = [...input.partnerTimestampsMs]
    .filter(ts => Number.isFinite(ts) && ts >= extendedCutoff && ts <= nowMs)
    .sort((left, right) => left - right)
    .slice(-Math.max(1, config.maxSamplesScanned));

  if (timestamps.length < 2) {
    return { sufficient: false, reason: 'no_history', sampleDays: 0, samples: [], timeZone };
  }

  // Per local day, keep the largest qualifying overnight gap whose end lands in
  // the wake band. The gap end is the first message after the silence.
  const bestByDay = new Map<string, WakeWindowSample>();
  for (let i = 1; i < timestamps.length; i += 1) {
    const prev = timestamps[i - 1]!;
    const cur = timestamps[i]!;
    const gapMs = cur - prev;
    if (gapMs < minSleepGapMs) continue;
    const end = localWallClock(cur, timeZone);
    if (end.hour < config.wakeBandStartHour || end.hour >= config.wakeBandEndHour) continue;

    const weight = cur >= recentCutoff ? config.recentWeight : config.extendedWeight;
    const existing = bestByDay.get(end.dateKey);
    if (!existing || gapMs > existing.sleepGapMs) {
      bestByDay.set(end.dateKey, {
        dateKey: end.dateKey,
        wakeMinuteOfDay: end.minuteOfDay,
        sleepGapMs: gapMs,
        weight,
      });
    }
  }

  const samples = [...bestByDay.values()].sort((left, right) =>
    left.dateKey < right.dateKey ? -1 : left.dateKey > right.dateKey ? 1 : 0,
  );
  const sampleDays = samples.length;

  if (sampleDays === 0) {
    return { sufficient: false, reason: 'no_recurring_sleep_gap', sampleDays, samples, timeZone };
  }
  if (sampleDays < config.minSampleDays) {
    return { sufficient: false, reason: 'insufficient_sample_days', sampleDays, samples, timeZone };
  }

  const sortedByWake = samples
    .map(sample => ({ value: sample.wakeMinuteOfDay, weight: sample.weight }))
    .sort((left, right) => left.value - right.value);
  const totalWeight = sortedByWake.reduce((sum, sample) => sum + sample.weight, 0);

  const wakeMinuteOfDay = weightedQuantile(sortedByWake, totalWeight, 0.5);
  const rawStart = weightedQuantile(sortedByWake, totalWeight, config.lowerQuantile);
  const rawEnd = weightedQuantile(sortedByWake, totalWeight, config.upperQuantile);
  // Guarantee start <= median <= end even if quantile config is unusual.
  const windowStartMinuteOfDay = Math.min(rawStart, wakeMinuteOfDay);
  const windowEndMinuteOfDay = Math.max(rawEnd, wakeMinuteOfDay);

  return {
    sufficient: true,
    wakeMinuteOfDay: clampMinute(wakeMinuteOfDay),
    windowStartMinuteOfDay: clampMinute(windowStartMinuteOfDay),
    windowEndMinuteOfDay: clampMinute(windowEndMinuteOfDay),
    sampleDays,
    samples,
    timeZone,
  };
}

function clampMinute(minute: number): number {
  if (!Number.isFinite(minute)) return 0;
  return Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.round(minute)));
}

/** Format a local minute-of-day (0..1439) as HH:mm. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const clamped = clampMinute(minuteOfDay);
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function minuteOfDayToHourMinute(minuteOfDay: number): { hour: number; minute: number } {
  const clamped = clampMinute(minuteOfDay);
  return { hour: Math.floor(clamped / 60), minute: clamped % 60 };
}
