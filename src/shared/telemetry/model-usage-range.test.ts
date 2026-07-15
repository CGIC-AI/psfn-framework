import { describe, expect, it } from 'vitest';
import { resolveModelUsageRange } from './model-usage-range.js';

describe('resolveModelUsageRange', () => {
  it('resolves calendar ranges in the operator timezone with Monday weeks', () => {
    const nowMs = Date.parse('2026-07-14T15:30:00.000Z');
    expect(resolveModelUsageRange({
      range: 'quarter',
      timezone: 'America/New_York',
    }, { nowMs })).toMatchObject({
      range: 'quarter',
      timezone: 'America/New_York',
      sinceMs: Date.parse('2026-07-01T04:00:00.000Z'),
      untilMs: nowMs + 1,
      boundary: '[sinceMs, untilMs)',
      calendarWeekStartsOn: 'monday',
    });
  });

  it('honors spring-forward and fall-back day lengths', () => {
    const spring = resolveModelUsageRange({
      range: 'today', timezone: 'America/New_York', bucket: 'hour',
    }, { nowMs: Date.parse('2026-03-09T03:59:59.999Z') });
    expect(spring.untilMs - spring.sinceMs).toBe(23 * 60 * 60 * 1_000);

    const fall = resolveModelUsageRange({
      range: 'today', timezone: 'America/New_York', bucket: 'hour',
    }, { nowMs: Date.parse('2026-11-02T04:59:59.999Z') });
    expect(fall.untilMs - fall.sinceMs).toBe(25 * 60 * 60 * 1_000);
  });

  it.each([
    ['today', '2026-07-14T04:00:00.000Z', 'hour'],
    ['week', '2026-07-13T04:00:00.000Z', 'hour'],
    ['month', '2026-07-01T04:00:00.000Z', 'day'],
    ['quarter', '2026-07-01T04:00:00.000Z', 'day'],
    ['year', '2026-01-01T05:00:00.000Z', 'week'],
  ] as const)('resolves %s from %s with automatic %s buckets', (range, since, bucket) => {
    expect(resolveModelUsageRange({ range, timezone: 'America/New_York' }, {
      nowMs: Date.parse('2026-07-14T15:30:00.000Z'),
    })).toMatchObject({ sinceMs: Date.parse(since), bucket });
  });

  it('resolves all from the earliest filtered event and automatically uses month buckets', () => {
    const resolved = resolveModelUsageRange({ range: 'all', timezone: 'UTC' }, {
      nowMs: Date.parse('2026-07-14T15:30:00.000Z'),
      allSinceMs: Date.parse('2020-01-01T00:00:00.000Z'),
    });
    expect(resolved).toMatchObject({
      range: 'all',
      sinceMs: Date.parse('2020-01-01T00:00:00.000Z'),
      bucket: 'month',
    });
  });

  it.each([
    [{ range: 'custom', sinceMs: 1 }, 'requires sinceMs and untilMs'],
    [{ range: 'custom', sinceMs: 2, untilMs: 2 }, 'less than'],
    [{ range: 'custom', sinceMs: 1, untilMs: 40_000_000_000 }, 'at most'],
    [{ range: 'today', sinceMs: 1, untilMs: 2 }, 'cannot include'],
    [{ range: 'today', timezone: 'Not/AZone' }, 'timezone'],
    [{ range: 'year', bucket: 'hour' }, 'too many'],
  ])('fails closed for abusive or ambiguous query %#', (query, message) => {
    expect(() => resolveModelUsageRange(query, {
      nowMs: Date.parse('2026-07-14T12:00:00.000Z'),
    })).toThrow(message);
  });
});
