// ── RestWindowPolicyPort (bible §10.2, adjudication S12.8) ──
//
// The named port that owns the quiet-period / silence-persistence policy for
// free time. When the companion chooses to rest (or the chooser fails closed to
// rest), that decision persists for the quiet period so the scheduler does not
// re-prompt her within the same window — "not again for this quiet period." The
// goal is never to annoy her into muting her own reminders again.
//
// psfn-framework-89muv: the decision is durable. A deploy or crash must not
// clear an active silence and prompt her again immediately, so the policy is
// backed by a companion-private store (her own schema) keyed by lane, with
// extend-only semantics enforced by the store itself.

import type { FreeTimeLane } from './free-time-lane.js';

/** A recorded silence decision that suppresses re-prompting from `nowMs`. */
export interface RestWindowSilenceInput {
  readonly lane: FreeTimeLane;
  readonly nowMs: number;
  /** How long the silence persists from `nowMs` (the quiet-period duration). */
  readonly durationMs: number;
}

/** A query for whether a lane is currently silenced. */
export interface RestWindowSilenceQuery {
  readonly lane: FreeTimeLane;
  readonly nowMs: number;
}

export interface RestWindowPolicyPort {
  /**
   * True when this lane has a live silence decision covering `nowMs`. Throws
   * when the durable state cannot be read; callers must treat that as "do not
   * prompt", never as "not silenced".
   */
  isSilenced(query: RestWindowSilenceQuery): Promise<boolean>;
  /**
   * Persist a silence decision for the lane's quiet period. The silence holds
   * in-process before the durable write; a durable failure throws after that.
   */
  recordSilence(input: RestWindowSilenceInput): Promise<void>;
}

/** Companion-private durable silence state, one row per lane. */
export interface RestSilenceStorePort {
  /** The durable silenced-until instant for the lane, or null when none. */
  readSilencedUntil(lane: FreeTimeLane): Promise<number | null>;
  /** Extend-only: the durable value becomes max(existing, untilMs). */
  extendSilence(lane: FreeTimeLane, untilMs: number): Promise<void>;
}

/**
 * Durable {@link RestWindowPolicyPort}. Silence is scoped per lane (a rest
 * during quiet hours does not suppress a daytime idle block, and vice versa) and
 * expires by wall clock, so a fresh quiet period re-prompts naturally. Recording
 * only ever EXTENDS an existing silence — a later rest never shortens the guard.
 * An in-process overlay keeps a recorded silence effective even if the durable
 * write fails, so a storage fault never turns rest into permission to prompt.
 */
export class DurableRestWindowPolicy implements RestWindowPolicyPort {
  private readonly silencedUntilMs = new Map<FreeTimeLane, number>();

  constructor(private readonly store: RestSilenceStorePort) {}

  async isSilenced(query: RestWindowSilenceQuery): Promise<boolean> {
    const local = this.silencedUntilMs.get(query.lane);
    if (local !== undefined && query.nowMs < local) return true;
    const durable = await this.store.readSilencedUntil(query.lane);
    if (durable === null) return false;
    this.extendLocal(query.lane, durable);
    return query.nowMs < durable;
  }

  async recordSilence(input: RestWindowSilenceInput): Promise<void> {
    const until = input.nowMs + Math.max(0, input.durationMs);
    this.extendLocal(input.lane, until);
    await this.store.extendSilence(input.lane, until);
  }

  private extendLocal(lane: FreeTimeLane, until: number): void {
    const existing = this.silencedUntilMs.get(lane);
    if (existing === undefined || until > existing) {
      this.silencedUntilMs.set(lane, until);
    }
  }
}
