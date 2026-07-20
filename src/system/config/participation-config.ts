import { isRecord } from '../../shared/utils/types.js';
import { assertNoUnknownKeys, assertPositiveInteger } from './validators.js';

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

/**
 * Tunables for the cheap, tool-less participation appraiser (bible §8.2). The
 * appraiser runs a single background-model call per created candidate and
 * returns a strict ternary (ignore/react/reply). Everything here bounds that
 * one call so it can never grow into a heavy or unbounded prompt; the appraiser
 * fails closed to `ignore` on any error, timeout, or malformed output.
 */
export interface ParticipationAppraiserSettings {
  /** Master switch. When false the appraiser fails closed to `ignore`. */
  enabled: boolean;
  /**
   * Hard wall-clock ceiling for the background-model call. On expiry the call
   * is aborted and the appraiser fails closed to `ignore` — never a
   * default-respond (bible §18 "Passive-name appraiser unavailable").
   */
  appraisalDeadlineMs: number;
  /** Output-token ceiling for the ternary; the contract needs only a few. */
  appraisalMaxOutputTokens: number;
  /**
   * Bounded count of preceding room messages rendered into the datamarked
   * transcript, so a long backlog cannot inflate the prompt. The candidate
   * already carries a bounded window; this is a second belt-and-braces cap.
   */
  transcriptMessageCap: number;
  /** Per-message character cap inside the transcript. */
  transcriptMessageChars: number;
}

/**
 * Defaults factory (owner-file / settings pattern). All numeric tunables live
 * inside the function body — never as module-level tuning constants — so the
 * hardcoded-settings gate stays satisfied and Garden/config can own overrides.
 */
export function createDefaultParticipationAppraiserSettings(): ParticipationAppraiserSettings {
  return {
    enabled: true,
    appraisalDeadlineMs: 8_000,
    appraisalMaxOutputTokens: 200,
    transcriptMessageCap: 8,
    transcriptMessageChars: 500,
  };
}

/**
 * Tunables for the speaking-arbiter reservation phase (bible §8.5/§12.2,
 * §6.10, jp36.5.1.2). The reservation phase is the deterministic gate that runs
 * BEFORE the participation appraiser's model call ("peek before the model
 * runs"): it resolves ICP-over-social precedence and the social-pot funding
 * peek, and only if those admit does it place a non-exclusive candidate
 * reservation and let the candidate reach appraisal. A gated candidate never
 * reaches a model call. These tunables bound that gate; the actual pot draw and
 * the exclusive egress lease bind later at delivery (jp36.5.1.3).
 */
export interface ReservationPhaseSettings {
  /**
   * Reservation TTL. A candidate reservation not promoted to an egress lease
   * within this window is swept and can never promote, so a crashed appraisal
   * leaks neither the reservation nor an appraisal spend beyond it.
   */
  reservationTtlMs: number;
  /**
   * Minimum social-pot balance (charge-policy units) required for a candidate to
   * be worth appraising. This is a non-mutating funding PEEK, never a draw — the
   * draw binds only at egress (§8.5). Below this the candidate is gated
   * (`fatigue_pot_insufficient`) and the appraiser model never runs.
   */
  minReserveDrawUnits: number;
}

/**
 * Defaults factory (owner-file / settings pattern). All numeric tunables live
 * inside the function body — never as module-level tuning constants — so the
 * hardcoded-settings gate stays satisfied and Garden/config can own overrides.
 */
export function createDefaultReservationPhaseSettings(): ReservationPhaseSettings {
  return {
    reservationTtlMs: 2 * 60 * 1000,
    minReserveDrawUnits: 1,
  };
}

/**
 * Tunables for the speaking-arbiter egress-lease phase (bible §8.5/§12.2, §18,
 * §20.1, jp36.5.1.3). This is phase 2: the exclusive send-once binding at
 * delivery ("bind only at egress"). It is the ONLY place the social pot is
 * actually drawn and the fenced egress lease is acquired, after the Law-36
 * single-probe breaker gate, the lease-threshold-bias confidence bar, and
 * speak-least fairness admit the turn.
 */
export interface EgressLeasePhaseSettings {
  /**
   * Whether the arbiter actually binds a lease and delivers autonomous room
   * replies. Defaults to OFF: promoting an observed candidate to a real
   * autonomous send is a new, CogSec-sensitive surface, so it is opt-in and
   * fail-closed — with it disabled the observe/appraise path is unchanged and no
   * autonomous reply is sent.
   */
  enabled: boolean;
  /**
   * Egress lease deadline window. A crashed holder's lease is reclaimable by
   * another turn once it lapses (bible §18 "lease expires during generation").
   */
  leaseTtlMs: number;
  /**
   * The REAL social-pot draw amount bound at egress (charge-policy units) — the
   * fatigue actually spent to speak (§8.5 "bind only at egress"), distinct from
   * the phase-1 non-mutating funding peek.
   */
  egressDrawUnits: number;
  /**
   * Base confidence a `reply` appraisal must clear to bind a lease. Rising
   * room-episode pressure adds `leaseThresholdBias` on top of this bar, so a
   * flooding room raises the bar for another autonomous lease (soft wrap-up).
   */
  minReplyConfidence: number;
}

/**
 * Defaults factory (owner-file / settings pattern). All numeric tunables live
 * inside the function body — never as module-level tuning constants — so the
 * hardcoded-settings gate stays satisfied and Garden/config can own overrides.
 */
export function createDefaultEgressLeasePhaseSettings(): EgressLeasePhaseSettings {
  return {
    enabled: false,
    leaseTtlMs: 60 * 1000,
    egressDrawUnits: 1,
    minReplyConfidence: 0.5,
  };
}

/**
 * Owner-file-exposed egress-lease tunables (jp36.8.2). The `enabled` flag is
 * DELIBERATELY excluded from the owner-file surface: promoting an observed
 * candidate to a real autonomous send is code-pinned OFF and no enablement
 * override may exist until qgqw.3 (P1) lands. The tunables below are safe to
 * expose because they only shape a send that the code-pinned flag still gates.
 */
export type EgressLeaseTunables = Omit<EgressLeasePhaseSettings, 'enabled'>;

export function createDefaultEgressLeaseTunables(): EgressLeaseTunables {
  const { enabled: _enabled, ...tunables } = createDefaultEgressLeasePhaseSettings();
  return tunables;
}

// ── Owner-file parsers (jp36.8.2) ────────────────────────────────────────────
// Fail-closed parsers that give the participation tunables canonical
// scheduler.json homes (Garden-editable via the raw owner-file editor). Every
// default is sourced from the createDefault* factories above so a config that
// omits a knob is byte-identical to the pre-owner-file behavior. Numeric bounds
// live inside these function bodies (never module-level tuning constants) so the
// hardcoded-settings gate stays satisfied.

const PARTICIPATION_ERROR_PREFIX = 'Invalid participation config';

function participationRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be an object`);
  }
  return value;
}

function participationBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be a boolean`);
  }
  return value;
}

function participationPositiveInteger(value: unknown, fieldPath: string): number {
  return assertPositiveInteger(value, fieldPath, {
    min: 1,
    message: ({ fieldLabel }) => `${PARTICIPATION_ERROR_PREFIX}: ${fieldLabel} must be a finite integer >= 1`,
  });
}

function participationNonNegativeInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be a finite integer >= 0`);
  }
  return value;
}

function participationFiniteInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be a finite integer`);
  }
  return value;
}

function participationPositiveNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be a finite number > 0`);
  }
  return value;
}

function participationNonNegativeNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be a finite number >= 0`);
  }
  return value;
}

function participationUnitInterval(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be a finite number between 0 and 1`);
  }
  return value;
}

function participationAutonomyLevel(value: unknown, fieldPath: string): ParticipationAutonomyLevel {
  if (
    typeof value !== 'string'
    || !(PARTICIPATION_AUTONOMY_LEVELS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `${PARTICIPATION_ERROR_PREFIX}: ${fieldPath} must be one of `
      + `${PARTICIPATION_AUTONOMY_LEVELS.map(level => `"${level}"`).join(', ')}`,
    );
  }
  return value as ParticipationAutonomyLevel;
}

function participationChannelAutonomyLevels(
  value: unknown,
  fieldPath: string,
): Record<string, ParticipationAutonomyLevel> {
  const record = participationRecord(value, fieldPath);
  const parsed: Record<string, ParticipationAutonomyLevel> = {};
  for (const [channelId, level] of Object.entries(record)) {
    parsed[channelId] = participationAutonomyLevel(level, `${fieldPath}.${channelId}`);
  }
  return parsed;
}

export function parsePassiveNameCandidateSettings(
  raw: unknown,
  fieldPath: string,
): PassiveNameCandidateSettings {
  const defaults = createDefaultPassiveNameCandidateSettings();
  if (raw === undefined) {
    return defaults;
  }
  const record = participationRecord(raw, fieldPath);
  assertNoUnknownKeys(
    record,
    [
      'enabled',
      'defaultAutonomyLevel',
      'channelAutonomyLevels',
      'precedingContextMessages',
      'stalenessMs',
      'dedupeHistoryPerChannel',
      'debounceWindowMs',
    ],
    fieldPath,
    { errorPrefix: PARTICIPATION_ERROR_PREFIX },
  );
  return {
    enabled: participationBoolean(record.enabled ?? defaults.enabled, `${fieldPath}.enabled`),
    defaultAutonomyLevel: participationAutonomyLevel(
      record.defaultAutonomyLevel ?? defaults.defaultAutonomyLevel,
      `${fieldPath}.defaultAutonomyLevel`,
    ),
    channelAutonomyLevels: participationChannelAutonomyLevels(
      record.channelAutonomyLevels ?? defaults.channelAutonomyLevels,
      `${fieldPath}.channelAutonomyLevels`,
    ),
    precedingContextMessages: participationNonNegativeInteger(
      record.precedingContextMessages ?? defaults.precedingContextMessages,
      `${fieldPath}.precedingContextMessages`,
    ),
    stalenessMs: participationPositiveInteger(
      record.stalenessMs ?? defaults.stalenessMs,
      `${fieldPath}.stalenessMs`,
    ),
    dedupeHistoryPerChannel: participationPositiveInteger(
      record.dedupeHistoryPerChannel ?? defaults.dedupeHistoryPerChannel,
      `${fieldPath}.dedupeHistoryPerChannel`,
    ),
    // Non-positive disables debounce entirely (see the field doc), so a finite
    // integer — including <= 0 — is accepted here.
    debounceWindowMs: participationFiniteInteger(
      record.debounceWindowMs ?? defaults.debounceWindowMs,
      `${fieldPath}.debounceWindowMs`,
    ),
  };
}

export function parseParticipationAppraiserSettings(
  raw: unknown,
  fieldPath: string,
): ParticipationAppraiserSettings {
  const defaults = createDefaultParticipationAppraiserSettings();
  if (raw === undefined) {
    return defaults;
  }
  const record = participationRecord(raw, fieldPath);
  assertNoUnknownKeys(
    record,
    [
      'enabled',
      'appraisalDeadlineMs',
      'appraisalMaxOutputTokens',
      'transcriptMessageCap',
      'transcriptMessageChars',
    ],
    fieldPath,
    { errorPrefix: PARTICIPATION_ERROR_PREFIX },
  );
  return {
    enabled: participationBoolean(record.enabled ?? defaults.enabled, `${fieldPath}.enabled`),
    appraisalDeadlineMs: participationPositiveInteger(
      record.appraisalDeadlineMs ?? defaults.appraisalDeadlineMs,
      `${fieldPath}.appraisalDeadlineMs`,
    ),
    appraisalMaxOutputTokens: participationPositiveInteger(
      record.appraisalMaxOutputTokens ?? defaults.appraisalMaxOutputTokens,
      `${fieldPath}.appraisalMaxOutputTokens`,
    ),
    transcriptMessageCap: participationPositiveInteger(
      record.transcriptMessageCap ?? defaults.transcriptMessageCap,
      `${fieldPath}.transcriptMessageCap`,
    ),
    transcriptMessageChars: participationPositiveInteger(
      record.transcriptMessageChars ?? defaults.transcriptMessageChars,
      `${fieldPath}.transcriptMessageChars`,
    ),
  };
}

export function parseReservationPhaseSettings(
  raw: unknown,
  fieldPath: string,
): ReservationPhaseSettings {
  const defaults = createDefaultReservationPhaseSettings();
  if (raw === undefined) {
    return defaults;
  }
  const record = participationRecord(raw, fieldPath);
  assertNoUnknownKeys(
    record,
    ['reservationTtlMs', 'minReserveDrawUnits'],
    fieldPath,
    { errorPrefix: PARTICIPATION_ERROR_PREFIX },
  );
  return {
    reservationTtlMs: participationPositiveInteger(
      record.reservationTtlMs ?? defaults.reservationTtlMs,
      `${fieldPath}.reservationTtlMs`,
    ),
    minReserveDrawUnits: participationNonNegativeNumber(
      record.minReserveDrawUnits ?? defaults.minReserveDrawUnits,
      `${fieldPath}.minReserveDrawUnits`,
    ),
  };
}

export function parseEgressLeaseTunables(
  raw: unknown,
  fieldPath: string,
): EgressLeaseTunables {
  const defaults = createDefaultEgressLeaseTunables();
  if (raw === undefined) {
    return defaults;
  }
  const record = participationRecord(raw, fieldPath);
  // `enabled` is intentionally NOT accepted here — it stays code-pinned false
  // until qgqw.3 (P1). Listing it as an unknown key keeps the fail-closed guard
  // from silently letting an operator flip on autonomous egress via config.
  assertNoUnknownKeys(
    record,
    ['leaseTtlMs', 'egressDrawUnits', 'minReplyConfidence'],
    fieldPath,
    { errorPrefix: PARTICIPATION_ERROR_PREFIX },
  );
  return {
    leaseTtlMs: participationPositiveInteger(
      record.leaseTtlMs ?? defaults.leaseTtlMs,
      `${fieldPath}.leaseTtlMs`,
    ),
    egressDrawUnits: participationPositiveNumber(
      record.egressDrawUnits ?? defaults.egressDrawUnits,
      `${fieldPath}.egressDrawUnits`,
    ),
    minReplyConfidence: participationUnitInterval(
      record.minReplyConfidence ?? defaults.minReplyConfidence,
      `${fieldPath}.minReplyConfidence`,
    ),
  };
}
