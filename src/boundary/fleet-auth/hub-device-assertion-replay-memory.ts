import type {
  HubDeviceAssertionReplayAuditContext,
  HubDeviceAssertionReplayStore,
} from './hub-device-assertion.js';

/**
 * Process-local single-use fence for Hub device assertions.
 *
 * Used when the gateway runs without fleet auth, whose Postgres
 * `fleet_auth.hub_device_assertion_replays` procedure is the durable
 * equivalent. The semantics match that procedure exactly:
 *
 * - first presentation of a (issuer, jti) → `consumed`;
 * - exact re-presentation (same signed token digest) → `replayed` — the
 *   ingress admits it as a transport retry of the same turn;
 * - a different token reusing the same jti → `mismatch` — rejected.
 *
 * Assertions live at most `maxTtlSeconds + clockSkewSeconds` (≤ 70 s), so
 * losing the fence on restart re-opens a window no longer than that, and a
 * restart also drops every admitted Hub session. Entries expire with the
 * assertion and the map is bounded so an abusive issuer cannot grow it
 * without limit; at the bound new assertions are refused, never admitted by
 * evicting a live entry.
 */
export interface InMemoryHubDeviceAssertionReplayStoreOptions {
  now?: () => number;
  /**
   * Upper bound on live entries. At the bound a NEW assertion is refused
   * (fail closed) until live entries expire; a live entry is never evicted,
   * because evicting it would let that consumed assertion replay once more.
   */
  maxEntries?: number;
}

interface ReplayEntry {
  assertionDigest: string;
  deviceId: string;
  enrollmentVersion: number;
  expiresAtMs: number;
  auditContext: HubDeviceAssertionReplayAuditContext;
}

export const DEFAULT_MAX_ENTRIES = 4096;

export class InMemoryHubDeviceAssertionReplayStore implements HubDeviceAssertionReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: InMemoryHubDeviceAssertionReplayStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Hub device assertion replay store maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  async consume(input: {
    issuer: string;
    jti: string;
    assertionDigest: string;
    deviceId: string;
    enrollmentVersion: number;
    expiresAt: Date;
    auditContext: HubDeviceAssertionReplayAuditContext;
  }): Promise<{ outcome: 'consumed' | 'replayed' | 'mismatch' }> {
    const nowMs = this.now();
    this.sweep(nowMs);
    const key = `${input.issuer}\0${input.jti}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.assertionDigest === input.assertionDigest
        && existing.deviceId === input.deviceId
        && existing.enrollmentVersion === input.enrollmentVersion) {
        return { outcome: 'replayed' };
      }
      return { outcome: 'mismatch' };
    }
    const expiresAtMs = input.expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error('Hub device assertion replay expiry is invalid');
    }
    if (expiresAtMs <= nowMs) {
      // Already dead: nothing to fence, and the verifier has rejected it on
      // lifetime grounds before reaching the store anyway.
      return { outcome: 'consumed' };
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error(
        'Hub device assertion replay fence is at capacity; refusing new assertions until live entries expire',
      );
    }
    this.entries.set(key, {
      assertionDigest: input.assertionDigest,
      deviceId: input.deviceId,
      enrollmentVersion: input.enrollmentVersion,
      expiresAtMs,
      auditContext: input.auditContext,
    });
    return { outcome: 'consumed' };
  }

  private sweep(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }

}
