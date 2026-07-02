import { describe, expect, it } from 'vitest';
import {
  buildEmotionalAffectPromptVariables,
  mapEmotionToPersonaAffect,
  resolveEmotionalExpressionProfile,
} from './persona-adaptation.js';
import type { EmotionStateSnapshot } from './state.js';

function makeSnapshot(overrides?: Partial<EmotionStateSnapshot>): EmotionStateSnapshot {
  return {
    vad: { valence: 0.7, arousal: 0.6, dominance: 0.5 },
    mood: { valence: 0.2, arousal: 0.1, dominance: 0.1 },
    discrete: { joy: 0.9, trust: 0.4 },
    confidence: 0.9,
    ...overrides,
  };
}

describe('emotion/persona-adaptation', () => {
  it('returns blank affect variables when emotion state is unavailable', () => {
    const variables = buildEmotionalAffectPromptVariables({
      trustLevel: 'primary',
      emotionSnapshot: null,
    });
    expect(variables.runtime_affect_snapshot_present).toBe('false');
    expect(variables.runtime_affect_mode).toBe('');
    expect(variables.runtime_affect_warmth).toBe('');
  });

  it('resolves emotional expression profile from prompt variables and config with config precedence', () => {
    const profile = resolveEmotionalExpressionProfile({
      promptVariables: {
        hexaco_emotional_expression_intensity: '0.9',
        hexaco_emotional_expression_variability: '0.8',
        hexaco_emotional_expression_control: '0.2',
        hexaco_emotional_expression_display_range_min: '0.1',
        hexaco_emotional_expression_display_range_max: '0.95',
      },
      config: {
        emotionAffect: {
          emotionalExpression: {
            control: 0.85,
            displayRange: {
              max: 0.55,
            },
          },
        },
      },
    });

    expect(profile.intensity).toBeCloseTo(0.9, 6);
    expect(profile.variability).toBeCloseTo(0.8, 6);
    expect(profile.control).toBeCloseTo(0.85, 6);
    expect(profile.displayRange.min).toBeCloseTo(0.1, 6);
    expect(profile.displayRange.max).toBeCloseTo(0.55, 6);
  });

  it('accepts extensions_* emotional expression aliases from character-card variables', () => {
    const profile = resolveEmotionalExpressionProfile({
      promptVariables: {
        extensions_hexaco_emotional_expression_intensity: '0.61',
        extensions_hexaco_emotional_expression_variability: '0.47',
        extensions_hexaco_emotional_expression_control: '0.73',
        extensions_hexaco_emotional_expression_display_range_min: '0.15',
        extensions_hexaco_emotional_expression_display_range_max: '0.68',
      },
    });

    expect(profile.intensity).toBeCloseTo(0.61, 6);
    expect(profile.variability).toBeCloseTo(0.47, 6);
    expect(profile.control).toBeCloseTo(0.73, 6);
    expect(profile.displayRange.min).toBeCloseTo(0.15, 6);
    expect(profile.displayRange.max).toBeCloseTo(0.68, 6);
  });

  it('applies stricter tatemae gating for public trust than primary trust', () => {
    const snapshot = makeSnapshot();
    const primary = mapEmotionToPersonaAffect({
      trustLevel: 'primary',
      emotionSnapshot: snapshot,
      profile: {
        intensity: 1,
        variability: 1,
        control: 0,
        displayRange: { min: 0, max: 1 },
      },
    });
    const publicMode = mapEmotionToPersonaAffect({
      trustLevel: 'public',
      emotionSnapshot: snapshot,
      profile: {
        intensity: 1,
        variability: 1,
        control: 0,
        displayRange: { min: 0, max: 1 },
      },
    });

    expect(primary.mode).toBe('honne');
    expect(publicMode.mode).toBe('tatemae');
    expect(Math.abs(publicMode.warmth)).toBeLessThan(Math.abs(primary.warmth));
    expect(Math.abs(publicMode.energy)).toBeLessThan(Math.abs(primary.energy));
    expect(Math.abs(publicMode.assertiveness)).toBeLessThan(Math.abs(primary.assertiveness));
    expect(publicMode.expressiveness).toBeLessThan(primary.expressiveness);
  });

  it('emits atomic affect prompt variables while leaving the prose to templates', () => {
    const variables = buildEmotionalAffectPromptVariables({
      trustLevel: 'trusted',
      emotionSnapshot: makeSnapshot(),
    });

    expect(variables.runtime_affect_snapshot_present).toBe('true');
    expect(variables.runtime_affect_mode).toBe('tatemae');
    expect(variables.runtime_affect_mode_label).toBe('tatemae (controlled)');
    expect(variables.runtime_affect_mode_is_tatemae).toBe('true');
    expect(variables.runtime_affect_guidance_warmth_label).toBeTruthy();
    // E2.5 purity rule: no prose privacy guidance and no duplicate profile_/
    // snapshot_vad_ spellings — bare values only, phrasing lives in layers.
    expect('runtime_affect_privacy_guidance' in variables).toBe(false);
    expect('runtime_affect_profile_intensity' in variables).toBe(false);
    expect('runtime_affect_snapshot_vad_valence' in variables).toBe(false);
    expect(variables.runtime_affect_intensity).toBeTruthy();
    expect(variables.runtime_affect_valence).toBeTruthy();
  });
});
