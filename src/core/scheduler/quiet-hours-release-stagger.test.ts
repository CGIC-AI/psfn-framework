import { describe, expect, it } from 'vitest';
import { evaluateProactiveOutboundTimeGate } from '../intention/proactive-time-gate.js';
import {
  createFleetOutwardQuietHoursResolver,
  quietHoursReleaseOffsetMinutes,
  staggerQuietHoursRelease,
} from './quiet-hours-release-stagger.js';

const quietHours = {
  enabled: true,
  startLocalTime: '00:00',
  endLocalTime: '09:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 60,
};
const HOUR_MS = 3_600_000;
const FLEET = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

describe('staggerQuietHoursRelease', () => {
  it('pushes only the release end back by the companion fleet offset', () => {
    const stagger = { manifestOrdinal: 2, fleetSize: 3, windowMs: HOUR_MS };
    expect(quietHoursReleaseOffsetMinutes(stagger)).toBe(40);
    expect(staggerQuietHoursRelease(quietHours, stagger)).toEqual({
      ...quietHours,
      endLocalTime: '09:40',
    });
    // Other fields (rest-window inactivity threshold) are carried untouched.
    expect(staggerQuietHoursRelease(quietHours, stagger).inactivityThresholdMinutes).toBe(60);
  });

  it('leaves the configured window alone outside a fleet, when disabled, all-day, or at offset zero', () => {
    expect(staggerQuietHoursRelease(quietHours, undefined)).toBe(quietHours);
    expect(staggerQuietHoursRelease({ ...quietHours, enabled: false }, {
      manifestOrdinal: 1, fleetSize: 3, windowMs: HOUR_MS,
    }).endLocalTime).toBe('09:00');
    const allDay = { ...quietHours, endLocalTime: '00:00' };
    expect(staggerQuietHoursRelease(allDay, { manifestOrdinal: 1, fleetSize: 3, windowMs: HOUR_MS })).toBe(allDay);
    expect(staggerQuietHoursRelease(quietHours, { manifestOrdinal: 0, fleetSize: 3, windowMs: HOUR_MS })).toBe(quietHours);
  });

  it('wraps an end past midnight and fails closed when the window would swallow the day', () => {
    const lateWindow = { ...quietHours, startLocalTime: '22:00', endLocalTime: '23:50' };
    expect(staggerQuietHoursRelease(lateWindow, { manifestOrdinal: 1, fleetSize: 2, windowMs: HOUR_MS }).endLocalTime)
      .toBe('00:20');
    const nearlyAllDay = { ...quietHours, startLocalTime: '09:30', endLocalTime: '09:00' };
    expect(() => staggerQuietHoursRelease(nearlyAllDay, { manifestOrdinal: 1, fleetSize: 2, windowMs: HOUR_MS }))
      .toThrow('across the whole day');
  });
});

describe('fleet quiet-hours release through the proactive time gate', () => {
  it('releases each companion at its own offset instead of all at 09:00', () => {
    const resolve = createFleetOutwardQuietHoursResolver({
      quietHours,
      fleetCompanionIds: FLEET,
      windowMs: HOUR_MS,
    });
    const releaseAt = FLEET.map(companionId => {
      const decision = evaluateProactiveOutboundTimeGate({
        nowMs: Date.parse('2026-09-24T08:59:00.000Z'),
        quietHours: resolve(companionId),
      });
      return decision.allowed ? null : new Date(decision.nextEligibleAtMs).toISOString();
    });
    expect(releaseAt).toEqual([
      '2026-09-24T09:00:00.000Z',
      '2026-09-24T09:20:00.000Z',
      '2026-09-24T09:40:00.000Z',
    ]);
    // Never earlier than the operator allowed; unknown companions keep the configured window.
    expect(resolve('00000000-0000-4000-8000-0000000000ff')).toBe(quietHours);
  });
});
