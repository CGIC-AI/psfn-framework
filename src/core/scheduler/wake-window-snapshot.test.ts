import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPORAL_WAKEUP_CONFIG } from '../../system/config/scheduler-config.js';
import type { TemporalWakeupMorningConfig } from '../../system/config/scheduler-config.js';
import type { StartupSessionMetadata } from '../session/manager.js';
import type { SessionEntry } from '../session/types.js';
import {
  buildWakeWindowSnapshot,
  resolveMorningWakeSnapshot,
  type TemporalWakeupSessionManagerPort,
} from './temporal-wakeup.js';

const TZ = 'UTC';
const DAY_MS = 24 * 60 * 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function morning(overrides: Partial<TemporalWakeupMorningConfig> = {}): TemporalWakeupMorningConfig {
  return {
    ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake,
    habit: { ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake.habit },
    timezone: 'utc',
    ...overrides,
  };
}

function dayAt(dayIndex: number, hour: number, minute = 0): number {
  return BASE + dayIndex * DAY_MS + hour * 60 * 60_000 + minute * 60_000;
}

function regularSleeperTimestamps(days: number, wakeHour: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < days; d += 1) {
    out.push(dayAt(d, wakeHour), dayAt(d, wakeHour + 2), dayAt(d, 14), dayAt(d, 20));
  }
  return out;
}

describe('buildWakeWindowSnapshot', () => {
  it('fixed mode: fires at the configured localTime, no history read', () => {
    const snapshot = buildWakeWindowSnapshot({
      morning: morning({ timing: 'fixed', localTime: '08:00' }),
      partnerTimestampsMs: regularSleeperTimestamps(20, 7),
      nowMs: dayAt(20, 12),
      timeZone: TZ,
    });
    expect(snapshot.timingMode).toBe('fixed');
    expect(snapshot.source).toBe('fixed');
    expect(snapshot.effective).toMatchObject({ hour: 8, minute: 0, localTime: '08:00' });
    expect(snapshot.window).toBeUndefined();
  });

  it('habit mode with sufficient history: fires at the deterministic median wake', () => {
    const snapshot = buildWakeWindowSnapshot({
      morning: morning({ timing: 'habit', localTime: '08:00' }),
      partnerTimestampsMs: regularSleeperTimestamps(20, 7),
      nowMs: dayAt(20, 12),
      timeZone: TZ,
    });
    expect(snapshot.timingMode).toBe('habit');
    expect(snapshot.source).toBe('habit');
    expect(snapshot.effective.localTime).toBe('07:00');
    expect(snapshot.window).toMatchObject({ medianLocalTime: '07:00' });
    expect(snapshot.fallbackReason).toBeUndefined();
    expect(snapshot.sampleDays).toBe(19);
  });

  it('habit mode with insufficient history: visible fallback to fixed time', () => {
    const snapshot = buildWakeWindowSnapshot({
      morning: morning({ timing: 'habit', localTime: '08:00' }),
      partnerTimestampsMs: [], // no history at all
      nowMs: dayAt(20, 12),
      timeZone: TZ,
    });
    expect(snapshot.timingMode).toBe('habit');
    expect(snapshot.source).toBe('habit_fallback');
    // Falls back to the configured fixed time...
    expect(snapshot.effective).toMatchObject({ hour: 8, minute: 0, localTime: '08:00' });
    // ...with a visible reason.
    expect(snapshot.fallbackReason).toBe('no_history');
    expect(snapshot.configuredLocalTime).toBe('08:00');
  });
});

// Minimal session-manager port stub exposing only the surfaces the snapshot
// resolver touches; the rest are unused no-ops.
function stubSessionManager(entries: SessionEntry[]): TemporalWakeupSessionManagerPort {
  const session: StartupSessionMetadata = {
    sessionId: 'api:habit-test',
    channelType: 'api',
  } as StartupSessionMetadata;
  return {
    resolveStartupSessionMetadata: () => session,
    getRecentMessages: () => entries,
    getRecentSessionEntries: () => entries,
    appendContextSystemNote: () => {},
  };
}

function userEntries(timestamps: number[]): SessionEntry[] {
  return timestamps.map((timestamp, index) => ({
    id: index + 1,
    channelId: 'api:habit-test',
    role: 'user',
    content: 'hi',
    timestamp,
  }));
}

describe('resolveMorningWakeSnapshot', () => {
  it('habit mode reads partner timestamps from the active session', () => {
    const port = stubSessionManager(userEntries(regularSleeperTimestamps(20, 7)));
    const snapshot = resolveMorningWakeSnapshot({
      sessionManager: port,
      morning: morning({ timing: 'habit' }),
      nowMs: dayAt(20, 12),
    });
    expect(snapshot.source).toBe('habit');
    expect(snapshot.effective.localTime).toBe('07:00');
    expect(snapshot.timeZone).toBe('UTC');
  });

  it('fixed mode ignores history entirely', () => {
    const port = stubSessionManager(userEntries(regularSleeperTimestamps(20, 7)));
    const snapshot = resolveMorningWakeSnapshot({
      sessionManager: port,
      morning: morning({ timing: 'fixed', localTime: '08:00' }),
      nowMs: dayAt(20, 12),
    });
    expect(snapshot.source).toBe('fixed');
    expect(snapshot.effective.localTime).toBe('08:00');
  });

  it('habit mode ignores assistant/system entries (partner-only)', () => {
    const assistantOnly: SessionEntry[] = regularSleeperTimestamps(20, 7).map((timestamp, index) => ({
      id: index + 1,
      channelId: 'api:habit-test',
      role: 'assistant',
      content: 'reply',
      timestamp,
    }));
    const port = stubSessionManager(assistantOnly);
    const snapshot = resolveMorningWakeSnapshot({
      sessionManager: port,
      morning: morning({ timing: 'habit' }),
      nowMs: dayAt(20, 12),
    });
    // No partner (role 'user') timestamps → insufficient → visible fallback.
    expect(snapshot.source).toBe('habit_fallback');
    expect(snapshot.fallbackReason).toBe('no_history');
  });
});
