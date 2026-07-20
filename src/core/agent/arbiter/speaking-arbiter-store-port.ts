/**
 * Gateway speaking-arbiter store contract (design bible §8.5, §12.2; adjudication
 * §3 R2). This module owns the *shape* of the arbiter's durable, gateway-owned
 * state — candidate reservations, exclusive egress leases, and per-channel room
 * episode/pressure — plus the deterministic, DB-free predicates over that state.
 *
 * The two-phase protocol it persists (bible §8.5): a **candidate reservation**
 * peeks before appraisal ("peek before the model runs"); a **final egress lease**
 * binds only at delivery ("bind only at egress"). Multiple companions may hold
 * reservations for one triggering room event, but the arbiter grants at most one
 * *speech-terminal* egress lease for that event — two companions never both send
 * for one trigger (§20.1). This is send-once-per-trigger, not merely
 * instantaneous exclusivity: once any lease for the event completes speech
 * (`delivered`/`overridden`), the event is spent and every later acquisition for
 * that same event is declined fail-closed. A crashed holder whose lease lapses
 * *without* delivering never sent, so its event remains acquirable (reclaim).
 *
 * Leases are fenced two ways so a crashed holder can neither block the room
 * forever nor double-speak (bible §8.5 crash-recovery fencing, §18 lease-expiry):
 *   - a wall-clock deadline (`expiresAtMs`) lets another turn reclaim a lease from
 *     a crashed holder — liveness; the room is never blocked forever;
 *   - a monotonically increasing per-event `fencingToken` means a revived crashed
 *     holder presenting a stale token is rejected at completion — safety; no
 *     double-send on restart.
 *
 * ## Crash-recovery correlation key (jp36.5.3)
 *
 * Autonomous non-ICP (room/social) initiations are placed in the SAME durable
 * recovery model as ICP's reservation fence (`IcpConversationCorrelation`). The
 * arbiter's recovery correlation is the fenced egress lease itself: `(channelId,
 * triggerEventId)` identifies the triggering room event, and the monotonic
 * per-event `fencingToken` identifies which attempt owns it. A crash between the
 * fatigue funding draw and delivery must neither double-send nor leak the charge
 * (review R2). Double-send is already fenced (send-once on speech-terminal +
 * stale-token rejection); the charge is bound here via {@link
 * SpeakingEgressLeaseSnapshot.chargedUnits} — the fatigue units drawn for this
 * lease, recorded on the lease at acquisition so the debit is part of the same
 * durable, fenced, correlation-keyed record instead of an untracked balance
 * decrement on the separate social-pot store. On a speech-terminal completion the
 * charge is permanent; on a reclaimed never-delivered lease it is the refundable
 * amount. The refund policy that consumes it is the egress-sender lane (qgqw.3).
 *
 * The Postgres implementation is the durable authority so a gateway reboot loses
 * nothing (adjudication §3 R2 #2: pressure, turns, leases survive reboot). Policy
 * — which candidate wins the lease (speak-least fairness), lease/reservation
 * durations, and how room pressure maps to `socialRegulation` units — is owned by
 * the arbiter service and the room-pressure feature; this store only persists the
 * state and enforces exclusivity, fencing, and atomicity.
 */

/** Reservation-phase lifecycle. Terminal states carry a {@link SpeakingArbiterReason}. */
export type SpeakingReservationStatus = 'reserved' | 'released' | 'expired';

/** Egress-lease lifecycle. `held` is the single live exclusive state per event. */
export type SpeakingEgressLeaseStatus =
  | 'held'
  | 'released'
  | 'expired'
  | 'delivered'
  | 'failed'
  | 'overridden';

/**
 * Why a reservation or lease reached its terminal state. Covers the four
 * non-send fairness outcomes (`ignore`, `model_failure`, `expiry`,
 * `delivery_failure`), the two send outcomes (`delivered`, `urgent_override`),
 * `silence` (a valid release — never retried into speech, bible §6.7), and
 * `superseded` (an earlier reservation displaced by a newer one).
 */
export type SpeakingArbiterReason =
  | 'silence'
  | 'ignore'
  | 'model_failure'
  | 'delivered'
  | 'delivery_failure'
  | 'expiry'
  | 'superseded'
  | 'urgent_override';

/** Terminal outcome the caller reports when finishing an egress lease. */
export type SpeakingEgressLeaseCompletion =
  | 'delivered'
  | 'failed'
  | 'released'
  | 'overridden';

/** Per-channel room-episode lifecycle. */
export type RoomEpisodeStatus = 'open' | 'closed';

/**
 * Durable Law-36 circuit-breaker position for a channel's room episode (charter
 * §8.11, bible §12.2/§20.2). Persisted in the arbiter store — the gateway-owned
 * home the design mandates — so the single-probe half-open discipline survives a
 * gateway reboot. Mirrors the pure breaker state machine's positions
 * (`../fatigue/room-episode-circuit-breaker`); kept as a local string union so
 * this low-level store contract does not depend on the fatigue module.
 */
export type RoomEpisodeBreakerState = 'closed' | 'open' | 'half_open';

export const SPEAKING_RESERVATION_STATUSES: readonly SpeakingReservationStatus[] = [
  'reserved',
  'released',
  'expired',
];

export const SPEAKING_EGRESS_LEASE_STATUSES: readonly SpeakingEgressLeaseStatus[] = [
  'held',
  'released',
  'expired',
  'delivered',
  'failed',
  'overridden',
];

export const SPEAKING_ARBITER_REASONS: readonly SpeakingArbiterReason[] = [
  'silence',
  'ignore',
  'model_failure',
  'delivered',
  'delivery_failure',
  'expiry',
  'superseded',
  'urgent_override',
];

export const SPEAKING_EGRESS_LEASE_COMPLETIONS: readonly SpeakingEgressLeaseCompletion[] = [
  'delivered',
  'failed',
  'released',
  'overridden',
];

/**
 * The completion outcomes that count as the companion having spoken into the
 * room — they increase episode pressure, the speaker's speak count, and the
 * consecutive-autonomous-turn streak. A `delivery_failure` never reached the
 * room, and a `released` (silence) is an affirmative non-utterance, so neither
 * charges pressure.
 */
export const SPEAKING_EGRESS_LEASE_SPEECH_COMPLETIONS: readonly SpeakingEgressLeaseCompletion[] = [
  'delivered',
  'overridden',
];

/** Map a terminal completion onto the durable reason recorded on both rows. */
export function speakingCompletionReason(
  completion: SpeakingEgressLeaseCompletion,
): SpeakingArbiterReason {
  switch (completion) {
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'delivery_failure';
    case 'released':
      return 'silence';
    case 'overridden':
      return 'urgent_override';
  }
}

/** True when a completion represents the companion speaking into the room. */
export function speakingCompletionIsSpeech(
  completion: SpeakingEgressLeaseCompletion,
): boolean {
  return SPEAKING_EGRESS_LEASE_SPEECH_COMPLETIONS.includes(completion);
}

/**
 * A held egress lease is *live* only while its deadline is in the future. Once
 * `nowMs >= expiresAtMs` the holder is presumed crashed/stalled and the lease is
 * reclaimable by another turn (bible §18 "lease expires during generation").
 */
export function isEgressLeaseLive(
  lease: { status: SpeakingEgressLeaseStatus; expiresAtMs: number },
  nowMs: number,
): boolean {
  return lease.status === 'held' && lease.expiresAtMs > nowMs;
}

/** A reservation is active while it is `reserved` and its TTL has not lapsed. */
export function isReservationActive(
  reservation: { status: SpeakingReservationStatus; expiresAtMs: number },
  nowMs: number,
): boolean {
  return reservation.status === 'reserved' && reservation.expiresAtMs > nowMs;
}

export interface RoomEpisodeParticipant {
  companionId: string;
  /** Egress leases this companion has delivered in the current episode. */
  speakCount: number;
  /** When the companion last spoke into the episode; null until first delivery. */
  lastSpokeAtMs: number | null;
}

export interface RoomEpisodeSnapshot {
  episodeId: string;
  channelId: string;
  status: RoomEpisodeStatus;
  /** Aggregate machine-participation pressure (bible §12.2). Non-monetary pacing. */
  pressure: number;
  openedAtMs: number;
  lastActivityAtMs: number;
  /** Machine turns since the last human activity; reset by human participation. */
  consecutiveAutonomousTurns: number;
  /** Companion that most recently delivered into the episode, or null. */
  lastSpeakerCompanionId: string | null;
  /** Monotonic write counter; every persisted change increments it. */
  revision: number;
  /**
   * Per-companion fairness stats, ordered least-recent participation first with a
   * stable `companionId` tie-break — the deterministic ordering that feeds
   * speak-least selection (bible §8.5 priority #4, §20.1).
   */
  participants: readonly RoomEpisodeParticipant[];
}

export interface SpeakingReservationSnapshot {
  reservationId: string;
  channelId: string;
  triggerEventId: string;
  companionId: string;
  episodeId: string;
  reservedAtMs: number;
  expiresAtMs: number;
  status: SpeakingReservationStatus;
  reason: SpeakingArbiterReason | null;
  finalizedAtMs: number | null;
  revision: number;
}

export interface SpeakingEgressLeaseSnapshot {
  leaseId: string;
  reservationId: string;
  channelId: string;
  triggerEventId: string;
  companionId: string;
  episodeId: string;
  /** Monotonically increasing per (channel, triggerEvent). Stale token => rejected. */
  fencingToken: number;
  /**
   * Fatigue units drawn from the social pot for this lease's turn, recorded at
   * acquisition (jp36.5.3). Binds the funding charge to this durable, fenced,
   * correlation-keyed record so a crash between draw and delivery does not leak
   * an untracked debit: a speech-terminal lease keeps it (permanent charge), a
   * reclaimed never-delivered lease carries it as the refundable amount. `0` when
   * no charge was bound (e.g. an uncharged/human-triggered turn). The refund
   * wiring that consumes it lives in the egress-sender lane (qgqw.3).
   */
  chargedUnits: number;
  acquiredAtMs: number;
  expiresAtMs: number;
  status: SpeakingEgressLeaseStatus;
  reason: SpeakingArbiterReason | null;
  finalizedAtMs: number | null;
  revision: number;
}

export interface EnsureRoomEpisodeInput {
  channelId: string;
  nowMs: number;
}

export interface ReadRoomEpisodeInput {
  channelId: string;
}

export interface CloseRoomEpisodeInput {
  channelId: string;
  nowMs: number;
}

export interface ReserveInput {
  /** Caller-generated UUID fence identity for this reservation attempt. */
  reservationId: string;
  channelId: string;
  /** The source room-event/message id that made this companion a candidate. */
  triggerEventId: string;
  companionId: string;
  nowMs: number;
  /** Reservation TTL deadline; a lapsed reservation is swept and cannot promote. */
  expiresAtMs: number;
}

export interface ReserveResult {
  /** `replayed` when a reservation already existed for (channel, event, companion). */
  outcome: 'reserved' | 'replayed';
  reservation: SpeakingReservationSnapshot;
  episode: RoomEpisodeSnapshot;
}

export interface ReleaseReservationInput {
  reservationId: string;
  channelId: string;
  reason: SpeakingArbiterReason;
  nowMs: number;
}

export interface AcquireEgressLeaseInput {
  /** Caller-generated UUID for the lease. Replaying a granted leaseId is idempotent. */
  leaseId: string;
  /** The `reserved` reservation being promoted to egress. */
  reservationId: string;
  channelId: string;
  nowMs: number;
  /** Lease deadline; a crashed holder's lease is reclaimable once it lapses. */
  expiresAtMs: number;
  /**
   * Fatigue units already drawn from the social pot for this turn (jp36.5.3),
   * recorded durably on the granted lease so the charge is fenced to the same
   * correlation-keyed record as the send. Defaults to 0; must be finite and >= 0.
   * On an idempotent replay of an already-granted lease the stored value is
   * authoritative — the first grant's charge wins.
   */
  chargedUnits?: number;
}

/**
 * Why an acquisition was declined:
 *   - `held`: a live held lease currently owns the triggering event;
 *   - `already_delivered`: the event was already spoken (a prior lease reached a
 *     `delivered`/`overridden` completion), so it is spent — send-once fencing.
 * In both cases the caller does NOT retry (silence is never retried into speech).
 */
export type AcquireEgressLeaseDeclineReason = 'held' | 'already_delivered';

export interface AcquireEgressLeaseResult {
  /**
   * `declined` when a live held lease already owns the triggering event, or when
   * the event was already spoken (`already_delivered`) — see {@link declineReason}.
   */
  outcome: 'acquired' | 'declined';
  /** Present on `acquired` (including idempotent replay). */
  lease: SpeakingEgressLeaseSnapshot | null;
  /**
   * On `declined`, the lease that won the event (for telemetry, no retry): the
   * live holder for a `held` decline, or the speech-terminal winner for an
   * `already_delivered` decline. Null on `acquired`.
   */
  heldBy: { companionId: string; leaseId: string; fencingToken: number } | null;
  /** Present only on `declined`: whether a live holder or a spent event blocked it. */
  declineReason?: AcquireEgressLeaseDeclineReason;
}

export interface CompleteEgressLeaseInput {
  leaseId: string;
  channelId: string;
  /** The token the caller was granted; a stale token is rejected fail-closed. */
  fencingToken: number;
  completion: SpeakingEgressLeaseCompletion;
  nowMs: number;
  /**
   * Pressure charged to the room episode on a speech completion (`delivered`/
   * `overridden`). Policy-owned by the caller; defaults to 0. Ignored for
   * non-speech completions. An urgent override still records its cost (§12.5).
   */
  pressureDelta?: number;
}

export interface ReadRoomEpisodeBreakerStateInput {
  channelId: string;
}

export interface PersistRoomEpisodeBreakerStateInput {
  channelId: string;
  state: RoomEpisodeBreakerState;
  nowMs: number;
}

export interface ListActiveReserversInput {
  channelId: string;
  /** The source room-event id whose contending reservers are wanted. */
  triggerEventId: string;
  nowMs: number;
}

export interface RecordHumanActivityInput {
  channelId: string;
  nowMs: number;
}

export interface SweepExpiredInput {
  /** When set, sweep only this channel; otherwise sweep every channel. */
  channelId?: string;
  nowMs: number;
}

export interface SweepExpiredResult {
  expiredReservations: number;
  expiredLeases: number;
}

/**
 * Durable, gateway-owned speaking-arbiter store. Lives in the shared Postgres
 * schema (never a companion-local store): a companion never arbitrates a peer's
 * turn (bible §13.1). Every mutation serializes on a per-channel advisory lock —
 * each channel is its own arbitration context (§8.5).
 */
export interface SpeakingArbiterStorePort {
  /** Return the channel's open episode, opening a fresh one if none is open. */
  ensureRoomEpisode(input: EnsureRoomEpisodeInput): Promise<RoomEpisodeSnapshot>;
  /** Read the channel's open episode with its participants, or null if none open. */
  readRoomEpisode(input: ReadRoomEpisodeInput): Promise<RoomEpisodeSnapshot | null>;
  /** Close the channel's open episode (quiet-time/wrap-up). No-op if none open. */
  closeRoomEpisode(input: CloseRoomEpisodeInput): Promise<RoomEpisodeSnapshot | null>;
  /** Phase 1: reserve a candidate slot before appraisal. Idempotent per event/companion. */
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /** Terminate a reservation without speaking (silence/ignore/model failure/etc.). */
  releaseReservation(input: ReleaseReservationInput): Promise<SpeakingReservationSnapshot>;
  /**
   * Read the durable Law-36 circuit-breaker position for the channel's open
   * episode. Returns `'closed'` when no episode is open (a room with no live
   * episode is not suppressed). Used as the breaker `priorState` at the egress
   * gate so the single-probe half-open discipline survives a reboot.
   */
  readRoomEpisodeBreakerState(input: ReadRoomEpisodeBreakerStateInput): Promise<RoomEpisodeBreakerState>;
  /**
   * Persist the durable Law-36 breaker position for the channel's open episode.
   * No-op when no episode is open. Called by the egress gate after it resolves
   * the breaker transition, so the next evaluation reads the advanced state (a
   * spent half-open probe is not re-granted).
   */
  persistRoomEpisodeBreakerState(input: PersistRoomEpisodeBreakerStateInput): Promise<void>;
  /**
   * List the companion ids that currently hold an active (`reserved`, unexpired)
   * candidate reservation for a triggering event. The deterministic contender set
   * the egress phase resolves speak-least fairness over (bible §8.5 priority #4):
   * the least-recent contender speaks; the rest yield. Ordered by `companionId`
   * for a stable result.
   */
  listActiveReservers(input: ListActiveReserversInput): Promise<string[]>;
  /** Phase 2: acquire the exclusive, fenced egress lease for the triggering event. */
  acquireEgressLease(input: AcquireEgressLeaseInput): Promise<AcquireEgressLeaseResult>;
  /** Finish an egress lease; a speech completion updates episode pressure and fairness. */
  completeEgressLease(input: CompleteEgressLeaseInput): Promise<SpeakingEgressLeaseSnapshot>;
  /** Record human room activity: resets the consecutive-autonomous-turn streak. */
  recordHumanActivity(input: RecordHumanActivityInput): Promise<RoomEpisodeSnapshot>;
  /** Reclaim lapsed reservations and leases (watchdog). Returns how many it expired. */
  sweepExpired(input: SweepExpiredInput): Promise<SweepExpiredResult>;
  close(): Promise<void>;
}
