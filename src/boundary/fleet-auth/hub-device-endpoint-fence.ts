// Shared by every Hub device fence (guest attachments and virtual_space
// endpoints) so both surfaces fence for the same window: the longest an
// assertion can live.
export const DEFAULT_FENCE_TTL_MS = 70_000;
export const DEFAULT_MAX_FENCES = 1024;


/**
 * Bounded, time-limited fence for Hub device surfaces that have no human
 * attachment row to fence (the `virtual_space` projection). A rejected
 * assertion fences its endpoint for the same window the guest attachment store
 * applies to a rejected `human_surface` connection, so a caller holding a
 * valid satellite key cannot submit unlimited malformed or guessed assertions.
 */
export class HubDeviceEndpointFence {
  private readonly fences = new Map<string, number>();

  private readonly now: () => number;
  private readonly fenceTtlMs: number;
  private readonly maxFences: number;

  constructor(options: { now?: () => number; fenceTtlMs?: number; maxFences?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fenceTtlMs = options.fenceTtlMs ?? DEFAULT_FENCE_TTL_MS;
    this.maxFences = options.maxFences ?? DEFAULT_MAX_FENCES;
  }

  isFenced(key: string): boolean {
    const until = this.fences.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.fences.delete(key);
      return false;
    }
    return true;
  }

  fence(key: string): void {
    const nowMs = this.now();
    for (const [existing, until] of this.fences) {
      if (until <= nowMs) this.fences.delete(existing);
    }
    // Refresh moves the key to the newest position; at the cap the oldest
    // fence is dropped (memory bound under a rejection flood, never a bypass
    // for the endpoint being fenced now).
    this.fences.delete(key);
    if (this.fences.size >= this.maxFences) {
      const oldest = this.fences.keys().next().value;
      if (oldest !== undefined) this.fences.delete(oldest);
    }
    this.fences.set(key, nowMs + this.fenceTtlMs);
  }
}

export function virtualSpaceFenceKey(satelliteId: string, endpointId: string): string {
  return `virtual_space\0${satelliteId}\0${endpointId}`;
}
