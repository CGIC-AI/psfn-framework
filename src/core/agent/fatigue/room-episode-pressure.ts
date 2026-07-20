/**
 * Room-episode pressure: per-channel aggregate machine-pressure pacing (design
 * bible §12.2, adjudication decision 8, jp36.5.4.1).
 *
 * Dyadic fatigue (per companion/peer) cannot see the *total* machine traffic in
 * a room: three companions in a round-robin can each stay below their dyadic
 * allowance while the room as a whole never lets a human get a word in. This
 * module accounts the missing per-channel aggregate.
 *
 * Design invariants this module preserves:
 *
 * - **Non-monetary.** Pressure is pacing, never budget. It raises the bar for
 *   the next autonomous speaking lease and invites graceful wrap-up; it is
 *   *never* drawn, spent, or reconciled against the social pot. This module
 *   only reads the durable fatigue ledger — it never touches {@link
 *   ../social-pot SocialPotPort} or ICP precedence.
 * - **Per-channel.** Pressure aggregates over one `channelId`, so two rooms are
 *   independent arbitration contexts (adjudication decision 3).
 * - **Human-uncharged.** Only `machine_intelligence`-triggered contributions add
 *   pressure; human/system/unknown triggers contribute zero. Because
 *   human-triggered turns are recorded as `free` (never `charged`), the
 *   ledger-derived path structurally excludes them, and the role filter is
 *   defence-in-depth on top of that.
 * - **Reactions add near-zero pressure** (`reactionPressureUnits`), so an emoji
 *   is not billed like a full reply.
 * - **Continuous decay.** Pressure decays by half-life with elapsed time (quiet
 *   time closes the episode) rather than resetting at a calendar boundary,
 *   mirroring the relationship-pressure model.
 *
 * The pressure figure feeds a small ladder (`calm → elevated → wrap_up_invited`)
 * plus an additive `leaseThresholdBias`. Hard suppression (the Law 36
 * circuit-breaker) is a separate concern owned by jp36.5.4.2, which consumes the
 * pressure this module produces.
 */

import type { FatigueRoomEpisodePressureConfig } from '../../../shared/contracts/charge-policy.js';
import type {
  FatigueBudgetEvent,
  FatigueTriggeringAuthorRole,
} from '../../../shared/contracts/runtime.js';
import type { FatigueBudgetHistoryPort } from './fatigue-budget.js';

/** A reply is a full machine turn; a reaction is a near-zero-pressure emoji. */
export type RoomEpisodeContributionKind = 'reply' | 'reaction';

/**
 * One machine action in a room that may add pacing pressure. `triggerRole` is
 * the role that triggered the action; only `machine_intelligence` adds pressure.
 */
export interface RoomEpisodeContribution {
  timestampMs: number;
  triggerRole: FatigueTriggeringAuthorRole;
  kind: RoomEpisodeContributionKind;
}

export type RoomEpisodePressureLevel = 'calm' | 'elevated' | 'wrap_up_invited';

export interface RoomEpisodePressureState {
  level: RoomEpisodePressureLevel;
  /** True once pressure reaches the wrap-up threshold. */
  wrapUpInvited: boolean;
  /**
   * Additive bias raising the autonomous-lease confidence bar: 0 below the
   * elevated threshold, ramping linearly to `maxLeaseThresholdBias` at the
   * wrap-up threshold, then held there.
   */
  leaseThresholdBias: number;
}

export interface RoomEpisodePressureAssessment extends RoomEpisodePressureState {
  channelId: string;
  /** Decayed aggregate pressure (non-monetary units). */
  pressure: number;
  /** Machine contributions that fell inside the window and added pressure. */
  contributingEventCount: number;
  /** Oldest timestamp still inside the bounded window. */
  windowStartMs: number;
  evaluatedAtMs: number;
}

function assertFiniteNonNegative(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`roomEpisodePressure.${field} must be a finite number >= 0`);
  }
  return value;
}

function assertPositiveFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`roomEpisodePressure.${field} must be a finite number > 0`);
  }
  return value;
}

/**
 * Validate the config at the point of use. The owner-file loader
 * ({@link ../../../system/config/charge-policy-config}) is the primary guard;
 * this fails closed if a malformed config reaches the accounting layer.
 */
export function assertRoomEpisodePressureConfig(
  config: FatigueRoomEpisodePressureConfig,
): FatigueRoomEpisodePressureConfig {
  const halfLifeMs = assertPositiveFinite(config.halfLifeMs, 'halfLifeMs');
  const windowMs = assertPositiveFinite(config.windowMs, 'windowMs');
  if (windowMs < halfLifeMs) {
    throw new Error('roomEpisodePressure.windowMs must be >= roomEpisodePressure.halfLifeMs');
  }
  const replyPressureUnits = assertPositiveFinite(config.replyPressureUnits, 'replyPressureUnits');
  const reactionPressureUnits = assertFiniteNonNegative(
    config.reactionPressureUnits,
    'reactionPressureUnits',
  );
  if (reactionPressureUnits > replyPressureUnits) {
    throw new Error(
      'roomEpisodePressure.reactionPressureUnits must be <= roomEpisodePressure.replyPressureUnits',
    );
  }
  const elevatedThreshold = assertPositiveFinite(config.elevatedThreshold, 'elevatedThreshold');
  const wrapUpThreshold = assertPositiveFinite(config.wrapUpThreshold, 'wrapUpThreshold');
  if (wrapUpThreshold <= elevatedThreshold) {
    throw new Error(
      'roomEpisodePressure.wrapUpThreshold must be > roomEpisodePressure.elevatedThreshold',
    );
  }
  const maxLeaseThresholdBias = assertPositiveFinite(
    config.maxLeaseThresholdBias,
    'maxLeaseThresholdBias',
  );
  return {
    halfLifeMs,
    windowMs,
    replyPressureUnits,
    reactionPressureUnits,
    elevatedThreshold,
    wrapUpThreshold,
    maxLeaseThresholdBias,
  };
}

function contributionWeight(
  kind: RoomEpisodeContributionKind,
  config: FatigueRoomEpisodePressureConfig,
): number {
  return kind === 'reaction' ? config.reactionPressureUnits : config.replyPressureUnits;
}

export interface RoomEpisodePressureComputation {
  pressure: number;
  contributingEventCount: number;
  windowStartMs: number;
}

/**
 * Sum the decayed pacing pressure of a set of room contributions. Pure and
 * deterministic. Non-machine triggers and out-of-window contributions are
 * excluded; reactions are weighted near-zero.
 */
export function computeRoomEpisodePressure(input: {
  contributions: readonly RoomEpisodeContribution[];
  config: FatigueRoomEpisodePressureConfig;
  nowMs: number;
}): RoomEpisodePressureComputation {
  const config = assertRoomEpisodePressureConfig(input.config);
  const nowMs = assertFiniteNonNegative(input.nowMs, 'nowMs');
  const windowStartMs = Math.max(0, nowMs - config.windowMs);

  let pressure = 0;
  let contributingEventCount = 0;
  for (const contribution of input.contributions) {
    if (contribution.triggerRole !== 'machine_intelligence') {
      // Human/system/unknown triggers never add machine pressure.
      continue;
    }
    const timestampMs = contribution.timestampMs;
    if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs) || timestampMs < 0) {
      throw new Error('roomEpisodePressure contribution.timestampMs must be a finite number >= 0');
    }
    if (timestampMs < windowStartMs || timestampMs > nowMs) {
      continue;
    }
    const ageMs = nowMs - timestampMs;
    const weight = contributionWeight(contribution.kind, config);
    pressure += weight * 2 ** (-ageMs / config.halfLifeMs);
    contributingEventCount += 1;
  }
  return { pressure, contributingEventCount, windowStartMs };
}

/** Map an aggregate pressure figure onto the pacing ladder. */
export function resolveRoomEpisodePressureState(input: {
  pressure: number;
  config: FatigueRoomEpisodePressureConfig;
}): RoomEpisodePressureState {
  const config = assertRoomEpisodePressureConfig(input.config);
  const pressure = assertFiniteNonNegative(input.pressure, 'pressure');

  if (pressure >= config.wrapUpThreshold) {
    return {
      level: 'wrap_up_invited',
      wrapUpInvited: true,
      leaseThresholdBias: config.maxLeaseThresholdBias,
    };
  }
  if (pressure >= config.elevatedThreshold) {
    const span = config.wrapUpThreshold - config.elevatedThreshold;
    const ramp = (pressure - config.elevatedThreshold) / span;
    return {
      level: 'elevated',
      wrapUpInvited: false,
      leaseThresholdBias: config.maxLeaseThresholdBias * ramp,
    };
  }
  return { level: 'calm', wrapUpInvited: false, leaseThresholdBias: 0 };
}

/** Combine {@link computeRoomEpisodePressure} and {@link resolveRoomEpisodePressureState}. */
export function assessRoomEpisodePressure(input: {
  channelId: string;
  contributions: readonly RoomEpisodeContribution[];
  config: FatigueRoomEpisodePressureConfig;
  nowMs: number;
}): RoomEpisodePressureAssessment {
  const channelId = input.channelId.trim();
  if (!channelId) {
    throw new Error('roomEpisodePressure.channelId is required');
  }
  const { pressure, contributingEventCount, windowStartMs } = computeRoomEpisodePressure({
    contributions: input.contributions,
    config: input.config,
    nowMs: input.nowMs,
  });
  const state = resolveRoomEpisodePressureState({ pressure, config: input.config });
  return {
    channelId,
    pressure,
    contributingEventCount,
    windowStartMs,
    evaluatedAtMs: input.nowMs,
    ...state,
  };
}

/**
 * Derive room-episode pressure from the durable fatigue ledger for one channel,
 * across every peer in it. This is the "through FatigueBudgetPort" path: it
 * reads the same ledger that backs the fatigue budget rather than an
 * arbiter-local store (parent bead jp36.5.4).
 *
 * Only `charged`/`overcharge` machine turns become reply contributions — `free`
 * turns (human-authored, or peer-not-MI) are structurally excluded, so the
 * human-uncharged invariant holds. Reactions are not written to the fatigue
 * ledger (they do not spend dyadic fatigue); callers that observe reactions may
 * pass them via `additionalContributions` so they add their near-zero pressure.
 */
export function readRoomEpisodePressureFromLedger(
  history: Pick<FatigueBudgetHistoryPort, 'listFatigueEvents'>,
  input: {
    localCompanionId: string;
    channelId: string;
    nowMs: number;
    config: FatigueRoomEpisodePressureConfig;
    additionalContributions?: readonly RoomEpisodeContribution[];
  },
): RoomEpisodePressureAssessment {
  const config = assertRoomEpisodePressureConfig(input.config);
  const localCompanionId = input.localCompanionId.trim();
  if (!localCompanionId) {
    throw new Error('roomEpisodePressure.localCompanionId is required');
  }
  const channelId = input.channelId.trim();
  if (!channelId) {
    throw new Error('roomEpisodePressure.channelId is required');
  }
  const nowMs = assertFiniteNonNegative(input.nowMs, 'nowMs');

  const events = history.listFatigueEvents({
    localCompanionId,
    channelId,
    sinceMs: Math.max(0, nowMs - config.windowMs),
    untilMs: nowMs,
  });

  const ledgerContributions: RoomEpisodeContribution[] = events
    .filter((event: FatigueBudgetEvent) => event.decision === 'charged' || event.decision === 'overcharge')
    .map((event: FatigueBudgetEvent) => ({
      timestampMs: event.timestampMs,
      triggerRole: event.triggeringAuthor.role,
      kind: 'reply' as const,
    }));

  const contributions = input.additionalContributions
    ? [...ledgerContributions, ...input.additionalContributions]
    : ledgerContributions;

  return assessRoomEpisodePressure({ channelId, contributions, config, nowMs });
}
