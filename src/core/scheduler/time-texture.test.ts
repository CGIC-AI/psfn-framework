import { describe, expect, it } from 'vitest';
import { classifyIdleGapTexture } from './time-texture.js';

describe('classifyIdleGapTexture', () => {
  it('classifies short gaps', () => {
    expect(classifyIdleGapTexture({
      lastActivityAtMs: Date.parse('2026-06-10T10:00:00.000Z'),
      observedAtMs: Date.parse('2026-06-10T10:45:00.000Z'),
      timeZone: 'UTC',
    })).toMatchObject({
      kind: 'short_gap',
      label: 'short gap',
      reconnectionWarmth: 'low',
    });
  });

  it('classifies same-day long workday gaps', () => {
    expect(classifyIdleGapTexture({
      lastActivityAtMs: Date.parse('2026-06-10T10:00:00.000Z'),
      observedAtMs: Date.parse('2026-06-10T18:30:00.000Z'),
      timeZone: 'UTC',
    })).toMatchObject({
      kind: 'long_workday',
      label: 'long workday gap',
      reconnectionWarmth: 'medium',
      dayBoundaryCount: 0,
    });
  });

  it('classifies overnight gaps when the local date changes', () => {
    expect(classifyIdleGapTexture({
      lastActivityAtMs: Date.parse('2026-06-10T22:30:00.000Z'),
      observedAtMs: Date.parse('2026-06-11T08:00:00.000Z'),
      timeZone: 'UTC',
    })).toMatchObject({
      kind: 'overnight',
      label: 'overnight gap',
      reconnectionWarmth: 'medium',
      dayBoundaryCount: 1,
    });
  });

  it('classifies multi-day absences', () => {
    expect(classifyIdleGapTexture({
      lastActivityAtMs: Date.parse('2026-06-10T10:00:00.000Z'),
      observedAtMs: Date.parse('2026-06-13T10:00:00.000Z'),
      timeZone: 'UTC',
    })).toMatchObject({
      kind: 'multiple_days',
      label: 'multiple days away',
      reconnectionWarmth: 'high',
    });
  });
});
