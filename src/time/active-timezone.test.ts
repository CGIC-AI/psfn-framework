import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureActiveTimezone,
  formatActiveDate,
  formatActiveDateTimeCompact,
  formatActiveDateTimeIso,
  formatActiveDateTimeLabel,
  formatActiveTime,
} from './active-timezone.js';

const ORIGINAL_TZ = process.env.TZ;

describe('active-timezone', () => {
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it('defaults runtime formatting to America/New_York', () => {
    delete process.env.TZ;
    const now = new Date('2026-02-20T13:45:27.123Z');

    expect(ensureActiveTimezone()).toBe('America/New_York');
    expect(formatActiveDateTimeIso(now)).toBe('2026-02-20T08:45:27.123-05:00');
    expect(formatActiveDateTimeCompact(now)).toBe('02-20-26 08:45');
    expect(formatActiveDate(now)).toBe('2026-02-20');
    expect(formatActiveTime(now)).toBe('08:45:27-05:00');
    expect(formatActiveDateTimeLabel(now)).toBe('02-20-26 08:45 America/New_York');
  });

  it('tracks daylight-saving transitions for Eastern Time', () => {
    process.env.TZ = 'America/New_York';

    expect(formatActiveDateTimeIso(new Date('2026-01-15T12:00:00.000Z'))).toBe('2026-01-15T07:00:00.000-05:00');
    expect(formatActiveDateTimeIso(new Date('2026-07-15T12:00:00.000Z'))).toBe('2026-07-15T08:00:00.000-04:00');
  });

  it('fails closed for invalid configured timezones', () => {
    process.env.TZ = 'Not/AZone';
    expect(() => ensureActiveTimezone()).toThrow(/Invalid time zone specified|time zone/i);
  });
});
