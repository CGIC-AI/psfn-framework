/**
 * Speaking-arbiter reservation phase: deterministic candidate gating before the
 * appraisal spend (design bible §8.5/§12.2, §6.10; adjudication §3 R2;
 * jp36.5.1.2).
 *
 * This is phase 1 of the two-phase arbiter protocol. A room-participation
 * candidate produced by the deterministic passive-name gate is NOT sent straight
 * to the cheap participation appraiser. It first passes this reservation phase,
 * which:
 *
 *   1. resolves the deterministic pre-gates §6.10 mandates *before* any model
 *      call — ICP-over-social precedence ("lease availability"), an optional
 *      room-episode hard-suppression pressure gate, and the social-pot funding
 *      state ("fatigue state"); and
 *   2. only if every gate admits, places a **non-exclusive** candidate
 *      reservation against the gateway-owned Postgres arbiter store (multiple
 *      companions may reserve for one triggering event) and lets the candidate
 *      reach appraisal.
 *
 * A **gated** candidate never creates a reservation and never reaches a model
 * call ("peek before the model runs"). A **reserved** candidate is appraised; if
 * the appraiser returns `ignore` (including a fail-closed ignore) the reservation
 * is released — silence is a valid release, never retried into speech (§6.7). A
 * `react`/`reply` reservation is handed onward to the exclusive egress-lease
 * phase (jp36.5.1.3); the pot draw and the send-once egress lease bind only there
 * ("bind only at egress"), never here.
 *
 * Fail-closed discipline: any error resolving a gate signal, malformed gate
 * input, or a store failure yields a `gated` decision — no reservation, hence no
 * appraisal. A gate failure can only ever suppress participation, never invent
 * it. The phase itself runs no model and holds no exclusivity; it is a legible,
 * testable seam over injected, deterministic primitives.
 *
 * ## Pressure is single-source (caller obligation, jp36.5.1)
 *
 * This phase does NOT read the arbiter store's raw, ever-accumulating episode
 * `pressure` scalar for its hard-suppression gate — that scalar is undecayed and
 * gating on it would over-suppress. The decayed, reconciled room-episode pressure
 * is owned by the jp36.5.4 seam (ledger-derived) and, when that single source is
 * wired, the integrator injects a {@link RoomEpisodePressureResolver}. Until then
 * the room-pressure hard gate is simply not applied at reservation time; the
 * Law-36 breaker and its single-probe fencing still gate the exclusive egress
 * lease downstream (jp36.5.1.3), so hard suppression is never bypassed, only
 * applied at the binding phase.
 */

import { randomUUID } from 'node:crypto';

import type {
  FatigueRoomEpisodeCircuitBreakerConfig,
  FatigueSocialPotConfig,
} from '../../../shared/contracts/charge-policy.js';
import type { IcpAvailabilityState } from '../../../shared/contracts/icp-autonomy.js';
import type { ParticipationAction } from '../../participation/types.js';
import {
  resolveIcpSocialPrecedence,
  type IcpSocialPrecedenceInput,
} from '../../icp/social-precedence.js';
import { assertRoomEpisodeCircuitBreakerConfig } from '../fatigue/room-episode-circuit-breaker.js';
import type { SocialPotConfig, SocialPotPort } from '../fatigue/social-pot.js';
import type {
  RoomEpisodeSnapshot,
  SpeakingArbiterStorePort,
  SpeakingReservationSnapshot,
} from './speaking-arbiter-store-port.js';

/** The deterministic context a reservation gate resolves its signals from. */
export interface ReservationSignalContext {
  channelId: string;
  /** The room event that made this companion a candidate (candidate.sourceMessageId). */
  triggerEventId: string;
  companionId: string;
  nowMs: number;
}

/**
 * Resolves the ICP-over-social precedence inputs for a candidate. ICP is a
 * separate, dominant autonomy authority; where it contends, social yields
 * (§8.5). The live signals (current availability lease, in-flight ICP turn
 * fence, ICP continuation exhaustion) are wired by the ICP transport seam
 * (jp36.5.2); this phase only consumes the resolved inputs.
 */
export interface IcpSocialPrecedenceResolver {
  resolve(ctx: ReservationSignalContext): IcpSocialPrecedenceInput | Promise<IcpSocialPrecedenceInput>;
}

/**
 * Resolves the reconciled, decayed room-episode pressure for a channel (the
 * single source owned by the jp36.5.4 seam). Optional: when absent, the
 * room-pressure hard gate is not applied at reservation time (see module doc).
 */
export interface RoomEpisodePressureResolver {
  resolve(ctx: ReservationSignalContext): number | Promise<number>;
}

/** Why a candidate was gated out before appraisal. */
export type ReservationGateBlockReason =
  /** An in-flight ICP turn fence is live for this scope; social must not race it. */
  | 'icp_turn_fenced'
  /** The ICP continuation fatigue lane is at its hard stop. */
  | 'icp_fatigue_exhausted'
  /** The companion's own ICP availability lease is a non-open state (DND/busy/resting). */
  | 'icp_availability'
  /** Decayed room-episode pressure is at/above the Law-36 breaker trip threshold. */
  | 'room_flooded'
  /** The social pot cannot fund even a minimal social turn. */
  | 'fatigue_pot_insufficient'
  /** Fail-closed: a gate signal, gate input, or the store errored. */
  | 'gate_error';

/** The stage at which a `gate_error` occurred (content-free, for telemetry). */
export type ReservationGateErrorStage =
  | 'icp_precedence'
  | 'room_pressure'
  | 'social_pot'
  | 'reserve';

export interface ReservationReservedOutcome {
  outcome: 'reserved';
  reservation: SpeakingReservationSnapshot;
  episode: RoomEpisodeSnapshot;
  /** True when a durable reservation already existed for (channel, event, companion). */
  replayed: boolean;
}

export interface ReservationGatedOutcome {
  outcome: 'gated';
  blockedBy: ReservationGateBlockReason;
  /** Present only for `icp_availability`: the specific non-open state. */
  availabilityState?: Exclude<IcpAvailabilityState, 'available' | 'open_to_chat'>;
  /** Present only for `gate_error`: the stage that failed. */
  errorStage?: ReservationGateErrorStage;
}

export type ReservationDecision = ReservationReservedOutcome | ReservationGatedOutcome;

export interface ReservationPhaseConfig {
  /** Reservation TTL; a reservation not promoted within it is swept. */
  reservationTtlMs: number;
  /**
   * Minimum social-pot balance required for the candidate to be worth appraising.
   * A non-mutating peek — the draw binds at egress, not here (§8.5).
   */
  minReserveDrawUnits: number;
  /** Social-pot economy config (charge-policy `fatigue.socialPot`). */
  socialPot: FatigueSocialPotConfig;
  /** Law-36 breaker config; its trip threshold is the room-pressure hard gate. */
  roomEpisodeCircuitBreaker: FatigueRoomEpisodeCircuitBreakerConfig;
  /**
   * Wrap-up threshold from the paired room-episode pressure config, so the
   * breaker invariant (trip > wrap-up) is re-checked at the point of use.
   */
  wrapUpThreshold: number;
}

export interface ReservationPhaseDeps {
  store: Pick<SpeakingArbiterStorePort, 'reserve' | 'releaseReservation'>;
  socialPot: Pick<SocialPotPort, 'readPot'>;
  icpPrecedence: IcpSocialPrecedenceResolver;
  /** Optional reconciled room-episode pressure source (jp36.5.4 seam). */
  roomPressure?: RoomEpisodePressureResolver;
  /** The local companion this phase reserves for. */
  companionId: string;
  config: ReservationPhaseConfig;
  /** UUID factory for reservation ids; overridable for deterministic tests. */
  generateReservationId?: () => string;
}

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`reservationPhase.${field} must be a non-empty string`);
  }
  return value;
}

function assertFiniteTimestamp(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`reservationPhase.${field} must be a finite number >= 0`);
  }
  return value;
}

function assertPositiveFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`reservationPhase.${field} must be a finite number > 0`);
  }
  return value;
}

function assertNonNegativeFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`reservationPhase.${field} must be a finite number >= 0`);
  }
  return value;
}

/** The store consumes only the regeneration subset of the owner-file pot config. */
function toStorePotConfig(config: FatigueSocialPotConfig): SocialPotConfig {
  return {
    capUnits: config.capUnits,
    regenerationTickMs: config.regenerationTickMs,
    regenerationUnitsPerTick: config.regenerationUnitsPerTick,
  };
}

function gated(
  blockedBy: ReservationGateBlockReason,
  extra?: Partial<ReservationGatedOutcome>,
): ReservationGatedOutcome {
  return { outcome: 'gated', blockedBy, ...extra };
}

/**
 * The deterministic reservation phase (arbiter phase 1). Construct once per
 * local companion with its store, social-pot port, and gate resolvers, then call
 * {@link reserve} per created candidate before appraising it, and
 * {@link settleAfterAppraisal} once the ternary is known.
 */
export class SpeakingReservationPhase {
  private readonly store: Pick<SpeakingArbiterStorePort, 'reserve' | 'releaseReservation'>;
  private readonly socialPot: Pick<SocialPotPort, 'readPot'>;
  private readonly icpPrecedence: IcpSocialPrecedenceResolver;
  private readonly roomPressure?: RoomEpisodePressureResolver;
  private readonly companionId: string;
  private readonly config: ReservationPhaseConfig;
  private readonly generateReservationId: () => string;

  constructor(deps: ReservationPhaseDeps) {
    this.store = deps.store;
    this.socialPot = deps.socialPot;
    this.icpPrecedence = deps.icpPrecedence;
    this.roomPressure = deps.roomPressure;
    this.companionId = assertNonEmpty(deps.companionId, 'companionId');
    this.config = {
      reservationTtlMs: assertPositiveFinite(deps.config.reservationTtlMs, 'reservationTtlMs'),
      minReserveDrawUnits: assertNonNegativeFinite(
        deps.config.minReserveDrawUnits,
        'minReserveDrawUnits',
      ),
      socialPot: deps.config.socialPot,
      roomEpisodeCircuitBreaker: deps.config.roomEpisodeCircuitBreaker,
      wrapUpThreshold: deps.config.wrapUpThreshold,
    };
    this.generateReservationId = deps.generateReservationId ?? randomUUID;
  }

  /**
   * Run the deterministic pre-gates and, if they admit, place a non-exclusive
   * candidate reservation. Returns `gated` (no reservation, do not appraise) or
   * `reserved` (proceed to appraisal). Never throws: every failure fails closed
   * to a `gated` decision.
   */
  async reserve(ctx: ReservationSignalContext): Promise<ReservationDecision> {
    let channelId: string;
    let triggerEventId: string;
    let nowMs: number;
    try {
      channelId = assertNonEmpty(ctx.channelId, 'channelId');
      triggerEventId = assertNonEmpty(ctx.triggerEventId, 'triggerEventId');
      nowMs = assertFiniteTimestamp(ctx.nowMs, 'nowMs');
    } catch {
      return gated('gate_error', { errorStage: 'reserve' });
    }
    const signalCtx: ReservationSignalContext = {
      channelId,
      triggerEventId,
      companionId: this.companionId,
      nowMs,
    };

    // 1. ICP-over-social precedence. ICP dominates: resolve it first so an
    //    in-flight ICP turn, an exhausted continuation lane, or a declared DND
    //    yields the social turn before any economy work.
    let icpInput: IcpSocialPrecedenceInput;
    try {
      icpInput = await this.icpPrecedence.resolve(signalCtx);
    } catch {
      return gated('gate_error', { errorStage: 'icp_precedence' });
    }
    let precedence: ReturnType<typeof resolveIcpSocialPrecedence>;
    try {
      precedence = resolveIcpSocialPrecedence(icpInput);
    } catch {
      return gated('gate_error', { errorStage: 'icp_precedence' });
    }
    if (!precedence.admitted) {
      return gated(precedence.blockedBy, {
        ...(precedence.blockedBy === 'icp_availability' && precedence.availabilityState !== undefined
          ? { availabilityState: precedence.availabilityState }
          : {}),
      });
    }

    // 2. Room-episode hard-suppression gate (optional single source; see module
    //    doc). Decayed pressure at/above the breaker trip threshold suppresses
    //    the autonomous turn before the model runs (Law 36 pre-gate).
    if (this.roomPressure) {
      let pressure: number;
      try {
        pressure = await this.roomPressure.resolve(signalCtx);
        assertNonNegativeFinite(pressure, 'roomPressure');
        const breaker = assertRoomEpisodeCircuitBreakerConfig(
          this.config.roomEpisodeCircuitBreaker,
          this.config.wrapUpThreshold,
        );
        if (pressure >= breaker.tripThreshold) {
          return gated('room_flooded');
        }
      } catch {
        return gated('gate_error', { errorStage: 'room_pressure' });
      }
    }

    // 3. Social-pot funding peek. Non-mutating: readPot persists only regeneration
    //    catch-up, never a draw. Below the minimum the candidate is not worth
    //    appraising — the appraiser model never runs.
    try {
      const pot = await this.socialPot.readPot({
        companionId: this.companionId,
        nowMs,
        config: toStorePotConfig(this.config.socialPot),
      });
      if (pot.balance < this.config.minReserveDrawUnits) {
        return gated('fatigue_pot_insufficient');
      }
    } catch {
      return gated('gate_error', { errorStage: 'social_pot' });
    }

    // 4. Gates admit: place the non-exclusive reservation. A store failure fails
    //    closed — no reservation, hence no appraisal.
    try {
      const result = await this.store.reserve({
        reservationId: this.generateReservationId(),
        channelId,
        triggerEventId,
        companionId: this.companionId,
        nowMs,
        expiresAtMs: nowMs + this.config.reservationTtlMs,
      });
      return {
        outcome: 'reserved',
        reservation: result.reservation,
        episode: result.episode,
        replayed: result.outcome === 'replayed',
      };
    } catch {
      return gated('gate_error', { errorStage: 'reserve' });
    }
  }

  /**
   * Settle a placed reservation once the appraisal ternary is known. An `ignore`
   * (including a fail-closed ignore) releases the reservation — silence is a
   * valid release, never retried into speech (§6.7). A `react`/`reply` keeps the
   * reservation for the exclusive egress-lease phase (jp36.5.1.3). Returns the
   * action it took so callers can record content-free telemetry.
   */
  async settleAfterAppraisal(
    reservation: SpeakingReservationSnapshot,
    action: ParticipationAction,
    nowMs: number,
  ): Promise<'released' | 'retained'> {
    if (action === 'ignore') {
      await this.releaseIgnored(reservation, nowMs);
      return 'released';
    }
    return 'retained';
  }

  /**
   * Release a reservation that will not proceed to speech (an `ignore` outcome,
   * or a reserved candidate with no appraiser to promote it). Records the durable
   * `ignore` reason. Throws on a store failure so the caller can audit it — the
   * reservation is TTL-swept regardless, so a failed release never wedges the
   * room.
   */
  async releaseIgnored(reservation: SpeakingReservationSnapshot, nowMs: number): Promise<void> {
    await this.store.releaseReservation({
      reservationId: reservation.reservationId,
      channelId: reservation.channelId,
      reason: 'ignore',
      nowMs: assertFiniteTimestamp(nowMs, 'nowMs'),
    });
  }
}
