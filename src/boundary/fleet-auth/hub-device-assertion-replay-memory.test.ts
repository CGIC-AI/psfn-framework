import { describe, expect, it } from 'vitest';
import { InMemoryHubDeviceAssertionReplayStore } from './hub-device-assertion-replay-memory.js';
import type { HubDeviceAssertionReplayAuditContext } from './hub-device-assertion.js';

const AUDIT = {} as HubDeviceAssertionReplayAuditContext;

function entry(jti: string, expiresAtMs: number) {
  return {
    issuer: 'psfn-satellite-hub',
    jti,
    assertionDigest: `digest-${jti}`,
    deviceId: 'office-device',
    enrollmentVersion: 1,
    expiresAt: new Date(expiresAtMs),
    auditContext: AUDIT,
  };
}

describe('InMemoryHubDeviceAssertionReplayStore capacity', () => {
  it('refuses a new assertion at capacity instead of evicting a live one', async () => {
    let nowMs = 1_000_000;
    const store = new InMemoryHubDeviceAssertionReplayStore({ now: () => nowMs, maxEntries: 2 });
    await expect(store.consume(entry('a', nowMs + 10_000))).resolves.toEqual({ outcome: 'consumed' });
    await expect(store.consume(entry('b', nowMs + 60_000))).resolves.toEqual({ outcome: 'consumed' });

    await expect(store.consume(entry('c', nowMs + 60_000))).rejects.toThrow(/at capacity/u);
    // The soonest-expiring live assertion is still fenced: its replay is
    // recognized, and a mutated reuse of its jti is still a mismatch.
    await expect(store.consume(entry('a', nowMs + 10_000))).resolves.toEqual({ outcome: 'replayed' });
    await expect(store.consume({ ...entry('a', nowMs + 10_000), assertionDigest: 'other' }))
      .resolves.toEqual({ outcome: 'mismatch' });

    // Once a live entry expires, capacity returns.
    nowMs += 10_000;
    await expect(store.consume(entry('c', nowMs + 60_000))).resolves.toEqual({ outcome: 'consumed' });
    expect(store.size).toBe(2);
  });
});
