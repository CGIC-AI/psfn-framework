/**
 * Deterministic pre-gate configuration for room-participation candidate
 * creation (free-time social autonomy, bible §8.1/§8.4, adjudication S5/S7).
 *
 * This owns the passive-name candidate gate tunables only. Speaking leases,
 * room-episode pressure, the social pot, and the cheap participation appraiser
 * live behind the gateway arbiter and the Room Participation Coordinator seam
 * (bible §13.1) and are configured elsewhere. Full companion/fleet/room
 * autonomy-ladder resolution ("most restrictive wins", §8.4) is a coordinator
 * concern; this file carries a default level plus per-channel overrides so the
 * deterministic candidate gate can run today without the coordinator.
 */

/**
 * Monotonic autonomy ladder (bible §8.4). A higher level is a strict superset
 * of the behaviors permitted by the levels below it.
 *
 * - `off`        — no autonomous room participation at all.
 * - `directed`   — explicit mention / reply candidates only.
 * - `contextual` — directed behavior plus passive-name appraisal and reactions.
 * - `social`     — contextual behavior plus social-pressure initiation and
 *                  eligible room-project topics.
 */
export const PARTICIPATION_AUTONOMY_LEVELS = [
  'off',
  'directed',
  'contextual',
  'social',
] as const;

export type ParticipationAutonomyLevel =
  typeof PARTICIPATION_AUTONOMY_LEVELS[number];

export interface PassiveNameCandidateSettings {
  /** Master switch for passive-name candidate creation. */
  enabled: boolean;
  /**
   * Effective autonomy level applied to a channel with no explicit override.
   * `contextual` enables passive-name candidates; `directed` restricts to
   * explicit mentions; `off` disables all candidate creation.
   */
  defaultAutonomyLevel: ParticipationAutonomyLevel;
  /**
   * Per-channel autonomy overrides (channelId → level). The coordinator will
   * later fold companion/fleet/room policy into this resolution; today the
   * override, when present, is the effective level for the channel.
   */
  channelAutonomyLevels: Record<string, ParticipationAutonomyLevel>;
  /**
   * Bounded count of immediately preceding room messages attached to each
   * candidate for same-name disambiguation (bible §8.2, §11.5 name-collision).
   */
  precedingContextMessages: number;
  /**
   * A trigger message older than this (relative to observation time) is stale
   * and never produces a candidate — a backlog-catch-up guard so replayed or
   * long-delayed observed traffic cannot resurrect old mentions.
   */
  stalenessMs: number;
  /**
   * Per-channel source-message dedup ring size. Enforces "one candidate per
   * source message" across redeliveries without unbounded memory growth.
   */
  dedupeHistoryPerChannel: number;
  /**
   * Name-spam debounce window in milliseconds (bible §8.1, adjudication S7.3).
   * Once a name-triggered candidate is emitted in a channel, further
   * name-triggers in that same channel are suppressed (`debounced`) until this
   * window expires: "repeated name-triggering (one user or several
   * coordinating) yields at most one optional response, then a ~10-minute
   * ignore window." Deterministic and pre-model; the window is per-channel so
   * coordinating spammers across accounts collapse to a single appraisal chain,
   * and spam in one room never silences another. A non-positive value disables
   * debounce entirely (every non-duplicate name-trigger creates a candidate).
   */
  debounceWindowMs: number;
}

export function createDefaultPassiveNameCandidateSettings(): PassiveNameCandidateSettings {
  return {
    enabled: true,
    defaultAutonomyLevel: 'contextual',
    channelAutonomyLevels: {},
    precedingContextMessages: 6,
    stalenessMs: 5 * 60 * 1000,
    dedupeHistoryPerChannel: 256,
    debounceWindowMs: 10 * 60 * 1000,
  };
}

/**
 * Whether the given autonomy level permits a passive-name (contextual summons)
 * candidate. Passive-name participation requires `contextual` or higher.
 */
export function autonomyLevelPermitsPassiveName(
  level: ParticipationAutonomyLevel,
): boolean {
  return level === 'contextual' || level === 'social';
}

/**
 * Whether the given autonomy level permits an explicit-mention / reply
 * candidate. Any level from `directed` upward permits directed candidates.
 */
export function autonomyLevelPermitsDirected(
  level: ParticipationAutonomyLevel,
): boolean {
  return level !== 'off';
}
