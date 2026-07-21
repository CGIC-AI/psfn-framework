import { describe, it, expect } from 'vitest';
import { buildCurrentDatetimeProximityAnchor } from './prompt-plan.js';

const FULL_VARIABLES = {
  active_timezone: 'America/New_York',
  runtime_current_weekday: 'Wednesday',
  runtime_current_date_human: 'March 18, 2026',
  runtime_current_time_human: '9:30 AM',
  runtime_current_datetime_iso: '2026-03-18T09:30:00.000-04:00',
  runtime_current_today: '2026-03-18',
  runtime_current_yesterday: '2026-03-17',
  runtime_current_tomorrow: '2026-03-19',
  runtime_current_part_of_day: 'late morning',
} as const;

describe('buildCurrentDatetimeProximityAnchor', () => {
  it('renders the current instant once in human-readable form only', () => {
    const anchor = buildCurrentDatetimeProximityAnchor(FULL_VARIABLES);
    expect(anchor).toBe(
      [
        '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,cross_channel_continuity">',
        '<timezone>America/New_York</timezone>',
        '<weekday>Wednesday</weekday>',
        '<date>March 18, 2026</date>',
        '<time>9:30 AM</time>',
        '<yesterday>2026-03-17</yesterday>',
        '<tomorrow>2026-03-19</tomorrow>',
        '<part_of_day>late morning</part_of_day>',
        '</runtime.current_datetime>',
      ].join('\n'),
    );
  });

  it('does not restate the same instant as an ISO timestamp or a YYYY-MM-DD "today"', () => {
    const anchor = buildCurrentDatetimeProximityAnchor(FULL_VARIABLES);
    expect(anchor).not.toContain('<iso>');
    expect(anchor).not.toContain('2026-03-18T09:30:00.000-04:00');
    expect(anchor).not.toContain('<today>');
    // The human-readable calendar date is still present exactly once.
    expect(anchor.match(/March 18, 2026/g)).toHaveLength(1);
  });

  it('still returns empty when the runtime clock variables are absent', () => {
    expect(buildCurrentDatetimeProximityAnchor({})).toBe('');
  });
});
