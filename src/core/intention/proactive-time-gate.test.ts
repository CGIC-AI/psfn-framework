import { describe, expect, it } from 'vitest';
import { evaluateProactiveOutboundTimeGate, type ProactiveQuietHoursConfig } from './proactive-time-gate.js';

const quietHours: ProactiveQuietHoursConfig = {
  enabled: true,
  startLocalTime: '00:00',
  endLocalTime: '08:00',
  timeZone: 'UTC',
};

describe('evaluateProactiveOutboundTimeGate', () => {
  it('holds future-dated outbound messages until the date boundary is outside quiet hours', () => {
    const nowMs = Date.parse('2026-06-15T18:00:00.000Z');
    const earliestSendAtMs = Date.parse('2026-06-16T00:00:00.000Z');

    expect(evaluateProactiveOutboundTimeGate({
      nowMs,
      earliestSendAtMs,
      quietHours,
    })).toEqual({
      allowed: false,
      reason: 'before_time_gate',
      nextEligibleAtMs: Date.parse('2026-06-16T08:00:00.000Z'),
      timeZone: 'UTC',
    });
  });

  it('blocks immediate outbound messages during quiet hours until the window ends', () => {
    const nowMs = Date.parse('2026-06-16T02:30:00.000Z');

    expect(evaluateProactiveOutboundTimeGate({
      nowMs,
      quietHours,
    })).toEqual({
      allowed: false,
      reason: 'quiet_hours',
      nextEligibleAtMs: Date.parse('2026-06-16T08:00:00.000Z'),
      timeZone: 'UTC',
    });
  });

  it('allows outbound messages after the date boundary when quiet hours are clear', () => {
    const nowMs = Date.parse('2026-06-16T09:00:00.000Z');

    expect(evaluateProactiveOutboundTimeGate({
      nowMs,
      earliestSendAtMs: Date.parse('2026-06-16T08:00:00.000Z'),
      quietHours,
    })).toEqual({
      allowed: true,
      sendAtMs: nowMs,
      timeZone: 'UTC',
    });
  });
});
