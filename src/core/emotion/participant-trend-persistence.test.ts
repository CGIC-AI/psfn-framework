import { describe, expect, it } from 'vitest';
import {
  fromPersistedParticipantTrend,
  normalizePersistedParticipantTrend,
  toPersistedParticipantTrend,
} from './participant-trend-persistence.js';
import { createParticipantTrend, updateParticipantTrend } from './participant-trends.js';

const NOW = 1_700_000_000_000;

describe('participant trend persistence (E6.3)', () => {
  it('round-trips a runtime trend through the persisted form', () => {
    let trend = createParticipantTrend('contactA', NOW);
    trend = updateParticipantTrend(trend, { vad: { valence: -0.6, arousal: 0.4, dominance: 0.2 }, discrete: { anger: 0.7 } }, 0.5, NOW + 1000);

    const persisted = toPersistedParticipantTrend('room:R', trend);
    expect(persisted.roomKey).toBe('room:R');
    expect(persisted.participantKey).toBe('contactA');
    expect(persisted.interactionCount).toBe(1);

    const restored = fromPersistedParticipantTrend(persisted);
    expect(restored.vad.valence).toBeCloseTo(trend.vad.valence, 6);
    expect(restored.discrete.anger).toBeCloseTo(trend.discrete.anger, 6);
    expect(restored.interactionCount).toBe(trend.interactionCount);
    expect(restored.updatedAtMs).toBe(trend.updatedAtMs);
  });

  it('rejects corrupt records fail-closed', () => {
    expect(() => normalizePersistedParticipantTrend({
      roomKey: '',
      participantKey: 'p',
      vad: { valence: 0, arousal: 0, dominance: 0 },
      discrete: {},
      interactionCount: 0,
      updatedAt: new Date(NOW).toISOString(),
    })).toThrow(/roomKey/);

    expect(() => normalizePersistedParticipantTrend({
      roomKey: 'room:R',
      participantKey: 'p',
      vad: { valence: Number.NaN, arousal: 0, dominance: 0 },
      discrete: {},
      interactionCount: 0,
      updatedAt: new Date(NOW).toISOString(),
    })).toThrow(/finite number/);

    expect(() => normalizePersistedParticipantTrend({
      roomKey: 'room:R',
      participantKey: 'p',
      vad: { valence: 0, arousal: 0, dominance: 0 },
      discrete: {},
      interactionCount: -1,
      updatedAt: new Date(NOW).toISOString(),
    })).toThrow(/interactionCount/);

    expect(() => normalizePersistedParticipantTrend({
      roomKey: 'room:R',
      participantKey: 'p',
      vad: { valence: 0, arousal: 0, dominance: 0 },
      discrete: {},
      interactionCount: 0,
      updatedAt: 'not-a-date',
    })).toThrow(/ISO timestamp/);
  });

  it('clamps out-of-range values on normalization', () => {
    const normalized = normalizePersistedParticipantTrend({
      roomKey: 'room:R',
      participantKey: 'p',
      vad: { valence: -5, arousal: 5, dominance: 0.3 },
      discrete: { Anger: 2 },
      interactionCount: 3,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(normalized.vad.valence).toBe(-1);
    expect(normalized.vad.arousal).toBe(1);
    expect(normalized.discrete.anger).toBe(1);
  });
});
