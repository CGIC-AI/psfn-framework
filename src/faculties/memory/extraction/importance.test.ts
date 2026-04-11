import { describe, expect, it } from 'vitest';
import {
  applyEmotionalIntensityImportanceMultiplier,
  computeEmotionalIntensity,
  DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT,
} from './importance.js';

describe('emotional intensity importance adjustment', () => {
  it('computes intensity from arousal and valence extremity', () => {
    expect(computeEmotionalIntensity({
      valence: 0,
      arousal: 0,
      dominance: 0,
    })).toBeCloseTo(0.25);

    expect(computeEmotionalIntensity({
      valence: 1,
      arousal: 1,
      dominance: 0,
    })).toBe(1);
  });

  it('returns zero intensity when formation VAD is unavailable', () => {
    expect(computeEmotionalIntensity()).toBe(0);
  });

  it('applies configured multiplier and clamps the adjusted importance', () => {
    expect(applyEmotionalIntensityImportanceMultiplier({
      baseImportance: 0.8,
      formationVAD: {
        valence: 1,
        arousal: 1,
        dominance: 0,
      },
      intensityWeight: DEFAULT_EMOTIONAL_INTENSITY_IMPORTANCE_WEIGHT,
    })).toBeCloseTo(0.96);

    expect(applyEmotionalIntensityImportanceMultiplier({
      baseImportance: 0.95,
      formationVAD: {
        valence: 1,
        arousal: 1,
        dominance: 0,
      },
      intensityWeight: 1,
    })).toBe(1);
  });

  it('keeps base importance when emotional weighting is disabled', () => {
    expect(applyEmotionalIntensityImportanceMultiplier({
      baseImportance: 0.73,
      formationVAD: {
        valence: 1,
        arousal: 1,
        dominance: 0,
      },
      intensityWeight: 0,
    })).toBe(0.73);
  });
});
