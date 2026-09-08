import type { ParticipationSuppressionReason } from './types.js';
import type { RoomParticipationLeaseSettings } from '../../system/config/participation-config.js';

/**
 * Bounded durable room-participation lease (jp36.5.5, bible §8.1/§8.5).
 *
 * The lease is a *membership* record: one companion, one verified group room,
 * bounded in time and message count. It grants nothing but **consideration** —
 * while it is active, an ordinary room message that never repeats the
 * companion's name may still become a `contextual_continuation` participation
 * candidate and reach the existing cheap appraiser. It is deliberately distinct
 * from the two speaking-arbiter leases: the reservation permits appraisal of one
 * trigger and the egress lease permits one send, while this lease only decides
 * whether a trigger exists at all. Nothing here bypasses the arbiter, CogSec,
 * fatigue, or the social pot: an admitted continuation enters exactly the same
 * reservation → appraisal → egress path a passive-name summons does.
 *
 * Everything on this contract is content-free (ids, counters, timestamps, and
 * bounded reason codes). Room text never enters the durable lease.
 *
 * ## The context watermark
 *
 * Each lease carries `(watermarkTimestampMs, watermarkMessageId)`: the newest
 * room message it has already considered. Admission is strictly forward-only
 * against that watermark and the advance is an atomic durable claim, so one
 * physical message can produce at most one continuation candidate even across a
 * restart, a redelivery, or two racing processes. A restart therefore resumes
 * the conversation without replaying old chatter into speech (acceptance #4).
 */

/**
 * The dispositions that may open (or refresh) a lease. Every one of them is an
 * explicit social act by the companion or toward it; ambient chatter is never
 * one. Which of these may OPEN a lease is owner policy
 * (`socialAutonomy.roomParticipationLease.openOn`); any of them refreshes a
 * lease that is already active.
 */
export type RoomParticipationDisposition =
  | 'direct_summons'
  | 'passive_summons'
  | 'reaction'
  | 'reply'
  | 'endogenous_room_entry';

/**
 * Why a lease stopped granting consideration. Terminal and durable: a closed
 * lease is never resumed, only replaced by a new admitted disposition.
 *
 * - `expiry`         — the bounded lifetime elapsed.
 * - `silence`        — nothing considered for the configured silence window.
 * - `message_cap`    — the bounded per-lease continuation budget is spent.
 * - `machine_streak` — consecutive machine-authored continuations hit the
 *                      bot-loop fence; only a human turn may re-open the room.
 * - `withdrawn`      — the companion chose `ignore` often enough in a row that
 *                      the running conversation is treated as declined.
 * - `fatigue`        — the reservation gate reported an unfundable social pot.
 * - `room_pressure`  — the reservation gate reported a flooded room.
 * - `policy_off`     — owner policy disabled continuation while a lease was live.
 */
export type RoomParticipationLeaseCloseReason =
  | 'expiry'
  | 'silence'
  | 'message_cap'
  | 'machine_streak'
  | 'withdrawn'
  | 'fatigue'
  | 'room_pressure'
  | 'policy_off';

export type RoomParticipationLeaseStatus = 'active' | 'closed';

export interface RoomParticipationLeaseSnapshot {
  companionId: string;
  channelId: string;
  status: RoomParticipationLeaseStatus;
  /** The disposition that opened this lease (never a continuation). */
  openedDisposition: RoomParticipationDisposition;
  openedAtMs: number;
  /** Last admitted consideration or refresh; the silence window runs from here. */
  lastActivityAtMs: number;
  expiresAtMs: number;
  /** Newest already-considered room message; admission is forward-only from it. */
  watermarkMessageId: string;
  watermarkTimestampMs: number;
  /** Continuation candidates admitted under this lease (the message cap). */
  consideredCount: number;
  /** Consecutive `ignore` appraisals; reset by a `react`/`reply`. */
  ignoreStreak: number;
  /** Consecutive machine-authored admitted continuations; reset by a human one. */
  machineStreak: number;
  closedAtMs: number | null;
  closeReason: RoomParticipationLeaseCloseReason | null;
  revision: number;
}

/**
 * The content-free facts the deterministic gate needs about one observed room
 * message. Deliberately not a `SubstrateMessage`: jp36.5.6's channel-neutral
 * room observation can populate exactly this shape from any connector, and no
 * room text reaches the gate or the durable lease.
 */
export interface RoomParticipationObservation {
  messageId: string;
  timestampMs: number;
  /** Bot/companion author (Discord `author.bot`), the bot-loop fence input. */
  authorIsMachine: boolean;
  /** Length only — never the content itself. */
  contentLength: number;
}

/**
 * Deterministic continuation decision. `close` additionally names the durable
 * close reason, so a lease that ran out of time, budget, or patience is retired
 * on the very observation that discovered it.
 */
export type RoomParticipationContinuationDecision =
  | { outcome: 'admit' }
  | { outcome: 'absent' }
  | { outcome: 'suppressed'; suppression: ParticipationSuppressionReason }
  | {
    outcome: 'close';
    reason: RoomParticipationLeaseCloseReason;
    suppression: ParticipationSuppressionReason;
  };

/**
 * The deterministic, DB-free, model-free continuation gate. Runs on every
 * observed room message that carried no name match, BEFORE any model call:
 * an ineligible message costs one lease read and nothing else, and a room with
 * no lease costs a single `absent` decision (acceptance #2).
 *
 * Ordering is deliberate: policy, then lease existence, then the terminal
 * bounds (expiry / silence / caps), then the forward-only watermark, then the
 * cheap rate and relevance hints. Terminal bounds are checked before the
 * watermark so a lapsed lease is closed rather than silently re-suppressed.
 */
export function evaluateRoomParticipationContinuation(input: {
  lease: RoomParticipationLeaseSnapshot | null;
  observation: RoomParticipationObservation;
  settings: RoomParticipationLeaseSettings;
  nowMs: number;
}): RoomParticipationContinuationDecision {
  const { lease, observation, settings, nowMs } = input;
  if (!lease || lease.status !== 'active') {
    // No membership: ambient chatter stays observation/context only.
    return { outcome: 'absent' };
  }
  if (!settings.enabled) {
    return {
      outcome: 'close',
      reason: 'policy_off',
      suppression: 'lease_policy_off',
    };
  }
  if (nowMs >= lease.expiresAtMs) {
    return { outcome: 'close', reason: 'expiry', suppression: 'lease_expired' };
  }
  if (nowMs - lease.lastActivityAtMs >= settings.silenceTimeoutMs) {
    return { outcome: 'close', reason: 'silence', suppression: 'lease_silent' };
  }
  if (lease.consideredCount >= settings.maxContinuationCandidates) {
    return { outcome: 'close', reason: 'message_cap', suppression: 'lease_message_cap' };
  }
  if (
    observation.authorIsMachine
    && lease.machineStreak >= settings.maxConsecutiveMachineContinuations
  ) {
    // Bot-loop fence: only a human turn re-opens the room for this companion.
    return {
      outcome: 'close',
      reason: 'machine_streak',
      suppression: 'lease_machine_streak',
    };
  }
  if (!isAfterWatermark(observation, lease)) {
    return { outcome: 'suppressed', suppression: 'lease_watermark' };
  }
  // Spacing is measured on the observation clock, not the message's own
  // timestamp: a late or clock-skewed delivery must not read as "too soon"
  // (ordering is already the watermark's job).
  if (nowMs - lease.lastActivityAtMs < settings.continuationCooldownMs) {
    return { outcome: 'suppressed', suppression: 'lease_cooldown' };
  }
  if (observation.contentLength < settings.minContentChars) {
    // Bounded relevance hint: a bare reaction-length line is not a follow-up.
    return { outcome: 'suppressed', suppression: 'lease_low_signal' };
  }
  return { outcome: 'admit' };
}

/**
 * Strict forward-only ordering against the context watermark. Timestamp first,
 * message id as the stable tie-break, so two messages sharing a millisecond
 * still order deterministically and neither can be considered twice.
 */
function isAfterWatermark(
  observation: Pick<RoomParticipationObservation, 'messageId' | 'timestampMs'>,
  watermark: Pick<
    RoomParticipationLeaseSnapshot,
    'watermarkMessageId' | 'watermarkTimestampMs'
  >,
): boolean {
  if (observation.timestampMs !== watermark.watermarkTimestampMs) {
    return observation.timestampMs > watermark.watermarkTimestampMs;
  }
  return observation.messageId > watermark.watermarkMessageId;
}

export interface OpenRoomParticipationLeaseInput {
  companionId: string;
  channelId: string;
  disposition: RoomParticipationDisposition;
  /** The disposition's own room message; it is already considered. */
  watermarkMessageId: string;
  watermarkTimestampMs: number;
  nowMs: number;
  expiresAtMs: number;
}

export interface RefreshRoomParticipationLeaseInput {
  companionId: string;
  channelId: string;
  nowMs: number;
  expiresAtMs: number;
  watermarkMessageId: string;
  watermarkTimestampMs: number;
}

export interface ClaimRoomParticipationContinuationInput {
  companionId: string;
  channelId: string;
  messageId: string;
  timestampMs: number;
  authorIsMachine: boolean;
  nowMs: number;
  /** Atomic re-check of the caps the pure gate evaluated on the read snapshot. */
  maxContinuationCandidates: number;
  maxConsecutiveMachineContinuations: number;
}

export interface RecordRoomParticipationAppraisalInput {
  companionId: string;
  channelId: string;
  action: 'ignore' | 'react' | 'reply';
  nowMs: number;
}

export interface CloseRoomParticipationLeaseInput {
  companionId: string;
  channelId: string;
  reason: RoomParticipationLeaseCloseReason;
  nowMs: number;
}

/**
 * Durable room-participation lease store (gateway-owned shared schema, beside
 * the speaking-arbiter store). Every mutation is a single atomic statement so
 * two processes observing the same room cannot both claim one message, and a
 * restart resumes from exactly the persisted watermark.
 */
export interface RoomParticipationLeaseStorePort {
  read(input: {
    companionId: string;
    channelId: string;
  }): Promise<RoomParticipationLeaseSnapshot | null>;
  /** Open (or re-open) an active lease, resetting its bounded budget. */
  open(input: OpenRoomParticipationLeaseInput): Promise<RoomParticipationLeaseSnapshot>;
  /**
   * Extend a live lease's deadline and clear the ignore streak. Returns null
   * when no active lease exists — refresh never creates membership.
   */
  refresh(
    input: RefreshRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null>;
  /**
   * Atomically claim one observed message: advance the watermark, charge the
   * budget, and roll the machine streak. Returns null when the lease is gone,
   * lapsed, over budget, or another claim already took this message.
   */
  claimContinuation(
    input: ClaimRoomParticipationContinuationInput,
  ): Promise<RoomParticipationLeaseSnapshot | null>;
  /** Roll the ignore streak after the appraiser's ternary. */
  recordAppraisal(
    input: RecordRoomParticipationAppraisalInput,
  ): Promise<RoomParticipationLeaseSnapshot | null>;
  close(
    input: CloseRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null>;
  /** Release the underlying pool at shutdown. */
  shutdown(): Promise<void>;
}
