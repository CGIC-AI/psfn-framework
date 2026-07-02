import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPORAL_WAKEUP_CONFIG } from '../../system/config/scheduler-config.js';
import {
  estimateWakeWindow,
  formatMinuteOfDay,
  minuteOfDayToHourMinute,
} from './wake-window-estimator.js';

// All fixtures are anchored in UTC so local-minute-of-day is host-TZ-independent.
const TZ = 'UTC';
const HABIT = DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake.habit;
const DAY_MS = 24 * 60 * 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0); // Jan 1 2026 00:00 UTC

function dayAt(dayIndex: number, hour: number, minute = 0): number {
  return BASE + dayIndex * DAY_MS + hour * 60 * 60_000 + minute * 60_000;
}

/**
 * One day's partner messages: intraday activity plus a fixed morning "wake"
 * message. The overnight gap (previous day 20:00 → this day `wakeHour`:mm) is
 * the only gap that both clears 4h AND ends inside the wake band.
 */
function dayMessages(dayIndex: number, wakeHour: number, wakeMinute = 0): number[] {
  return [
    dayAt(dayIndex, wakeHour, wakeMinute),
    dayAt(dayIndex, wakeHour + 2),
    dayAt(dayIndex, 14),
    dayAt(dayIndex, 20),
  ];
}

function history(days: number, wakeHour: number, wakeMinute = 0): number[] {
  const out: number[] = [];
  for (let d = 0; d < days; d += 1) out.push(...dayMessages(d, wakeHour, wakeMinute));
  return out;
}

describe('estimateWakeWindow', () => {
  it('regular sleeper: median wake = the recurring morning resumption time', () => {
    const estimate = estimateWakeWindow({
      partnerTimestampsMs: history(20, 7, 5),
      nowMs: dayAt(20, 12),
      timeZone: TZ,
      config: HABIT,
    });
    expect(estimate.sufficient).toBe(true);
    if (!estimate.sufficient) return;
    // Each of days 1..19 contributes one 07:05 overnight-gap sample.
    expect(estimate.sampleDays).toBe(19);
    expect(formatMinuteOfDay(estimate.wakeMinuteOfDay)).toBe('07:05');
    // Window collapses to the single mode when every day agrees.
    expect(estimate.windowStartMinuteOfDay).toBe(estimate.wakeMinuteOfDay);
    expect(estimate.windowEndMinuteOfDay).toBe(estimate.wakeMinuteOfDay);
  });

  it('is deterministic: identical input yields identical estimate', () => {
    const input = {
      partnerTimestampsMs: history(20, 7, 5),
      nowMs: dayAt(20, 12),
      timeZone: TZ,
      config: HABIT,
    };
    expect(estimateWakeWindow(input)).toEqual(estimateWakeWindow(input));
  });

  it('shifted schedule: recent-window weighting follows a mid-window +2h shift', () => {
    // Days 0..7 wake at 07:00 (older, weight 1); days 8..14 wake at 09:00
    // (inside the trailing 7-day recent window, weight 2). now = day 15 noon.
    const older = history(8, 7);
    const shifted: number[] = [];
    for (let d = 8; d < 15; d += 1) shifted.push(...dayMessages(d, 9));
    const estimate = estimateWakeWindow({
      partnerTimestampsMs: [...older, ...shifted],
      nowMs: dayAt(15, 12),
      timeZone: TZ,
      config: HABIT,
    });
    expect(estimate.sufficient).toBe(true);
    if (!estimate.sufficient) return;
    // Recent double-weighted 09:00 samples pull the weighted median up to 09:00.
    expect(minuteOfDayToHourMinute(estimate.wakeMinuteOfDay).hour).toBe(9);
  });

  it('pre-shift-only history keeps the median at the original wake time', () => {
    const estimate = estimateWakeWindow({
      partnerTimestampsMs: history(15, 7),
      nowMs: dayAt(15, 12),
      timeZone: TZ,
      config: HABIT,
    });
    expect(estimate.sufficient).toBe(true);
    if (!estimate.sufficient) return;
    expect(minuteOfDayToHourMinute(estimate.wakeMinuteOfDay).hour).toBe(7);
  });

  it('irregular sleeper: too few sample days → insufficient (fallback signal)', () => {
    // Only 2 days have a morning-band overnight gap; the rest are daytime-only.
    const sparse: number[] = [
      ...dayMessages(0, 7),
      ...dayMessages(1, 7),
      // days 2..10: only afternoon/evening messages, no morning resumption
      ...Array.from({ length: 9 }, (_, i) => [dayAt(2 + i, 13), dayAt(2 + i, 15), dayAt(2 + i, 19)]).flat(),
    ];
    const estimate = estimateWakeWindow({
      partnerTimestampsMs: sparse,
      nowMs: dayAt(11, 12),
      timeZone: TZ,
      config: HABIT,
    });
    expect(estimate.sufficient).toBe(false);
    if (estimate.sufficient) return;
    expect(estimate.reason).toBe('insufficient_sample_days');
    expect(estimate.sampleDays).toBeLessThan(HABIT.minSampleDays);
  });

  it('no recurring overnight gap in the wake band → no_recurring_sleep_gap', () => {
    // Continuous daytime chatter, gaps never land in [03:00,12:00).
    const daytimeOnly = Array.from({ length: 10 }, (_, d) =>
      [dayAt(d, 13), dayAt(d, 16), dayAt(d, 19), dayAt(d, 22)]).flat();
    const estimate = estimateWakeWindow({
      partnerTimestampsMs: daytimeOnly,
      nowMs: dayAt(10, 23),
      timeZone: TZ,
      config: HABIT,
    });
    expect(estimate.sufficient).toBe(false);
    if (estimate.sufficient) return;
    expect(estimate.reason).toBe('no_recurring_sleep_gap');
  });

  it('empty / single-message history → no_history', () => {
    const empty = estimateWakeWindow({ partnerTimestampsMs: [], nowMs: dayAt(5, 12), timeZone: TZ, config: HABIT });
    expect(empty.sufficient).toBe(false);
    if (!empty.sufficient) expect(empty.reason).toBe('no_history');

    const single = estimateWakeWindow({
      partnerTimestampsMs: [dayAt(3, 8)],
      nowMs: dayAt(5, 12),
      timeZone: TZ,
      config: HABIT,
    });
    expect(single.sufficient).toBe(false);
    if (!single.sufficient) expect(single.reason).toBe('no_history');
  });

  it('largest overnight gap wins over a 3 a.m. "woke to pee" blip', () => {
    // Each day: a brief 03:00 wake (short gap before it) then the real 08:00
    // resumption after the long overnight silence. The 08:00 gap is larger.
    const msgs: number[] = [];
    for (let d = 0; d < 10; d += 1) {
      msgs.push(dayAt(d, 2, 55)); // 02:55 — just before a 3am blip
      msgs.push(dayAt(d, 3, 0)); // 03:00 blip (tiny 5-min gap, not a sleep gap)
      msgs.push(dayAt(d, 8, 0)); // 08:00 real wake (5h gap from 03:00)
      msgs.push(dayAt(d, 20, 0)); // evening
    }
    const estimate = estimateWakeWindow({
      partnerTimestampsMs: msgs,
      nowMs: dayAt(10, 12),
      timeZone: TZ,
      config: HABIT,
    });
    expect(estimate.sufficient).toBe(true);
    if (!estimate.sufficient) return;
    // Overnight 20:00 → 02:55 (~7h) vs 03:00 → 08:00 (5h): the longer overnight
    // gap ends at 02:55 which is OUTSIDE the band, so the qualifying pick is the
    // 08:00 resumption. Median must be 08:00, not the 3am blip.
    expect(formatMinuteOfDay(estimate.wakeMinuteOfDay)).toBe('08:00');
  });
});

describe('formatMinuteOfDay / minuteOfDayToHourMinute', () => {
  it('round-trips minute-of-day to HH:mm and hour/minute', () => {
    expect(formatMinuteOfDay(0)).toBe('00:00');
    expect(formatMinuteOfDay(7 * 60 + 5)).toBe('07:05');
    expect(formatMinuteOfDay(23 * 60 + 59)).toBe('23:59');
    expect(minuteOfDayToHourMinute(9 * 60 + 30)).toEqual({ hour: 9, minute: 30 });
  });

  it('clamps out-of-range minutes', () => {
    expect(formatMinuteOfDay(-5)).toBe('00:00');
    expect(formatMinuteOfDay(99_999)).toBe('23:59');
  });
});
