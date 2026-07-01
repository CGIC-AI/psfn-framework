import { describe, expect, it } from 'vitest';
import {
  createDefaultEmotionScopingSettings,
  normalizeEmotionScopingSettings,
} from './emotion-scoping-config.js';

describe('emotion scoping config', () => {
  it('produces sane defaults (fast carry-over half-life on the order of minutes)', () => {
    const defaults = createDefaultEmotionScopingSettings();
    expect(defaults.carryOver.enabled).toBe(true);
    expect(defaults.carryOver.halfLifeSeconds).toBeGreaterThanOrEqual(60);
    expect(defaults.carryOver.halfLifeSeconds).toBeLessThanOrEqual(600);
    expect(defaults.carryOver.modifierStrength).toBeGreaterThan(0);
    expect(defaults.carryOver.modifierStrength).toBeLessThanOrEqual(1);
    expect(defaults.baseline.moodBlendAlpha).toBeGreaterThan(0);
  });

  it('merges a partial patch over defaults', () => {
    const merged = normalizeEmotionScopingSettings({
      carryOver: { halfLifeSeconds: 120, enabled: false },
      baseline: { moodBlendAlpha: 0.2 },
    });
    expect(merged.carryOver.halfLifeSeconds).toBe(120);
    expect(merged.carryOver.enabled).toBe(false);
    // untouched fields keep defaults
    expect(merged.carryOver.modifierStrength).toBe(createDefaultEmotionScopingSettings().carryOver.modifierStrength);
    expect(merged.baseline.moodBlendAlpha).toBe(0.2);
  });

  it('rejects unknown fields (fail closed)', () => {
    expect(() => normalizeEmotionScopingSettings({ carryOver: { bogus: 1 } })).toThrow(/unknown field/);
    expect(() => normalizeEmotionScopingSettings({ nope: true })).toThrow(/unknown field/);
  });

  it('rejects out-of-range values', () => {
    expect(() => normalizeEmotionScopingSettings({ carryOver: { modifierStrength: 5 } })).toThrow(/number 0-1/);
    expect(() => normalizeEmotionScopingSettings({ baseline: { moodBlendAlpha: -1 } })).toThrow(/number 0-1/);
  });
});
