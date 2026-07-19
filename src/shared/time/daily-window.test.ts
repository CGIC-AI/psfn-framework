import { describe, expect, it } from 'vitest';
import {
  getLocalMinuteOfDay,
  isMinuteInWindow,
  parseLocalMinute,
  resolveConfiguredTimeZone,
} from './daily-window.js';

describe('daily-window helpers', () => {
  it('parses configured local times as minutes after midnight', () => {
    expect(parseLocalMinute('00:00')).toBe(0);
    expect(parseLocalMinute('23:59')).toBe(1_439);
  });

  it('evaluates ordinary, wrap-around, and all-day windows', () => {
    expect(isMinuteInWindow(9 * 60, 8 * 60, 10 * 60)).toBe(true);
    expect(isMinuteInWindow(10 * 60, 8 * 60, 10 * 60)).toBe(false);
    expect(isMinuteInWindow(23 * 60, 22 * 60, 6 * 60)).toBe(true);
    expect(isMinuteInWindow(5 * 60 + 59, 22 * 60, 6 * 60)).toBe(true);
    expect(isMinuteInWindow(12 * 60, 22 * 60, 6 * 60)).toBe(false);
    expect(isMinuteInWindow(12 * 60, 7 * 60, 7 * 60)).toBe(true);
  });

  it('resolves local minutes across the US spring DST boundary', () => {
    expect(getLocalMinuteOfDay(Date.parse('2025-03-09T06:59:00Z'), 'America/New_York'))
      .toBe(1 * 60 + 59);
    expect(getLocalMinuteOfDay(Date.parse('2025-03-09T07:01:00Z'), 'America/New_York'))
      .toBe(3 * 60 + 1);
  });

  it('leaves explicit IANA timezones unchanged', () => {
    expect(resolveConfiguredTimeZone('Europe/London')).toBe('Europe/London');
  });
});
