import { describe, expect, it } from 'vitest';
import { InMemoryRestWindowPolicy } from './rest-window-policy.js';

describe('InMemoryRestWindowPolicy', () => {
  it('is not silenced before any decision is recorded', () => {
    const policy = new InMemoryRestWindowPolicy();
    expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 1_000 })).toBe(false);
  });

  it('silences a lane for the recorded duration and expires afterward', () => {
    const policy = new InMemoryRestWindowPolicy();
    policy.recordSilence({ lane: 'quiet_hours', nowMs: 1_000, durationMs: 10_000 });

    expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 1_000 })).toBe(true);
    expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 10_999 })).toBe(true);
    // Expiry is exclusive of the boundary.
    expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 11_000 })).toBe(false);
  });

  it('scopes silence per lane', () => {
    const policy = new InMemoryRestWindowPolicy();
    policy.recordSilence({ lane: 'quiet_hours', nowMs: 0, durationMs: 5_000 });

    expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 1_000 })).toBe(true);
    expect(policy.isSilenced({ lane: 'idle', nowMs: 1_000 })).toBe(false);
  });

  it('extends but never shortens an active silence within a period', () => {
    const policy = new InMemoryRestWindowPolicy();
    policy.recordSilence({ lane: 'idle', nowMs: 0, durationMs: 20_000 });
    // A later, shorter decision must not pull the guard in.
    policy.recordSilence({ lane: 'idle', nowMs: 5_000, durationMs: 1_000 });

    expect(policy.isSilenced({ lane: 'idle', nowMs: 15_000 })).toBe(true);
    expect(policy.isSilenced({ lane: 'idle', nowMs: 20_000 })).toBe(false);
  });
});
