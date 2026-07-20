/**
 * Speaking-arbiter egress-lease phase: the exclusive send-once binding at
 * delivery (design bible §8.5/§12.2, §18, §20.1; adjudication §3 R2;
 * jp36.5.1.3). This is phase 2 of the two-phase arbiter protocol — it runs
 * AFTER the participation appraiser has returned `react`/`reply` and the
 * reservation phase (jp36.5.1.2) has RETAINED the candidate reservation.
 *
 * Where phase 1 "peeks before the model runs" (non-exclusive reservation, a
 * non-mutating funding peek), this phase "binds only at egress": it is the ONLY
 * place the social pot is actually drawn and the exclusive, fenced egress lease
 * is acquired, so at most one companion sends for one triggering room event
 * (§20.1 "two companions never both send for one trigger"). Silence is always a
 * valid release, never retried into speech (§6.7).
 *
 * ## Lifecycle for a retained `reply` reservation ({@link grantReply})
 *
 * The gates run in the settled order, each fail-closed (a failure only ever
 * suppresses, never invents, speech):
 *
 *   1. **Reservation-status guard.** A reservation that is no longer `reserved`
 *      (a duplicate redelivery of one source event that already settled to
 *      `ignore`/`superseded`/`expired`, jp36.5.1.2 handoff) never binds — no
 *      re-appraisal can promote a spent reservation to a second send.
 *   2. **Room-episode pressure + Law-36 breaker (single reconciled source).**
 *      The decayed room-episode pressure is read from the ONE ledger-derived
 *      source (the jp36.5.4 seam); the arbiter store's raw `pressure` scalar is a
 *      write-only projection and is NEVER read for gating (caller obligation
 *      jp36.5.1 #2). The durable breaker `priorState` is read from the store,
 *      the pure breaker machine resolves the transition, and the new state is
 *      persisted. The **single-probe half-open discipline** (obligation #1)
 *      admits a probe ONLY on the fresh `open → half_open` transition — a durable
 *      `half_open` (a probe already spent) suppresses; `probeAllowed` alone is
 *      insufficient because it is true on every `half_open` evaluation.
 *   3. **Lease-threshold bias.** Rising pressure raises the confidence bar for
 *      another autonomous lease (`leaseThresholdBias`, the soft wrap-up layer
 *      beneath the breaker): an appraisal below `minReplyConfidence + bias` is
 *      suppressed before any spend.
 *   4. **Speak-least fairness.** Over the deterministic contender set (the
 *      currently-reserved companions for this event) the least-recent participant
 *      wins; a companion that is not the winner yields (bible §8.5 priority #4,
 *      §20.1 "fairness deterministic under ties"). The store's per-event lease
 *      fence remains the hard single-send guarantee; fairness is the bias over it.
 *   5. **Social-pot draw (the REAL draw).** {@link enforceSocialPotDraw} on the
 *      `group_social` lane binds the fatigue cost. A refusal (`capped`/
 *      `insufficient`/`uncharged`) releases the reservation and does NOT send.
 *   6. **Acquire → send → complete.** The exclusive fenced lease is acquired; a
 *      decline (a live holder or a spent event) does NOT retry. The injected
 *      sender consumes the lease and reports delivery; the lease is completed
 *      with the delivery outcome and a pressure projection consistent with the
 *      single source.
 *
 * A retained `react` reservation ({@link releaseReact}) does NOT take a speaking
 * lease — reactions are first-class and low-cost (§8.3), several companions may
 * react to one event, so a reaction must never spend the per-event send-once
 * fence. This phase gives it its explicit release path (jp36.5.1.2 handoff); the
 * reaction's own delivery and its near-zero pressure ride the §8.3 reaction path,
 * out of band of the speaking lease.
 */

import { randomUUID } from 'node:crypto';

import type {
  FatigueRoomEpisodeCircuitBreakerConfig,
  FatigueSocialPotConfig,
} from '../../../shared/contracts/charge-policy.js';
import type { ParticipationAppraisal } from '../../participation/types.js';
import {
  assessRoomEpisodeCircuitBreaker,
  type RoomEpisodeCircuitBreakerFiring,
} from '../fatigue/room-episode-circuit-breaker.js';
import type { RoomEpisodePressureAssessment } from '../fatigue/room-episode-pressure.js';
import {
  enforceSocialPotDraw,
  type SocialPotEnforcementOutcome,
} from '../fatigue/social-pot-enforcement.js';
import type { SocialPotPort } from '../fatigue/social-pot.js';
import type {
  AcquireEgressLeaseDeclineReason,
  RoomEpisodeBreakerState,
  RoomEpisodeParticipant,
  SpeakingArbiterStorePort,
  SpeakingEgressLeaseSnapshot,
  SpeakingReservationSnapshot,
} from './speaking-arbiter-store-port.js';

/** The deterministic context an egress evaluation resolves its signals from. */
export interface EgressLeaseSignalContext {
  channelId: string;
  triggerEventId: string;
  companionId: string;
  nowMs: number;
}

/**
 * Resolves the reconciled, decayed room-episode pressure assessment for a
 * channel (the single ledger-derived source owned by the jp36.5.4 seam). The
 * arbiter store's raw `pressure` scalar is never used for gating — this resolver
 * is the ONE authoritative source (caller obligation jp36.5.1 #2).
 */
export interface RoomEpisodePressureAssessmentResolver {
  resolve(
    ctx: EgressLeaseSignalContext,
  ): RoomEpisodePressureAssessment | Promise<RoomEpisodePressureAssessment>;
}

/**
 * The triggering room message a reply is generated against. A minimal data shape
 * (no runtime imports) the phase forwards opaquely to the sender; the concrete
 * sender maps it onto the runtime's message/response path. Untrusted room text —
 * the sender is responsible for routing it through the normal gated response
 * path (bible §8.2 "a reply still routes through the full normal response path
 * and its egress gates"), never a bespoke ungated generation.
 */
export interface EgressReplyTrigger {
  channelId: string;
  /** The platform channel type (e.g. `discord`); kept as a string to avoid a runtime import. */
  channelType: string;
  sourceMessageId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestampMs: number;
}

/** The delivery outcome the injected sender reports back. */
export type EgressReplyDeliveryOutcome = 'delivered' | 'failed';

export interface EgressReplyDeliveryRequest {
  reservation: SpeakingReservationSnapshot;
  /** The exclusive fenced lease this send owns. */
  lease: SpeakingEgressLeaseSnapshot;
  appraisal: Extract<ParticipationAppraisal, { action: 'reply' }>;
  /** The triggering room message this reply answers. */
  trigger: EgressReplyTrigger;
  nowMs: number;
}

export interface EgressReplyDeliveryResult {
  outcome: EgressReplyDeliveryOutcome;
  /** Content-free detail for telemetry (e.g. an error class), never room text. */
  detail?: string;
}

/**
 * Consumes a granted egress lease to actually produce and deliver the room
 * reply, returning the delivery outcome. Injected so the arbiter phase owns the
 * lease lifecycle while the concrete generation/delivery (and its idempotency —
 * the outbound reply guard) is wired at the runtime seam.
 */
export interface EgressReplySender {
  deliver(request: EgressReplyDeliveryRequest): Promise<EgressReplyDeliveryResult>;
}

/** The lifecycle stage a fail-closed `gate_error` occurred at (content-free). */
export type EgressLeaseErrorStage =
  | 'room_pressure'
  | 'breaker'
  | 'fairness'
  | 'social_pot'
  | 'acquire'
  | 'deliver'
  | 'complete';

/** The terminal outcome of an egress evaluation. */
export type EgressLeaseOutcome =
  /** The reply was delivered and its lease completed `delivered`. */
  | 'delivered'
  /** The lease was acquired but the send failed; lease completed `failed`. */
  | 'delivery_failed'
  /** The reservation was no longer `reserved` (redelivery/settled); no bind. */
  | 'reservation_not_reservable'
  /** The Law-36 breaker suppressed the autonomous lease (open / spent probe). */
  | 'breaker_suppressed'
  /** Pressure raised the confidence bar above the appraisal (soft wrap-up). */
  | 'below_confidence_bar'
  /** A less-recent contender should speak; this companion yielded (speak-least). */
  | 'yielded_speak_least'
  /** The social pot refused to fund the turn (capped/insufficient/uncharged). */
  | 'draw_refused'
  /** Acquire declined: a live holder, or the event was already spoken. No retry. */
  | 'lease_declined'
  /** Fail-closed: a gate signal, resolver, or store errored. No send. */
  | 'gate_error'
  /** A retained `react` reservation was released (no speaking lease). */
  | 'react_released';

export interface EgressLeaseDecision {
  outcome: EgressLeaseOutcome;
  channelId: string;
  triggerEventId: string;
  companionId: string;
  /** Present once the lease was acquired (`delivered`/`delivery_failed`). */
  lease?: SpeakingEgressLeaseSnapshot;
  /** The resolved durable breaker position at this evaluation. */
  breakerState?: RoomEpisodeBreakerState;
  /**
   * Structural firing record on a FRESH breaker trip (a transition into `open`).
   * An attributed system signal — never rendered as companion mood or voice.
   */
  breakerFiring?: RoomEpisodeCircuitBreakerFiring;
  /** On `yielded_speak_least`: the contender that should speak instead. */
  speakLeastWinner?: string;
  /** On `draw_refused`: how the pot refused funding. */
  drawOutcome?: SocialPotEnforcementOutcome;
  /** On `lease_declined`: whether a live holder or a spent event blocked it. */
  declineReason?: AcquireEgressLeaseDeclineReason;
  /** On `gate_error`: the lifecycle stage that failed. */
  errorStage?: EgressLeaseErrorStage;
  /** Content-free delivery detail from the sender. */
  deliveryDetail?: string;
}

export interface EgressLeasePhaseConfig {
  /** Egress lease deadline window; a crashed holder's lease is reclaimable after it. */
  leaseTtlMs: number;
  /**
   * The REAL social-pot draw amount bound at egress (charge-policy units). This
   * is where fatigue is actually spent (§8.5 "bind only at egress").
   */
  egressDrawUnits: number;
  /**
   * Base confidence a `reply` appraisal must clear to bind a lease. Rising
   * room-episode pressure adds `leaseThresholdBias` on top of this bar.
   */
  minReplyConfidence: number;
  /** Social-pot economy config (charge-policy `fatigue.socialPot`). */
  socialPot: FatigueSocialPotConfig;
  /** Law-36 breaker config; the durable single-probe gate uses its thresholds. */
  roomEpisodeCircuitBreaker: FatigueRoomEpisodeCircuitBreakerConfig;
  /**
   * Wrap-up threshold from the paired room-episode pressure config, so the
   * breaker invariant (trip > wrap-up) is re-checked at the point of use.
   */
  wrapUpThreshold: number;
  /**
   * Pressure charged to the episode on a delivered reply — the persisted
   * projection of the ledger figure onto the store's write-only scalar (caller
   * obligation jp36.5.1 #2: reconcile to ONE source). Typically the pressure
   * config's `replyPressureUnits`.
   */
  replyPressureUnits: number;
}

type EgressStore = Pick<
  SpeakingArbiterStorePort,
  | 'readRoomEpisode'
  | 'readRoomEpisodeBreakerState'
  | 'persistRoomEpisodeBreakerState'
  | 'listActiveReservers'
  | 'acquireEgressLease'
  | 'completeEgressLease'
  | 'releaseReservation'
>;

export interface EgressLeasePhaseDeps {
  store: EgressStore;
  socialPot: Pick<SocialPotPort, 'draw'>;
  /** The single reconciled room-episode pressure source (jp36.5.4 seam). */
  roomPressure: RoomEpisodePressureAssessmentResolver;
  /** Consumes a granted lease to produce and deliver the reply. */
  sender: EgressReplySender;
  /** The local companion this phase binds leases for. */
  companionId: string;
  config: EgressLeasePhaseConfig;
  /** UUID factory for lease ids; overridable for deterministic tests. */
  generateLeaseId?: () => string;
}

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`egressLeasePhase.${field} must be a non-empty string`);
  }
  return value;
}

function assertFiniteTimestamp(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`egressLeasePhase.${field} must be a finite number >= 0`);
  }
  return value;
}

function assertPositiveFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`egressLeasePhase.${field} must be a finite number > 0`);
  }
  return value;
}

function assertNonNegativeFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`egressLeasePhase.${field} must be a finite number >= 0`);
  }
  return value;
}

/**
 * A reservation may be concurrently retired between our read and our release —
 * a peer delivered and superseded it, or it TTL-expired. The store's
 * `releaseReservation` rejects an already-terminal row whose reason differs;
 * that is a benign idempotency race (the reservation is finalized either way, and
 * silence stands), NOT a lost update, so it is tolerated. Anything else rethrows.
 */
function isBenignReservationTerminalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already terminal|not found/.test(message);
}

/**
 * Deterministic speak-least selection (bible §8.5 priority #4, §20.1). Among the
 * contender set, the least-recent participant wins with a stable tie-break:
 * never-spoken contenders (no stat / null `lastSpokeAtMs`) rank first, then
 * least-recent, then lowest speak count, then a stable `companionId` order.
 * Pure — the same inputs always yield the same winner. Returns null only for an
 * empty contender set.
 */
export function selectSpeakLeastWinner(
  participants: readonly RoomEpisodeParticipant[],
  contenders: readonly string[],
): string | null {
  const unique = Array.from(new Set(contenders)).filter((id) => id.length > 0);
  if (unique.length === 0) {
    return null;
  }
  const statOf = (companionId: string): RoomEpisodeParticipant =>
    participants.find((participant) => participant.companionId === companionId) ?? {
      companionId,
      speakCount: 0,
      lastSpokeAtMs: null,
    };
  return unique
    .slice()
    .sort((a, b) => {
      const statA = statOf(a);
      const statB = statOf(b);
      // Never-spoken (null) first; then least-recent; then lowest speak count.
      const lastA = statA.lastSpokeAtMs;
      const lastB = statB.lastSpokeAtMs;
      if (lastA !== lastB) {
        if (lastA === null) return -1;
        if (lastB === null) return 1;
        return lastA - lastB;
      }
      if (statA.speakCount !== statB.speakCount) {
        return statA.speakCount - statB.speakCount;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    })[0];
}

/**
 * The deterministic egress-lease phase (arbiter phase 2). Construct once per
 * local companion with its store, social-pot port, pressure resolver, and reply
 * sender; call {@link grantReply} for a retained `reply` reservation and
 * {@link releaseReact} for a retained `react` reservation.
 */
export class SpeakingEgressLeasePhase {
  private readonly store: EgressStore;
  private readonly socialPot: Pick<SocialPotPort, 'draw'>;
  private readonly roomPressure: RoomEpisodePressureAssessmentResolver;
  private readonly sender: EgressReplySender;
  private readonly companionId: string;
  private readonly config: EgressLeasePhaseConfig;
  private readonly generateLeaseId: () => string;

  constructor(deps: EgressLeasePhaseDeps) {
    this.store = deps.store;
    this.socialPot = deps.socialPot;
    this.roomPressure = deps.roomPressure;
    this.sender = deps.sender;
    this.companionId = assertNonEmpty(deps.companionId, 'companionId');
    this.config = {
      leaseTtlMs: assertPositiveFinite(deps.config.leaseTtlMs, 'leaseTtlMs'),
      egressDrawUnits: assertPositiveFinite(deps.config.egressDrawUnits, 'egressDrawUnits'),
      minReplyConfidence: assertNonNegativeFinite(
        deps.config.minReplyConfidence,
        'minReplyConfidence',
      ),
      socialPot: deps.config.socialPot,
      roomEpisodeCircuitBreaker: deps.config.roomEpisodeCircuitBreaker,
      wrapUpThreshold: deps.config.wrapUpThreshold,
      replyPressureUnits: assertNonNegativeFinite(
        deps.config.replyPressureUnits,
        'replyPressureUnits',
      ),
    };
    this.generateLeaseId = deps.generateLeaseId ?? randomUUID;
  }

  /**
   * Bind (or fail-closed decline) the exclusive egress lease for a retained
   * `reply` reservation, then deliver and complete it. Never throws: every
   * failure fails closed to a structural decision, and no path sends without a
   * held lease. See the module doc for the settled gate order.
   */
  async grantReply(
    reservation: SpeakingReservationSnapshot,
    appraisal: Extract<ParticipationAppraisal, { action: 'reply' }>,
    trigger: EgressReplyTrigger,
    nowMs: number,
  ): Promise<EgressLeaseDecision> {
    const channelId = reservation.channelId;
    const triggerEventId = reservation.triggerEventId;
    const base = { channelId, triggerEventId, companionId: this.companionId };
    let now: number;
    try {
      now = assertFiniteTimestamp(nowMs, 'nowMs');
      assertNonEmpty(channelId, 'channelId');
      assertNonEmpty(triggerEventId, 'triggerEventId');
    } catch {
      return { ...base, outcome: 'gate_error', errorStage: 'room_pressure' };
    }

    // 1. Reservation-status guard (jp36.5.1.2 handoff): a settled/expired
    //    reservation (a duplicate redelivery of an already-appraised event)
    //    never binds a second send.
    if (reservation.status !== 'reserved') {
      return { ...base, outcome: 'reservation_not_reservable' };
    }

    const signalCtx: EgressLeaseSignalContext = {
      channelId,
      triggerEventId,
      companionId: this.companionId,
      nowMs: now,
    };

    // 2. Room-episode pressure (single reconciled source) + Law-36 breaker.
    let pressure: RoomEpisodePressureAssessment;
    try {
      pressure = await this.roomPressure.resolve(signalCtx);
      assertNonNegativeFinite(pressure.pressure, 'pressure');
    } catch {
      return { ...base, outcome: 'gate_error', errorStage: 'room_pressure' };
    }

    let breakerState: RoomEpisodeBreakerState;
    let priorState: RoomEpisodeBreakerState;
    let breakerFiring: RoomEpisodeCircuitBreakerFiring | undefined;
    try {
      priorState = await this.store.readRoomEpisodeBreakerState({ channelId });
      const assessment = assessRoomEpisodeCircuitBreaker({
        pressure,
        priorState,
        config: this.config.roomEpisodeCircuitBreaker,
        wrapUpThreshold: this.config.wrapUpThreshold,
        nowMs: now,
      });
      breakerState = assessment.state;
      breakerFiring = assessment.firing;
      // Persist the advanced position so the NEXT evaluation reads it — this is
      // what makes the single-probe discipline durable: a spent half-open probe
      // is not re-granted after this write.
      await this.store.persistRoomEpisodeBreakerState({ channelId, state: breakerState, nowMs: now });
    } catch {
      return { ...base, outcome: 'gate_error', errorStage: 'breaker' };
    }

    // Single-probe half-open gate (caller obligation #1): admit ONLY when the
    // breaker is closed, or on the FRESH open→half_open transition (one probe).
    // A durable half_open (priorState already half_open) means the probe was
    // already spent — suppress. `probeAllowed` alone is insufficient here.
    const breakerAdmits =
      breakerState === 'closed' || (priorState === 'open' && breakerState === 'half_open');
    if (!breakerAdmits) {
      await this.releaseSilently(reservation, now);
      return {
        ...base,
        outcome: 'breaker_suppressed',
        breakerState,
        ...(breakerFiring ? { breakerFiring } : {}),
      };
    }

    // 3. Lease-threshold bias: rising pressure raises the confidence bar for
    //    another autonomous lease (soft wrap-up beneath the breaker).
    const confidenceBar = this.config.minReplyConfidence + pressure.leaseThresholdBias;
    if (appraisal.confidence < confidenceBar) {
      await this.releaseSilently(reservation, now);
      return { ...base, outcome: 'below_confidence_bar', breakerState };
    }

    // 4. Speak-least fairness over the deterministic contender set. The store's
    //    per-event lease fence is the hard single-send guarantee; this biases
    //    WHO speaks so the least-recent participant wins, not the fastest.
    let winner: string | null;
    try {
      const [reservers, episode] = await Promise.all([
        this.store.listActiveReservers({ channelId, triggerEventId, nowMs: now }),
        this.store.readRoomEpisode({ channelId }),
      ]);
      const contenders = reservers.includes(this.companionId)
        ? reservers
        : [...reservers, this.companionId];
      winner = selectSpeakLeastWinner(episode?.participants ?? [], contenders);
    } catch {
      return { ...base, outcome: 'gate_error', errorStage: 'fairness' };
    }
    if (winner !== null && winner !== this.companionId) {
      await this.releaseSilently(reservation, now);
      return { ...base, outcome: 'yielded_speak_least', breakerState, speakLeastWinner: winner };
    }

    // 5. Social-pot draw — the REAL draw binds here (§8.5). A refusal releases
    //    the reservation and does NOT send.
    let drawOutcome: SocialPotEnforcementOutcome;
    let drawnUnits = 0;
    try {
      const decision = await enforceSocialPotDraw(this.socialPot, this.config.socialPot, {
        companionId: this.companionId,
        lane: 'group_social',
        triggerAuthorKind: 'machine_intelligence',
        amount: this.config.egressDrawUnits,
        nowMs: now,
      });
      drawOutcome = decision.outcome;
      drawnUnits = decision.drawn;
    } catch {
      return { ...base, outcome: 'gate_error', errorStage: 'social_pot' };
    }
    if (drawOutcome !== 'drawn') {
      await this.releaseSilently(reservation, now);
      return { ...base, outcome: 'draw_refused', breakerState, drawOutcome };
    }

    // 6. Acquire the exclusive fenced lease. A decline (live holder or spent
    //    event) does NOT retry into speech. The units just drawn are recorded on
    //    the lease so the charge is fenced to the same durable, correlation-keyed
    //    record as the send — a crash between here and delivery leaves the debit
    //    reconcilable off the lease rather than leaked (jp36.5.3).
    let lease: SpeakingEgressLeaseSnapshot;
    try {
      const acquired = await this.store.acquireEgressLease({
        leaseId: this.generateLeaseId(),
        reservationId: reservation.reservationId,
        channelId,
        nowMs: now,
        expiresAtMs: now + this.config.leaseTtlMs,
        chargedUnits: drawnUnits,
      });
      if (acquired.outcome === 'declined' || acquired.lease === null) {
        // For an `already_delivered` decline the store already superseded our
        // reservation; a `held` decline leaves it reserved, so release it to a
        // clean silence. Either way: no send, no retry.
        await this.releaseSilently(reservation, now);
        return {
          ...base,
          outcome: 'lease_declined',
          breakerState,
          ...(acquired.declineReason ? { declineReason: acquired.declineReason } : {}),
        };
      }
      lease = acquired.lease;
    } catch {
      // The reservation was concurrently retired (superseded/expired) between the
      // guard and acquire, or the store errored: fail closed, no send.
      return { ...base, outcome: 'gate_error', errorStage: 'acquire' };
    }

    // 7. Consume the lease: deliver, then complete with the delivery outcome and
    //    the pressure projection (single source). A sender failure completes the
    //    lease `failed` (no pressure charged) so the lease never wedges the room.
    let delivery: EgressReplyDeliveryResult;
    try {
      delivery = await this.sender.deliver({ reservation, lease, appraisal, trigger, nowMs: now });
    } catch (deliverError) {
      const detail = deliverError instanceof Error ? deliverError.name : 'sender_error';
      await this.completeLease(lease, 'failed', now);
      return { ...base, outcome: 'delivery_failed', lease, breakerState, deliveryDetail: detail };
    }

    const completion = delivery.outcome === 'delivered' ? 'delivered' : 'failed';
    try {
      await this.completeLease(lease, completion, now);
    } catch {
      // The send may have already happened but its completion did not persist.
      // Surface it structurally (never swallow): the held lease is TTL-swept, and
      // the sender's own outbound-reply guard suppresses a duplicate on re-drive.
      return { ...base, outcome: 'gate_error', errorStage: 'complete', lease, breakerState };
    }
    return {
      ...base,
      outcome: completion === 'delivered' ? 'delivered' : 'delivery_failed',
      lease,
      breakerState,
      ...(delivery.detail ? { deliveryDetail: delivery.detail } : {}),
    };
  }

  /**
   * Give a retained `react` reservation its explicit release path (jp36.5.1.2
   * handoff). A reaction never takes the exclusive speaking lease — several
   * companions may react to one event — so the reservation is released as an
   * affirmative non-utterance (§6.7). The reaction's own delivery and its
   * near-zero pressure ride the §8.3 reaction path, out of band of this lease.
   * Never throws; a benign concurrent-terminal race is tolerated.
   */
  async releaseReact(
    reservation: SpeakingReservationSnapshot,
    nowMs: number,
  ): Promise<EgressLeaseDecision> {
    const base = {
      channelId: reservation.channelId,
      triggerEventId: reservation.triggerEventId,
      companionId: this.companionId,
    };
    let now: number;
    try {
      now = assertFiniteTimestamp(nowMs, 'nowMs');
    } catch {
      return { ...base, outcome: 'gate_error', errorStage: 'complete' };
    }
    if (reservation.status !== 'reserved') {
      return { ...base, outcome: 'reservation_not_reservable' };
    }
    await this.releaseSilently(reservation, now);
    return { ...base, outcome: 'react_released' };
  }

  private async completeLease(
    lease: SpeakingEgressLeaseSnapshot,
    completion: 'delivered' | 'failed',
    nowMs: number,
  ): Promise<void> {
    await this.store.completeEgressLease({
      leaseId: lease.leaseId,
      channelId: lease.channelId,
      fencingToken: lease.fencingToken,
      completion,
      nowMs,
      // Ignored by the store for a non-speech completion; the projection of the
      // ledger reply figure onto the store's write-only scalar on delivery.
      pressureDelta: this.config.replyPressureUnits,
    });
  }

  private async releaseSilently(
    reservation: SpeakingReservationSnapshot,
    nowMs: number,
  ): Promise<void> {
    try {
      await this.store.releaseReservation({
        reservationId: reservation.reservationId,
        channelId: reservation.channelId,
        reason: 'silence',
        nowMs,
      });
    } catch (error) {
      if (!isBenignReservationTerminalError(error)) {
        throw error;
      }
    }
  }
}
