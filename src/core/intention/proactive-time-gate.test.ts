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

  // psfn-framework-2tli: quiet hours must follow the recipient's Contact.timezone
  // when present, so a partner asleep in Berlin is not messaged just because it is
  // still evening in the admin (global) timezone.
  describe('per-recipient timezone (psfn-framework-2tli)', () => {
    // Global window lives in the admin timezone (Eastern).
    const easternQuietHours: ProactiveQuietHoursConfig = {
      enabled: true,
      startLocalTime: '00:00',
      endLocalTime: '08:00',
      timeZone: 'America/New_York',
    };

    // 2026-06-17T01:00Z === 21:00 Eastern (clear) but 03:00 Berlin (quiet).
    const bedtimeInBerlin = Date.parse('2026-06-17T01:00:00.000Z');
    // 2026-06-16T08:00Z === 10:00 Berlin (clear).
    const morningInBerlin = Date.parse('2026-06-16T08:00:00.000Z');

    it('blocks a send at 03:00 in the contact timezone though it is 21:00 globally', () => {
      expect(evaluateProactiveOutboundTimeGate({
        nowMs: bedtimeInBerlin,
        quietHours: easternQuietHours,
        contactTimeZone: 'Europe/Berlin',
      })).toEqual({
        allowed: false,
        reason: 'quiet_hours',
        nextEligibleAtMs: Date.parse('2026-06-17T06:00:00.000Z'), // 08:00 Berlin
        timeZone: 'Europe/Berlin',
      });
    });

    it('without a contact timezone the same moment clears the global (Eastern) window', () => {
      expect(evaluateProactiveOutboundTimeGate({
        nowMs: bedtimeInBerlin,
        quietHours: easternQuietHours,
      })).toEqual({
        allowed: true,
        sendAtMs: bedtimeInBerlin,
        timeZone: 'America/New_York',
      });
    });

    it('allows a send at 10:00 in the contact timezone', () => {
      expect(evaluateProactiveOutboundTimeGate({
        nowMs: morningInBerlin,
        quietHours: easternQuietHours,
        contactTimeZone: 'Europe/Berlin',
      })).toEqual({
        allowed: true,
        sendAtMs: morningInBerlin,
        timeZone: 'Europe/Berlin',
      });
    });

    it('fails closed to the global window when the contact timezone is invalid', () => {
      expect(evaluateProactiveOutboundTimeGate({
        nowMs: Date.parse('2026-06-16T02:30:00.000Z'),
        quietHours,
        contactTimeZone: 'Mars/Phobos',
      })).toEqual({
        allowed: false,
        reason: 'quiet_hours',
        nextEligibleAtMs: Date.parse('2026-06-16T08:00:00.000Z'),
        timeZone: 'UTC',
      });
    });
  });
});
