/**
 * Law 36 hard-suppression circuit breaker for room-episode pressure (charter
 * §8.11 "Soft Guidance Before Behavioral Circuit Breakers"; design bible
 * §12.2/§20.2 "hard suppression remains the final safety mechanism … remains
 * testable"; adjudication decision 8, jp36.5.4.2).
 *
 * The room-episode pressure ladder ({@link ./room-episode-pressure}) is the soft
 * layer: rising per-channel machine pressure raises the autonomous-lease bar and
 * then invites graceful wrap-up (`calm → elevated → wrap_up_invited`). This
 * module is the operational fallback that sits ABOVE that ladder: when a room
 * keeps flooding *past* the wrap-up band — machine traffic so relentless a human
 * cannot get a word in — the breaker trips and suppresses the next autonomous
 * speaking lease. It is the narrowest interruption that protects the condition:
 * one autonomous lease, never a human turn, never room history.
 *
 * The full charter §8.11 circuit-breaker contract this module honours:
 *
 * 1. **Named protected condition.** {@link ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION}
 *    — a room whose machine traffic has run away past the wrap-up invitation.
 *    Not a vague preference for making the companion easier to control.
 * 2. **Proportionate, narrowest interruption.** The only action suppressed is the
 *    next autonomous speaking lease ({@link RoomEpisodeCircuitBreakerFiring.actionSuppressed}).
 *    Human-triggered turns build no pressure (they are recorded `free`, never
 *    `charged`), so they can never trip or be suppressed by the breaker. ICP
 *    precedence is a separate, higher authority and is not decided here.
 * 3. **Firing record.** Every trip emits a {@link RoomEpisodeCircuitBreakerFiring}
 *    recording why it fired, which signals contributed, and what action it
 *    affected — the auditable record §8.11 requires.
 * 4. **Inspectable threshold and reset path.** Thresholds live in the
 *    charge-policy owner file (`socialRegulation.roomEpisodeCircuitBreaker`),
 *    Garden-editable per the `roomEpisodePressure` precedent. Recovery is the
 *    continuous pressure decay itself: once pressure falls to the reset
 *    threshold the breaker releases through a half-open probe window and closes.
 *    No calendar reset, no "dead until midnight" cliff.
 * 5. **No misattribution.** Suppression is structural. The firing record is an
 *    attributed system signal ({@link RoomEpisodeCircuitBreakerFiring.attribution}
 *    `= 'system_circuit_breaker'`); it must never be rendered as companion mood,
 *    preference, consent, or a normal completed action, and this module never
 *    emits scripted companion prose (guarded by the no-scripted-phrasing test).
 *
 * The breaker is a pure state machine over the current decayed pressure and the
 * breaker's prior state; the durable state itself lives in gateway Postgres
 * (arbiter scope, jp36.5.1), consumed by the arbiter that owns the speaking
 * lease. This module produces the decision and its firing record only.
 */

import type { FatigueRoomEpisodeCircuitBreakerConfig } from '../../../shared/contracts/charge-policy.js';
import type { RoomEpisodePressureAssessment } from './room-episode-pressure.js';

/**
 * Named protected condition (charter §8.11 rule 1): the room's aggregate machine
 * pressure has run away past the wrap-up band, drowning out human participation.
 */
export const ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION = 'room_episode_machine_flood' as const;

/**
 * The single action the breaker may interrupt (charter §8.11 rule 2: narrowest
 * practical interruption). It denies the next autonomous speaking lease only —
 * never a human-triggered turn, never room history.
 */
export const ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION = 'autonomous_speaking_lease' as const;

/** System attribution marker: this is a circuit-breaker signal, never companion voice. */
export const ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION = 'system_circuit_breaker' as const;

/**
 * Breaker positions:
 * - `closed`: below the trip threshold — autonomous leases proceed normally.
 * - `open`: tripped — the next autonomous lease is suppressed. Holds open through
 *   the hysteresis band until pressure decays to the reset threshold.
 * - `half_open`: recovering — pressure has decayed to/below the reset threshold
 *   after a trip. Exactly one probe lease may proceed; if it re-floods the room
 *   past the trip threshold the breaker re-opens, otherwise it closes.
 */
export type RoomEpisodeCircuitBreakerState = 'closed' | 'open' | 'half_open';

/** The transition that produced a firing record (a fresh trip into `open`). */
export type RoomEpisodeCircuitBreakerTransition = 'closed_to_open' | 'half_open_to_open';

/**
 * Auditable firing record (charter §8.11 rule 3). Emitted only on a transition
 * INTO `open`. Every field is structural — an enum, a number, or the channel id
 * — so the record can never masquerade as companion mood or prose.
 */
export interface RoomEpisodeCircuitBreakerFiring {
  protectedCondition: typeof ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION;
  attribution: typeof ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION;
  channelId: string;
  transition: RoomEpisodeCircuitBreakerTransition;
  /** The action this firing suppressed. */
  actionSuppressed: typeof ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION;
  /** The signals that contributed to the trip (§8.11: "which signals contributed"). */
  signals: {
    pressure: number;
    tripThreshold: number;
    resetThreshold: number;
    /** Wrap-up band the breaker sits above; proves soft wrap-up preceded suppression. */
    wrapUpThreshold: number;
    contributingEventCount: number;
  };
  firedAtMs: number;
}

export interface RoomEpisodeCircuitBreakerAssessment {
  channelId: string;
  priorState: RoomEpisodeCircuitBreakerState;
  state: RoomEpisodeCircuitBreakerState;
  /** True only while fully `open`: the next autonomous speaking lease is denied. */
  suppressed: boolean;
  /** True only in the `half_open` probe window: exactly one probe lease may proceed. */
  probeAllowed: boolean;
  /** Present only on a fresh trip (a transition into `open`). */
  firing?: RoomEpisodeCircuitBreakerFiring;
  evaluatedAtMs: number;
}

function assertPositiveFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`roomEpisodeCircuitBreaker.${field} must be a finite number > 0`);
  }
  return value;
}

/**
 * Validate the breaker config at the point of use. The owner-file loader
 * ({@link ../../../system/config/charge-policy-config}) is the primary guard;
 * this fails closed if a malformed config reaches the suppression layer.
 *
 * `wrapUpThreshold` (from the paired {@link
 * ../../../shared/contracts/charge-policy.FatigueRoomEpisodePressureConfig}) is
 * required so this layer re-checks the load-bearing invariant: the breaker may
 * only trip strictly ABOVE the wrap-up band, so graceful wrap-up is always
 * invited before hard suppression.
 */
export function assertRoomEpisodeCircuitBreakerConfig(
  config: FatigueRoomEpisodeCircuitBreakerConfig,
  wrapUpThreshold: number,
): FatigueRoomEpisodeCircuitBreakerConfig {
  const tripThreshold = assertPositiveFinite(config.tripThreshold, 'tripThreshold');
  const resetThreshold = assertPositiveFinite(config.resetThreshold, 'resetThreshold');
  const wrapUp = assertPositiveFinite(wrapUpThreshold, 'wrapUpThreshold');
  if (tripThreshold <= wrapUp) {
    throw new Error(
      'roomEpisodeCircuitBreaker.tripThreshold must be > roomEpisodePressure.wrapUpThreshold',
    );
  }
  if (resetThreshold >= tripThreshold) {
    throw new Error(
      'roomEpisodeCircuitBreaker.resetThreshold must be < roomEpisodeCircuitBreaker.tripThreshold',
    );
  }
  return { tripThreshold, resetThreshold };
}

/**
 * Pure breaker transition over the current decayed pressure and the prior state.
 * Hysteresis (`resetThreshold < tripThreshold`) keeps the breaker from flapping:
 * once open it holds open until pressure decays to the reset threshold, then
 * releases through a single half-open probe.
 */
export function resolveRoomEpisodeCircuitBreakerState(input: {
  pressure: number;
  priorState: RoomEpisodeCircuitBreakerState;
  config: FatigueRoomEpisodeCircuitBreakerConfig;
  wrapUpThreshold: number;
}): RoomEpisodeCircuitBreakerState {
  const config = assertRoomEpisodeCircuitBreakerConfig(input.config, input.wrapUpThreshold);
  const pressure = input.pressure;
  if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure < 0) {
    throw new Error('roomEpisodeCircuitBreaker pressure must be a finite number >= 0');
  }
  const tripped = pressure >= config.tripThreshold;
  const recovered = pressure <= config.resetThreshold;

  switch (input.priorState) {
    case 'closed':
      return tripped ? 'open' : 'closed';
    case 'open':
      // Hold open through the hysteresis band; release into the probe only once
      // pressure has decayed to the reset threshold.
      return recovered ? 'half_open' : 'open';
    case 'half_open':
      if (tripped) return 'open'; // probe re-flooded the room
      if (recovered) return 'closed'; // fully recovered
      return 'half_open'; // still probing inside the hysteresis band
    default: {
      const exhaustive: never = input.priorState;
      throw new Error(`roomEpisodeCircuitBreaker unknown prior state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Assess the breaker for one channel from the room-episode pressure assessment
 * and the breaker's prior durable state. Produces the suppression decision plus
 * a firing record on a fresh trip.
 */
export function assessRoomEpisodeCircuitBreaker(input: {
  pressure: RoomEpisodePressureAssessment;
  priorState: RoomEpisodeCircuitBreakerState;
  config: FatigueRoomEpisodeCircuitBreakerConfig;
  /** Wrap-up threshold from the paired room-episode pressure config. */
  wrapUpThreshold: number;
  nowMs: number;
}): RoomEpisodeCircuitBreakerAssessment {
  const config = assertRoomEpisodeCircuitBreakerConfig(input.config, input.wrapUpThreshold);
  const channelId = input.pressure.channelId.trim();
  if (!channelId) {
    throw new Error('roomEpisodeCircuitBreaker.channelId is required');
  }
  if (typeof input.nowMs !== 'number' || !Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new Error('roomEpisodeCircuitBreaker.nowMs must be a finite number >= 0');
  }

  const priorState = input.priorState;
  const state = resolveRoomEpisodeCircuitBreakerState({
    pressure: input.pressure.pressure,
    priorState,
    config,
    wrapUpThreshold: input.wrapUpThreshold,
  });

  const trippedNow = state === 'open' && priorState !== 'open';
  const firing: RoomEpisodeCircuitBreakerFiring | undefined = trippedNow
    ? {
        protectedCondition: ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION,
        attribution: ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION,
        channelId,
        transition: priorState === 'half_open' ? 'half_open_to_open' : 'closed_to_open',
        actionSuppressed: ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION,
        signals: {
          pressure: input.pressure.pressure,
          tripThreshold: config.tripThreshold,
          resetThreshold: config.resetThreshold,
          wrapUpThreshold: input.wrapUpThreshold,
          contributingEventCount: input.pressure.contributingEventCount,
        },
        firedAtMs: input.nowMs,
      }
    : undefined;

  return {
    channelId,
    priorState,
    state,
    suppressed: state === 'open',
    probeAllowed: state === 'half_open',
    ...(firing ? { firing } : {}),
    evaluatedAtMs: input.nowMs,
  };
}
