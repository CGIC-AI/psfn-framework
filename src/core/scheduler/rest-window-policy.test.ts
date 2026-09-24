import { describe, expect, it } from 'vitest';
import { DurableRestWindowPolicy } from './rest-window-policy.js';
import { InMemoryRestSilenceStore } from '../../test-support/in-memory-rest-silence-store.js';

describe('DurableRestWindowPolicy', () => {
  it('is not silenced before any decision is recorded', async () => {
    const policy = new DurableRestWindowPolicy(new InMemoryRestSilenceStore());
    await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 1_000 })).resolves.toBe(false);
  });

  it('silences a lane for the recorded duration and expires afterward', async () => {
    const policy = new DurableRestWindowPolicy(new InMemoryRestSilenceStore());
    await policy.recordSilence({ lane: 'quiet_hours', nowMs: 1_000, durationMs: 10_000 });

    await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 1_000 })).resolves.toBe(true);
    await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 10_999 })).resolves.toBe(true);
    // Expiry is exclusive of the boundary.
    await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 11_000 })).resolves.toBe(false);
  });

  it('scopes silence per lane', async () => {
    const policy = new DurableRestWindowPolicy(new InMemoryRestSilenceStore());
    await policy.recordSilence({ lane: 'quiet_hours', nowMs: 0, durationMs: 5_000 });

    await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 1_000 })).resolves.toBe(true);
    await expect(policy.isSilenced({ lane: 'idle', nowMs: 1_000 })).resolves.toBe(false);
  });

  it('extends but never shortens an active silence within a period', async () => {
    const store = new InMemoryRestSilenceStore();
    const policy = new DurableRestWindowPolicy(store);
    await policy.recordSilence({ lane: 'idle', nowMs: 0, durationMs: 20_000 });
    // A later, shorter decision must not pull the guard in.
    await policy.recordSilence({ lane: 'idle', nowMs: 5_000, durationMs: 1_000 });

    await expect(policy.isSilenced({ lane: 'idle', nowMs: 15_000 })).resolves.toBe(true);
    await expect(policy.isSilenced({ lane: 'idle', nowMs: 20_000 })).resolves.toBe(false);
    expect(store.rows.get('idle')).toBe(20_000);
  });

  it('survives restart: a fresh policy over the same store stays silenced until expiry (89muv)', async () => {
    const store = new InMemoryRestSilenceStore();
    await new DurableRestWindowPolicy(store).recordSilence({ lane: 'quiet_hours', nowMs: 0, durationMs: 60_000 });

    const restarted = new DurableRestWindowPolicy(store);
    await expect(restarted.isSilenced({ lane: 'quiet_hours', nowMs: 30_000 })).resolves.toBe(true);
    await expect(restarted.isSilenced({ lane: 'quiet_hours', nowMs: 60_000 })).resolves.toBe(false);
  });

  it('keeps a recorded silence in-process when the durable write fails, and throws', async () => {
    const store = new InMemoryRestSilenceStore();
    store.failWrites = true;
    const policy = new DurableRestWindowPolicy(store);
    await expect(policy.recordSilence({ lane: 'idle', nowMs: 0, durationMs: 10_000 })).rejects.toThrow();
    store.failWrites = false;
    await expect(policy.isSilenced({ lane: 'idle', nowMs: 5_000 })).resolves.toBe(true);
  });

  it('throws rather than reporting "not silenced" when durable state is unreadable', async () => {
    const store = new InMemoryRestSilenceStore();
    store.failReads = true;
    await expect(new DurableRestWindowPolicy(store).isSilenced({ lane: 'idle', nowMs: 0 })).rejects.toThrow();
  });
});
