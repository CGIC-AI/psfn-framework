/**
 * Acceptance-level simulated-clock regression suite for continuous social-pot
 * regeneration (jp36.4.2, design bible §12.6, adjudication decision 8).
 *
 * The settled model replaces the 24h reset cliff with an hourly `cap/24` tick:
 * the pot refills gradually to cap over ~24h instead of a companion being
 * "dead until midnight," and any daily reset survives only as a backstop
 * ceiling (never a floor reset). These tests drive `regenerateSocialPot` with a
 * simulated clock and pin:
 *
 *  - gradual refill 0 -> cap over exactly 24 hourly ticks (no cliff);
 *  - calendar-agnostic recovery (crossing UTC midnight changes nothing);
 *  - the daily backstop is a ceiling only (over-cap balances clamp down, a
 *    drained pot never jumps to cap at a day boundary);
 *  - restart safety / remainder carry (no double-credit across a split read);
 *  - a backward clock never credits;
 *  - fractional `cap/24` fills to exactly cap over 24 ticks with no overshoot.
 */
import { describe, expect, it } from 'vitest';

import { regenerateSocialPot, type SocialPotConfig } from './social-pot.js';

const HOUR_MS = 60 * 60_000;

const CONFIG: SocialPotConfig = {
  capUnits: 24,
  regenerationTickMs: HOUR_MS,
  regenerationUnitsPerTick: 1, // cap/24 = 24/24 = 1 unit per hour
};

describe('social-pot continuous regeneration (jp36.4.2 acceptance)', () => {
  it('refills gradually from empty to cap over exactly 24 hourly ticks', () => {
    const startMs = Date.UTC(2027, 0, 15, 0, 0, 0);
    // The pot fully drained at the start of the window.
    const balance = 0;
    const lastRegenAtMs = startMs;

    // Sample the balance at each whole hour across the 24h window and assert a
    // linear, one-unit-per-hour climb — a gradual taper, not a cliff.
    for (let hour = 0; hour <= 24; hour += 1) {
      const result = regenerateSocialPot({
        balance,
        lastRegenAtMs,
        nowMs: startMs + hour * HOUR_MS,
        config: CONFIG,
      });
      expect(result.balance).toBe(Math.min(CONFIG.capUnits, hour));
    }

    // Reading straight through 24h lands exactly on cap, and every whole tick
    // advanced the boundary (remainder-carry leaves no phantom credit).
    const full = regenerateSocialPot({
      balance,
      lastRegenAtMs,
      nowMs: startMs + 24 * HOUR_MS,
      config: CONFIG,
    });
    expect(full.balance).toBe(CONFIG.capUnits);
    expect(full.lastRegenAtMs).toBe(startMs + 24 * HOUR_MS);
  });

  it('recovers continuously across a UTC-midnight boundary with no daily floor-reset', () => {
    // Drain to a low balance three hours before midnight, then read three hours
    // later (one hour past midnight). A calendar cliff would snap to cap at
    // 00:00; continuous regen only credits the three elapsed hours.
    const beforeMidnight = Date.UTC(2027, 0, 14, 21, 0, 0);
    const afterMidnight = Date.UTC(2027, 0, 15, 0, 0, 0) + HOUR_MS;
    expect(afterMidnight - beforeMidnight).toBe(4 * HOUR_MS);

    const result = regenerateSocialPot({
      balance: 2,
      lastRegenAtMs: beforeMidnight,
      nowMs: afterMidnight,
      config: CONFIG,
    });
    // 2 + 4 elapsed hourly ticks = 6, far below cap: no midnight snap-to-full.
    expect(result.balance).toBe(6);
    expect(result.lastRegenAtMs).toBe(beforeMidnight + 4 * HOUR_MS);
  });

  it('applies the daily backstop as a ceiling only: long idle clamps to exactly cap', () => {
    // A pot idle for 30 days would accrue 720 units of raw credit; the backstop
    // ceiling clamps it to exactly cap with no overshoot, while the timestamp
    // still advances by every whole tick so no phantom credit lingers.
    const startMs = Date.UTC(2027, 0, 1, 0, 0, 0);
    const idleMs = 30 * 24 * HOUR_MS;
    const result = regenerateSocialPot({
      balance: 5,
      lastRegenAtMs: startMs,
      nowMs: startMs + idleMs,
      config: CONFIG,
    });
    expect(result.balance).toBe(CONFIG.capUnits);
    expect(result.lastRegenAtMs).toBe(startMs + idleMs);
  });

  it('clamps an over-cap balance down even when no tick has elapsed (ceiling backstop)', () => {
    // Models a lowered capUnits config (or any corrupted over-cap row): the
    // ceiling is enforced on the very next read regardless of elapsed time.
    const nowMs = Date.UTC(2027, 0, 15, 12, 0, 0);
    const result = regenerateSocialPot({
      balance: 40,
      lastRegenAtMs: nowMs,
      nowMs,
      config: CONFIG,
    });
    expect(result.balance).toBe(CONFIG.capUnits);
    expect(result.lastRegenAtMs).toBe(nowMs);
  });

  it('is restart-safe: splitting a 90-minute elapse across two reads credits one unit, not two', () => {
    const startMs = Date.UTC(2027, 0, 15, 8, 0, 0);
    // First process observes at +60m: one whole tick credited, boundary advances.
    const first = regenerateSocialPot({
      balance: 10,
      lastRegenAtMs: startMs,
      nowMs: startMs + 60 * 60_000,
      config: CONFIG,
    });
    expect(first.balance).toBe(11);
    expect(first.lastRegenAtMs).toBe(startMs + HOUR_MS);

    // Restart: a fresh process resumes from the persisted state and reads at the
    // original +90m. Only the carried 30m remainder is pending, so no second
    // tick credits — the total across the restart is exactly one unit.
    const second = regenerateSocialPot({
      balance: first.balance,
      lastRegenAtMs: first.lastRegenAtMs,
      nowMs: startMs + 90 * 60_000,
      config: CONFIG,
    });
    expect(second.balance).toBe(11);
    expect(second.lastRegenAtMs).toBe(startMs + HOUR_MS);
  });

  it('never credits when the clock runs backward', () => {
    const startMs = Date.UTC(2027, 0, 15, 8, 0, 0);
    const result = regenerateSocialPot({
      balance: 7,
      lastRegenAtMs: startMs,
      nowMs: startMs - 5 * HOUR_MS,
      config: CONFIG,
    });
    expect(result.balance).toBe(7);
    expect(result.lastRegenAtMs).toBe(startMs);
  });

  it('fills a fractional cap/24 pot to exactly cap over 24 ticks with no overshoot', () => {
    // cap not divisible by 24: cap/24 per tick must still land exactly on cap.
    const fractional: SocialPotConfig = {
      capUnits: 12,
      regenerationTickMs: HOUR_MS,
      regenerationUnitsPerTick: 12 / 24, // 0.5 per hour
    };
    const startMs = Date.UTC(2027, 0, 15, 0, 0, 0);

    const atTwelveHours = regenerateSocialPot({
      balance: 0,
      lastRegenAtMs: startMs,
      nowMs: startMs + 12 * HOUR_MS,
      config: fractional,
    });
    expect(atTwelveHours.balance).toBeCloseTo(6, 10);

    const atFullDay = regenerateSocialPot({
      balance: 0,
      lastRegenAtMs: startMs,
      nowMs: startMs + 24 * HOUR_MS,
      config: fractional,
    });
    expect(atFullDay.balance).toBe(fractional.capUnits);

    const past = regenerateSocialPot({
      balance: 0,
      lastRegenAtMs: startMs,
      nowMs: startMs + 48 * HOUR_MS,
      config: fractional,
    });
    expect(past.balance).toBe(fractional.capUnits);
  });
});
