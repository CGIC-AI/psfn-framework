import { describe, expect, it } from 'vitest';

import {
  assertSocialPotConfig,
  regenerateSocialPot,
  type SocialPotConfig,
} from './social-pot.js';

const CONFIG: SocialPotConfig = {
  capUnits: 24,
  regenerationTickMs: 60 * 60_000,
  regenerationUnitsPerTick: 1,
};

describe('regenerateSocialPot', () => {
  it('credits one unit per whole elapsed tick', () => {
    const result = regenerateSocialPot({
      balance: 10,
      lastRegenAtMs: 0,
      nowMs: 3 * CONFIG.regenerationTickMs,
      config: CONFIG,
    });
    expect(result.balance).toBe(13);
    expect(result.lastRegenAtMs).toBe(3 * CONFIG.regenerationTickMs);
  });

  it('advances the timestamp only by whole ticks, carrying the sub-tick remainder', () => {
    const result = regenerateSocialPot({
      balance: 5,
      lastRegenAtMs: 0,
      // Two full ticks plus a partial third.
      nowMs: 2 * CONFIG.regenerationTickMs + 15 * 60_000,
      config: CONFIG,
    });
    expect(result.balance).toBe(7);
    expect(result.lastRegenAtMs).toBe(2 * CONFIG.regenerationTickMs);
  });

  it('clamps at the cap and never overflows', () => {
    const result = regenerateSocialPot({
      balance: 23,
      lastRegenAtMs: 0,
      nowMs: 100 * CONFIG.regenerationTickMs,
      config: CONFIG,
    });
    expect(result.balance).toBe(CONFIG.capUnits);
    // The timestamp still advances by every whole tick even while clamped, so
    // no phantom regeneration accrues once the pot drops back below the cap.
    expect(result.lastRegenAtMs).toBe(100 * CONFIG.regenerationTickMs);
  });

  it('clamps a balance above a lowered cap down on the next read', () => {
    const result = regenerateSocialPot({
      balance: 40,
      lastRegenAtMs: 0,
      nowMs: 0,
      config: CONFIG,
    });
    expect(result.balance).toBe(CONFIG.capUnits);
    expect(result.lastRegenAtMs).toBe(0);
  });

  it('does not credit or advance when the clock has not moved a full tick', () => {
    const result = regenerateSocialPot({
      balance: 12,
      lastRegenAtMs: 1_000,
      nowMs: 1_000 + CONFIG.regenerationTickMs - 1,
      config: CONFIG,
    });
    expect(result.balance).toBe(12);
    expect(result.lastRegenAtMs).toBe(1_000);
  });

  it('does not credit when the clock runs backwards', () => {
    const result = regenerateSocialPot({
      balance: 12,
      lastRegenAtMs: 10 * CONFIG.regenerationTickMs,
      nowMs: 5 * CONFIG.regenerationTickMs,
      config: CONFIG,
    });
    expect(result.balance).toBe(12);
    expect(result.lastRegenAtMs).toBe(10 * CONFIG.regenerationTickMs);
  });

  it('supports fractional per-tick regeneration (cap/24)', () => {
    const fractional: SocialPotConfig = {
      capUnits: 12,
      regenerationTickMs: 60 * 60_000,
      regenerationUnitsPerTick: 0.5,
    };
    const result = regenerateSocialPot({
      balance: 0,
      lastRegenAtMs: 0,
      nowMs: 3 * fractional.regenerationTickMs,
      config: fractional,
    });
    expect(result.balance).toBe(1.5);
  });
});

describe('assertSocialPotConfig', () => {
  it('accepts a valid config', () => {
    expect(assertSocialPotConfig(CONFIG)).toEqual(CONFIG);
  });

  it('rejects a non-positive cap', () => {
    expect(() => assertSocialPotConfig({ ...CONFIG, capUnits: 0 })).toThrow(
      /capUnits must be a finite number > 0/,
    );
  });

  it('rejects a per-tick regeneration larger than the cap', () => {
    expect(() =>
      assertSocialPotConfig({ ...CONFIG, regenerationUnitsPerTick: 25 }),
    ).toThrow(/regenerationUnitsPerTick must be <= socialPot.capUnits/);
  });

  it('rejects a non-integer tick interval', () => {
    expect(() =>
      assertSocialPotConfig({ ...CONFIG, regenerationTickMs: 1.5 }),
    ).toThrow(/regenerationTickMs must be a safe integer/);
  });
});
