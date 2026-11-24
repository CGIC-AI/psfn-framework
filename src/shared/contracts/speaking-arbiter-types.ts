// ── Speaking arbiter core contracts (psfn-framework-kbdvl.1) ──
//
// Core-owned speaking-arbiter event/precedence contract types shared by
// EventBus telemetry and ICP-over-social precedence transport without pulling
// the host `core/agent/arbiter/` implementation into core.

import type { IcpSocialPrecedenceInput } from '../../core/icp/social-precedence.js';

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
 * separate, dominant autonomy authority; where it contends, social yields.
 */
export interface IcpSocialPrecedenceResolver {
  resolve(ctx: ReservationSignalContext): IcpSocialPrecedenceInput | Promise<IcpSocialPrecedenceInput>;
}

/** Why a candidate was gated out before appraisal. */
export type ReservationGateBlockReason =
  | 'icp_turn_fenced'
  | 'icp_fatigue_exhausted'
  | 'icp_availability'
  | 'room_flooded'
  | 'fatigue_pot_insufficient'
  | 'gate_error';

/** The stage at which a `gate_error` occurred (content-free, for telemetry). */
export type ReservationGateErrorStage =
  | 'icp_precedence'
  | 'room_pressure'
  | 'social_pot'
  | 'reserve';

/** The lifecycle stage a fail-closed `gate_error` occurred at (content-free). */
export type EgressLeaseErrorStage =
  | 'trigger'
  | 'room_pressure'
  | 'breaker'
  | 'fairness'
  | 'social_pot'
  | 'acquire'
  | 'deliver'
  | 'complete';

/** The terminal outcome of an egress evaluation. */
export type EgressLeaseOutcome =
  | 'delivered'
  | 'delivery_failed'
  | 'shadowed'
  | 'reservation_not_reservable'
  | 'breaker_suppressed'
  | 'below_confidence_bar'
  | 'yielded_speak_least'
  | 'draw_refused'
  | 'lease_declined'
  | 'gate_error'
  | 'react_released';

export type AcquireEgressLeaseDeclineReason = 'held' | 'already_delivered';

/** Durable Law-36 circuit-breaker position for a channel's room episode. */
export type RoomEpisodeBreakerState = 'closed' | 'open' | 'half_open';
