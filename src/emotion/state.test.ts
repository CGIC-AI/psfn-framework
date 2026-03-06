import { describe, expect, it } from 'vitest';
import { EmotionState } from './state.js';

describe('EmotionState', () => {
  it('applies exponential decay to VAD and discrete emotions', () => {
    const state = EmotionState.deserialize({
      vad: { valence: 1, arousal: 1, dominance: 1 },
      mood: { valence: 0, arousal: 0, dominance: 0 },
      discrete: { joy: 1, surprise: 1 },
      confidence: 0.5,
    }, {
      vadHalfLifeSeconds: {
        valence: 10,
        arousal: 20,
        dominance: 40,
      },
      discreteHalfLifeSeconds: {
        joy: 30,
        surprise: 5,
      },
      moodAlpha: 0,
    });

    const snapshot = state.update({}, 10);

    expect(snapshot.vad.valence).toBeCloseTo(0.5, 6);
    expect(snapshot.vad.arousal).toBeCloseTo(Math.pow(0.5, 0.5), 6);
    expect(snapshot.vad.dominance).toBeCloseTo(Math.pow(0.5, 0.25), 6);
    expect(snapshot.discrete.joy).toBeCloseTo(Math.pow(0.5, 10 / 30), 6);
    expect(snapshot.discrete.surprise).toBeCloseTo(0.25, 6);
  });

  it('decays first, then applies impulses, then updates mood EMA', () => {
    const state = EmotionState.deserialize({
      vad: { valence: 0.4, arousal: 0, dominance: 0 },
      mood: { valence: 0, arousal: 0, dominance: 0 },
      discrete: { joy: 0.2 },
      confidence: 0,
    }, {
      vadHalfLifeSeconds: {
        valence: 10,
        arousal: 10,
        dominance: 10,
      },
      discreteHalfLifeSeconds: {
        joy: 10,
        anger: 10,
      },
      moodAlpha: 0.1,
      confidenceAlpha: 0.5,
    });

    const snapshot = state.update({
      vad: {
        valence: 0.4,
        arousal: 0.6,
      },
      discrete: {
        joy: 0.5,
        anger: 0.4,
      },
      confidence: 0.5,
    }, 10);

    expect(snapshot.vad.valence).toBeCloseTo(0.4, 6);
    expect(snapshot.vad.arousal).toBeCloseTo(0.3, 6);
    expect(snapshot.discrete.joy).toBeCloseTo(0.35, 6);
    expect(snapshot.discrete.anger).toBeCloseTo(0.2, 6);
    expect(snapshot.mood.valence).toBeCloseTo(0.04, 6);
    expect(snapshot.mood.arousal).toBeCloseTo(0.03, 6);
    expect(snapshot.confidence).toBeCloseTo(0.25, 6);
  });

  it('serializes with stable shape and supports round-trip restore', () => {
    const state = new EmotionState();
    state.update({
      vad: {
        valence: 0.8,
        dominance: -0.2,
      },
      discrete: {
        joy: 0.7,
        anger: 0.4,
      },
      confidence: 0.9,
    }, 0);

    const serialized = state.serialize();

    expect(Object.keys(serialized)).toEqual(['vad', 'mood', 'discrete', 'confidence']);
    expect(Object.keys(serialized.vad)).toEqual(['valence', 'arousal', 'dominance']);
    expect(Object.keys(serialized.mood)).toEqual(['valence', 'arousal', 'dominance']);
    expect(Object.keys(serialized.discrete)).toEqual(['anger', 'joy']);

    const restored = EmotionState.deserialize(serialized);
    expect(restored.getState()).toEqual(serialized);
  });
});
