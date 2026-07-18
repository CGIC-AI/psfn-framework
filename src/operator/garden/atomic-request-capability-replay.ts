import type {
  RequestCapabilityReplayConsumption,
  RequestCapabilityReplayOutcome,
  RequestCapabilityReplayPort,
} from '../../boundary/fleet-auth/request-capability-replay.js';

interface ConsumedCapability {
  readonly fingerprint: string;
  readonly expiresAtMs: number;
  readonly result: RequestCapabilityReplayConsumption['consumeResult'];
}

function replayKey(input: RequestCapabilityReplayConsumption): string {
  return `${input.issuer}\u0000${input.jti}`;
}

function fingerprint(input: RequestCapabilityReplayConsumption): string {
  return JSON.stringify({
    ...input,
    expiresAt: input.expiresAt.toISOString(),
  });
}

/**
 * Process-local replay authority for the one fleet Garden process.
 *
 * Consumption is serialized per issuer+jti before the winner is inspected or
 * recorded. This makes the check-and-set one indivisible operation even when
 * multiple admissions race through asynchronous call sites. Stored values are
 * immutable fingerprints rather than caller-owned objects.
 */
export class AtomicRequestCapabilityReplayPort implements RequestCapabilityReplayPort {
  private readonly consumed = new Map<string, ConsumedCapability>();
  private readonly tails = new Map<string, Promise<void>>();

  async consume(input: RequestCapabilityReplayConsumption):
  Promise<RequestCapabilityReplayOutcome> {
    const key = replayKey(input);
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => turn);
    this.tails.set(key, tail);

    await predecessor;
    try {
      const now = Date.now();
      for (const [consumedKey, consumed] of this.consumed) {
        if (consumed.expiresAtMs <= now) this.consumed.delete(consumedKey);
      }
      const active = this.consumed.get(key);
      const candidateFingerprint = fingerprint(input);
      if (!active) {
        this.consumed.set(key, Object.freeze({
          fingerprint: candidateFingerprint,
          expiresAtMs: input.expiresAt.getTime(),
          result: input.consumeResult,
        }));
        return { outcome: 'consumed', result: input.consumeResult };
      }
      return active.fingerprint === candidateFingerprint
        ? { outcome: 'replayed', result: active.result }
        : { outcome: 'mismatch' };
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
