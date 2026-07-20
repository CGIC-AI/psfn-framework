// ── RestWindowPolicyPort (bible §10.2, adjudication S12.8) ──
//
// The named port that owns the quiet-period / silence-persistence policy for
// free time. When the companion chooses to rest (or the chooser fails closed to
// rest), that decision persists for the quiet period so the scheduler does not
// re-prompt her within the same window — "not again for this quiet period." The
// goal is never to annoy her into muting her own reminders again.
//
// This is deliberately a small, injectable port with an in-memory default
// adapter. Process-lived state matches the existing free-time cadence state
// (`FreeTimeLaneCadenceState`), which is also in-memory; no new persistence
// backend is introduced (jp36.2 non-goal). A durable adapter can replace the
// default without touching the chooser.

import type { FreeTimeLane } from './free-time.js';

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
  /** True when this lane has a live silence decision covering `nowMs`. */
  isSilenced(query: RestWindowSilenceQuery): boolean;
  /** Persist a silence decision for the lane's quiet period. */
  recordSilence(input: RestWindowSilenceInput): void;
}

/**
 * In-memory {@link RestWindowPolicyPort}. Silence is scoped per lane (a rest
 * during quiet hours does not suppress a daytime idle block, and vice versa) and
 * expires by wall clock, so a fresh quiet period re-prompts naturally. Recording
 * only ever EXTENDS an existing silence within a period — a later rest in the
 * same window never shortens the guard.
 */
export class InMemoryRestWindowPolicy implements RestWindowPolicyPort {
  private readonly silencedUntilMs = new Map<FreeTimeLane, number>();

  isSilenced(query: RestWindowSilenceQuery): boolean {
    const until = this.silencedUntilMs.get(query.lane);
    return until !== undefined && query.nowMs < until;
  }

  recordSilence(input: RestWindowSilenceInput): void {
    const until = input.nowMs + Math.max(0, input.durationMs);
    const existing = this.silencedUntilMs.get(input.lane);
    if (existing === undefined || until > existing) {
      this.silencedUntilMs.set(input.lane, until);
    }
  }
}
