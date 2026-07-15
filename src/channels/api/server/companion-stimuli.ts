import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';

export type CompanionStimulusSubmitResult =
  | { status: 'accepted'; response?: string }
  | { status: 'cooldown'; retryAfterMs: number };

export interface CompanionStimulusPort {
  submit(message: SubstrateMessage): Promise<CompanionStimulusSubmitResult>;
}

export interface CompanionStimulusIngressOptions {
  cooldownMs: number;
  deliver(message: SubstrateMessage): Promise<{ response?: string }>;
  now?: () => number;
}

/**
 * Authoritative per-endpoint/per-kind limiter around prompt-bearing stimulus
 * delivery. The timestamp is reserved before awaiting delivery so concurrent
 * requests cannot race through the cooldown.
 */
export class CompanionStimulusIngress implements CompanionStimulusPort {
  private readonly lastAcceptedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: CompanionStimulusIngressOptions) {
    if (!Number.isInteger(options.cooldownMs) || options.cooldownMs <= 0) {
      throw new Error('Companion stimulus cooldownMs must be a positive integer');
    }
    this.now = options.now ?? Date.now;
  }

  async submit(message: SubstrateMessage): Promise<CompanionStimulusSubmitResult> {
    const satellite = message.routing?.satellite;
    const stimulus = message.routing?.stimulus;
    if (!satellite || !stimulus) {
      throw new Error('Companion stimulus delivery requires satellite and stimulus routing metadata');
    }
    const key = `${satellite.satelliteId}\u0000${stimulus.kind}`;
    const acceptedAt = this.now();
    const previousAcceptedAt = this.lastAcceptedAt.get(key);
    if (previousAcceptedAt !== undefined) {
      const elapsedMs = Math.max(0, acceptedAt - previousAcceptedAt);
      if (elapsedMs < this.options.cooldownMs) {
        return {
          status: 'cooldown',
          retryAfterMs: this.options.cooldownMs - elapsedMs,
        };
      }
    }

    this.lastAcceptedAt.set(key, acceptedAt);
    try {
      const result = await this.options.deliver(message);
      return {
        status: 'accepted',
        ...(result.response ? { response: result.response } : {}),
      };
    } catch (error) {
      if (this.lastAcceptedAt.get(key) === acceptedAt) {
        this.lastAcceptedAt.delete(key);
      }
      throw error;
    }
  }
}
