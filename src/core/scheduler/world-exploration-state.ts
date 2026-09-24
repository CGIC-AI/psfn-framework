/**
 * Durable invitation state for the world exploration lane
 * (psfn-framework-orn69). Kept companion-private so a crash-looping agent can
 * never invite a paid self-directed world turn on every boot: the interval and
 * the per-day cap are read from, and spent into, this state.
 */
export interface WorldExplorationInvitationState {
  readonly lastInvitedAtMs: number;
  /** UTC calendar day (YYYY-MM-DD) that `turnsToday` counts. */
  readonly dayKey: string;
  readonly turnsToday: number;
}

export interface WorldExplorationStatePort {
  /** The persisted state, or null before the first invitation. Throws on storage failure. */
  load(): Promise<WorldExplorationInvitationState | null>;
  /** Persist the state for an invitation about to be issued. Throws on storage failure. */
  save(state: WorldExplorationInvitationState): Promise<void>;
}
