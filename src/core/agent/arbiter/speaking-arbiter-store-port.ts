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
 * short-lived egress lease for that event — two companions never both send for
 * one trigger (§20.1).
 *
 * Leases are fenced two ways so a crashed holder can neither block the room
 * forever nor double-speak (bible §8.5 crash-recovery fencing, §18 lease-expiry):
 *   - a wall-clock deadline (`expiresAtMs`) lets another turn reclaim a lease from
 *     a crashed holder — liveness; the room is never blocked forever;
 *   - a monotonically increasing per-event `fencingToken` means a revived crashed
 *     holder presenting a stale token is rejected at completion — safety; no
 *     double-send on restart.
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
}

export interface AcquireEgressLeaseResult {
  /** `declined` when a live held lease already owns the triggering event. */
  outcome: 'acquired' | 'declined';
  /** Present on `acquired` (including idempotent replay). */
  lease: SpeakingEgressLeaseSnapshot | null;
  /** On `declined`, the live holder that won the event (for telemetry, no retry). */
  heldBy: { companionId: string; leaseId: string; fencingToken: number } | null;
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
