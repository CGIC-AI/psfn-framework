import type { FreeTimeLane } from '../core/scheduler/free-time-lane.js';
import type { RestSilenceStorePort } from '../core/scheduler/rest-window-policy.js';

/** Test double for the durable rest-silence store (extend-only, per lane). */
export class InMemoryRestSilenceStore implements RestSilenceStorePort {
  readonly rows = new Map<FreeTimeLane, number>();
  failReads = false;
  failWrites = false;

  async readSilencedUntil(lane: FreeTimeLane): Promise<number | null> {
    if (this.failReads) throw new Error('rest silence store unavailable');
    return this.rows.get(lane) ?? null;
  }

  async extendSilence(lane: FreeTimeLane, untilMs: number): Promise<void> {
    if (this.failWrites) throw new Error('rest silence store unavailable');
    const existing = this.rows.get(lane);
    if (existing === undefined || untilMs > existing) this.rows.set(lane, untilMs);
  }
}
