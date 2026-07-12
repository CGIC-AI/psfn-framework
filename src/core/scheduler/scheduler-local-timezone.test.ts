import { beforeEach, describe, expect, it, vi } from 'vitest';

// The active timezone is mocked to America/New_York while the process TZ is
// pinned to UTC below. This proves getCurrentSlotStart computes wall-clock slots
// in the active timezone via Intl, independent of the process-local TZ.
vi.mock('../../shared/time/active-timezone.js', () => ({
  resolveActiveTimezone: () => 'America/New_York',
}));

import { getCurrentSlotStart } from './scheduler.js';
import type {
  DailyRecurringCadence,
  HourlyRecurringCadence,
  WeeklyRecurringCadence,
} from './types.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('getCurrentSlotStart — active-timezone wall-clock slots', () => {
  beforeEach(() => {
    // Process TZ is UTC; the active timezone (mocked) is America/New_York.
    vi.stubEnv('TZ', 'UTC');
  });

  describe('daily cadence', () => {
    const dailyLocal: DailyRecurringCadence = {
      kind: 'daily',
      hour: 8,
      minute: 0,
      timezone: 'local',
    };

    it('resolves an 08:00 local slot to 13:00Z during EST', () => {
      const now = Date.parse('2026-02-15T14:00:00.000Z');
      expect(iso(getCurrentSlotStart(now, dailyLocal))).toBe('2026-02-15T13:00:00.000Z');
    });

    it('resolves an 08:00 local slot to 12:00Z during EDT', () => {
      const now = Date.parse('2026-07-15T14:00:00.000Z');
      expect(iso(getCurrentSlotStart(now, dailyLocal))).toBe('2026-07-15T12:00:00.000Z');
    });

    it('rolls back to the previous local day before the slot fires', () => {
      // 06:00Z is 01:00 EST — before today's 08:00 local slot — so the current
      // slot is yesterday's 08:00 local (2026-02-14 08:00 EST = 13:00Z).
      const now = Date.parse('2026-02-15T06:00:00.000Z');
      expect(iso(getCurrentSlotStart(now, dailyLocal))).toBe('2026-02-14T13:00:00.000Z');
    });

    it('leaves the utc cadence unaffected by the active timezone', () => {
      const dailyUtc: DailyRecurringCadence = { ...dailyLocal, timezone: 'utc' };
      const now = Date.parse('2026-02-15T14:00:00.000Z');
      expect(iso(getCurrentSlotStart(now, dailyUtc))).toBe('2026-02-15T08:00:00.000Z');
    });
  });

  describe('hourly cadence', () => {
    it('aligns an :30 local slot to the most recent past wall-clock minute', () => {
      const hourly: HourlyRecurringCadence = {
        kind: 'hourly',
        minute: 30,
        timezone: 'local',
      };
      // 14:10Z is 09:10 EST; this hour's :30 (14:30Z) is still future, so the
      // current slot is 08:30 EST = 13:30Z.
      const now = Date.parse('2026-02-15T14:10:00.000Z');
      expect(iso(getCurrentSlotStart(now, hourly))).toBe('2026-02-15T13:30:00.000Z');
    });
  });

  describe('weekly cadence', () => {
    it('resolves a Sunday 07:00 local slot to the prior Sunday', () => {
      const weekly: WeeklyRecurringCadence = {
        kind: 'weekly',
        dayOfWeek: 0,
        hour: 7,
        minute: 0,
        timezone: 'local',
      };
      // 2026-02-18T14:00Z is a Wednesday (09:00 EST); the current slot is the
      // most recent Sunday 07:00 EST = 2026-02-15 12:00Z.
      const now = Date.parse('2026-02-18T14:00:00.000Z');
      expect(iso(getCurrentSlotStart(now, weekly))).toBe('2026-02-15T12:00:00.000Z');
    });
  });

  describe('DST spring-forward (2026-03-08, US Eastern)', () => {
    // On 2026-03-08 clocks jump 02:00 EST -> 03:00 EDT, so a 02:30 local wall
    // time does not exist. Documented deterministic choice: the nonexistent time
    // resolves to the pre-transition offset instant (02:30 interpreted at EDT),
    // i.e. 2026-03-08T06:30Z (01:30 EST). It maps to a single slot for the day.
    const dailyEarly: DailyRecurringCadence = {
      kind: 'daily',
      hour: 2,
      minute: 30,
      timezone: 'local',
    };

    it('maps the nonexistent 02:30 local slot deterministically to 06:30Z', () => {
      const now = Date.parse('2026-03-08T12:00:00.000Z');
      expect(iso(getCurrentSlotStart(now, dailyEarly))).toBe('2026-03-08T06:30:00.000Z');
    });

    it('does not double-fire: the slot is stable across the DST day', () => {
      const early = getCurrentSlotStart(Date.parse('2026-03-08T07:00:00.000Z'), dailyEarly);
      const later = getCurrentSlotStart(Date.parse('2026-03-08T12:00:00.000Z'), dailyEarly);
      expect(early).toBe(later);
      expect(iso(early)).toBe('2026-03-08T06:30:00.000Z');
    });
  });
});
