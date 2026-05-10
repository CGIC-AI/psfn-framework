import { describe, expect, it } from 'vitest';
import { evaluateRestWindowEligibility } from './rest-window.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';

const baseConfig: EpisodicProcessingRestWindowConfig = {
  enabled: true,
  startLocalTime: '23:00',
  endLocalTime: '05:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 60,
};

describe('evaluateRestWindowEligibility', () => {
  it('allows processing inside a midnight-crossing rest window after enough inactivity', () => {
    const nowMs = Date.parse('2026-03-16T04:30:00.000Z');
    const lastUserActivityAtMs = Date.parse('2026-03-16T03:00:00.000Z');

    expect(evaluateRestWindowEligibility({
      config: baseConfig,
      nowMs,
      lastUserActivityAtMs,
    })).toEqual(expect.objectContaining({
      allowed: true,
      enabled: true,
      timeZone: 'UTC',
      inactiveForMs: 90 * 60_000,
      requiredInactiveMs: 60 * 60_000,
    }));
  });

  it('denies processing inside the window until the inactivity threshold is reached', () => {
    const nowMs = Date.parse('2026-03-16T01:30:00.000Z');
    const lastUserActivityAtMs = Date.parse('2026-03-16T01:00:00.000Z');

    expect(evaluateRestWindowEligibility({
      config: baseConfig,
      nowMs,
      lastUserActivityAtMs,
    })).toEqual(expect.objectContaining({
      allowed: false,
      reasonCode: 'insufficient_inactivity',
      nextEligibleAtMs: Date.parse('2026-03-16T02:00:00.000Z'),
    }));
  });

  it('denies processing outside the window and returns the next window opening', () => {
    const nowMs = Date.parse('2026-03-16T12:00:00.000Z');
    const lastUserActivityAtMs = Date.parse('2026-03-16T01:00:00.000Z');

    expect(evaluateRestWindowEligibility({
      config: baseConfig,
      nowMs,
      lastUserActivityAtMs,
    })).toEqual(expect.objectContaining({
      allowed: false,
      reasonCode: 'outside_rest_window',
      nextEligibleAtMs: Date.parse('2026-03-16T23:00:00.000Z'),
    }));
  });

  it('uses configured IANA time zones for local-time windows', () => {
    const nowMs = Date.parse('2026-03-16T05:30:00.000Z');
    const lastUserActivityAtMs = Date.parse('2026-03-16T03:00:00.000Z');

    expect(evaluateRestWindowEligibility({
      config: {
        ...baseConfig,
        startLocalTime: '00:00',
        endLocalTime: '02:00',
        timeZone: 'America/New_York',
      },
      nowMs,
      lastUserActivityAtMs,
    })).toEqual(expect.objectContaining({
      allowed: true,
      timeZone: 'America/New_York',
    }));
  });

  it('allows processing when the rest-window gate is disabled', () => {
    expect(evaluateRestWindowEligibility({
      config: {
        ...baseConfig,
        enabled: false,
      },
      nowMs: Date.parse('2026-03-16T12:00:00.000Z'),
      lastUserActivityAtMs: Date.parse('2026-03-16T11:59:00.000Z'),
    })).toEqual(expect.objectContaining({
      allowed: true,
      enabled: false,
    }));
  });
});
