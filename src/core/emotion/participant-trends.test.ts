import { describe, expect, it } from 'vitest';
import {
  createParticipantTrend,
  maintainRoomTrends,
  participantMovementIsMeaningful,
  participantTrendMagnitude,
  updateParticipantTrend,
  type ParticipantEmotionTrend,
} from './participant-trends.js';
import type { EmotionObservation } from './state.js';

const NOW = 1_700_000_000_000;

const cruel: EmotionObservation = {
  vad: { valence: -0.8, arousal: 0.7, dominance: 0.6 },
  discrete: { anger: 0.9 },
};
const kind: EmotionObservation = {
  vad: { valence: 0.8, arousal: 0.4, dominance: 0.2 },
  discrete: { love: 0.8 },
};

function accumulate(
  key: string,
  observation: EmotionObservation,
  times: number,
  alpha = 0.3,
): ParticipantEmotionTrend {
  let trend = createParticipantTrend(key, NOW);
  for (let index = 0; index < times; index += 1) {
    trend = updateParticipantTrend(trend, observation, alpha, NOW + index * 1000);
  }
  return trend;
}

describe('participant trends (E6.3 pure module)', () => {
  it('moves opposite-valence participants in independent directions', () => {
    const cruelTrend = accumulate('contactCruel', cruel, 6);
    const kindTrend = accumulate('contactKind', kind, 6);

    expect(cruelTrend.vad.valence).toBeLessThan(-0.3);
    expect(kindTrend.vad.valence).toBeGreaterThan(0.3);
    // Independent identities, independent counts.
    expect(cruelTrend.participantKey).toBe('contactCruel');
    expect(kindTrend.participantKey).toBe('contactKind');
    expect(cruelTrend.interactionCount).toBe(6);
    expect(kindTrend.interactionCount).toBe(6);
  });

  it('moves slowly: one message never reaches the observed level (EMA)', () => {
    const single = accumulate('contactA', cruel, 1, 0.3);
    // After one message the trend is only alpha of the way to the observation.
    expect(single.vad.valence).toBeCloseTo(-0.8 * 0.3, 6);
    expect(Math.abs(single.vad.valence)).toBeLessThan(Math.abs(cruel.vad!.valence!));
  });

  it('gates meaningful movement on both interaction volume and displacement', () => {
    const thresholds = { minInteractions: 3, minTrendDelta: 0.1 };
    // Enough displacement but too few interactions.
    const fewButStrong = accumulate('p1', cruel, 2, 0.9);
    expect(participantTrendMagnitude(fewButStrong)).toBeGreaterThan(0.1);
    expect(participantMovementIsMeaningful(fewButStrong, thresholds)).toBe(false);
    // Enough interactions and displacement.
    const enough = accumulate('p2', cruel, 5, 0.3);
    expect(participantMovementIsMeaningful(enough, thresholds)).toBe(true);
    // Enough interactions but negligible displacement (near-neutral observation).
    const flat = accumulate('p3', { vad: { valence: 0.01, arousal: 0, dominance: 0 } }, 10, 0.3);
    expect(participantMovementIsMeaningful(flat, thresholds)).toBe(false);
  });

  it('decays discrete labels absent from later observations and caps growth', () => {
    let trend = accumulate('p', { discrete: { anger: 0.9 }, vad: { valence: -0.5, arousal: 0, dominance: 0 } }, 4, 0.5);
    expect(trend.discrete.anger).toBeGreaterThan(0);
    // Later joy-only observations decay anger toward 0.
    for (let index = 0; index < 8; index += 1) {
      trend = updateParticipantTrend(trend, { discrete: { joy: 0.8 }, vad: { valence: 0.5, arousal: 0, dominance: 0 } }, 0.5, NOW);
    }
    expect(trend.discrete.joy).toBeGreaterThan(0.2);
    expect((trend.discrete as Record<string, number | undefined>).anger ?? 0).toBeLessThan(0.05);
  });

  it('evicts stale trends and caps tracked participants (LRU)', () => {
    const trends = new Map<string, ParticipantEmotionTrend>();
    // Three participants at increasing recency.
    trends.set('old', { ...createParticipantTrend('old', NOW), updatedAtMs: NOW - 100_000 });
    trends.set('mid', { ...createParticipantTrend('mid', NOW), updatedAtMs: NOW - 50_000 });
    trends.set('new', { ...createParticipantTrend('new', NOW), updatedAtMs: NOW - 1_000 });

    // Stale window evicts 'old' (older than 60s); cap of 1 evicts 'mid' (LRU).
    const result = maintainRoomTrends(trends, { maxTrackedParticipants: 1, staleEvictionSeconds: 60 }, NOW);

    expect(result.evictedKeys).toContain('old');
    expect(result.evictedKeys).toContain('mid');
    expect([...trends.keys()]).toEqual(['new']);
  });
});
