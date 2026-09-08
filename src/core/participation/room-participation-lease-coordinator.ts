import type { NearTurnMemoryScopeClassifierPort } from '../../faculties/memory/near-turn-memory-lane.js';
import type { RoomParticipationLeaseSettings } from '../../system/config/participation-config.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import {
  evaluateRoomParticipationContinuation,
  type RoomParticipationDisposition,
  type RoomParticipationLeaseCloseReason,
  type RoomParticipationLeaseStorePort,
  type RoomParticipationObservation,
} from './room-participation-lease.js';
import type { ParticipationAction, ParticipationSuppressionReason } from './types.js';

/**
 * Runtime seam for the bounded room-participation lease (jp36.5.5). It joins the
 * deterministic gate in `room-participation-lease.ts` to the durable store and
 * the real observe/reply paths:
 *
 * - {@link RoomParticipationLeaseCoordinator.admitContinuation} is consulted by
 *   the passive-name candidate gate when an observed room message carried NO
 *   name match. It runs the pure gate against the persisted lease and, only on
 *   `admit`, takes the atomic durable claim that makes the message considered.
 * - {@link RoomParticipationLeaseCoordinator.recordDisposition} opens/refreshes
 *   the lease after an explicit social act (a summons, a delivered room reply, a
 *   granted endogenous room entry, an appraised reaction).
 * - {@link RoomParticipationLeaseCoordinator.recordAppraisal} rolls the ignore
 *   streak, so a companion that keeps choosing silence withdraws from the room.
 * - {@link RoomParticipationLeaseCoordinator.closeForReservationGate} retires the
 *   lease when the arbiter's deterministic gate reports fatigue or room flooding.
 *
 * Fail-closed by construction: it can only ever *suppress* participation. It
 * never speaks, never calls a model, and never bypasses the reservation phase,
 * the appraiser, CogSec, fatigue, or the social pot — an admitted continuation
 * is handed to exactly the path a passive-name summons uses.
 */

/** The narrow verified-room facts a disposition needs; never message content. */
export interface RoomParticipationDispositionInput {
  channelId: string;
  channelType: ChannelType;
  disposition: RoomParticipationDisposition;
  /** The disposition's own room message id (already-considered watermark seed). */
  sourceMessageId: string;
  sourceTimestampMs: number;
  /**
   * Whether the act that produced this disposition was machine-authored: a
   * sibling bot's summons, a reply to one, or the companion's own endogenous
   * room entry. Required and never inferred — it is the bot-loop fence input on
   * the opening path, and an absent value would fail open into the loop the
   * fence exists to stop.
   */
  authorIsMachine: boolean;
  isDirectMessage?: boolean;
  nowMs?: number;
}

export type RoomParticipationDispositionOutcome =
  | { outcome: 'opened'; disposition: RoomParticipationDisposition; expiresAtMs: number }
  | { outcome: 'refreshed'; expiresAtMs: number }
  | { outcome: 'skipped'; reason: RoomParticipationDispositionSkipReason };

/** Content-free reason codes for a disposition that did not open/refresh. */
type RoomParticipationDispositionSkipReason =
  | 'policy_off'
  | 'direct_message'
  | 'not_group'
  | 'unsupported_channel'
  | 'invalid_source'
  | 'disposition_not_admitted'
  /** The bot-loop fence closed this room; only a human turn re-opens it. */
  | 'machine_fenced';

export type RoomParticipationContinuationOutcome =
  | { outcome: 'admitted' }
  | { outcome: 'absent' }
  | { outcome: 'suppressed'; suppression: ParticipationSuppressionReason };

export interface RoomParticipationLeaseCoordinatorOptions {
  companionId: string;
  store: RoomParticipationLeaseStorePort;
  scopeClassifier: NearTurnMemoryScopeClassifierPort;
  /** Owner policy (scheduler.json socialAutonomy.roomParticipationLease). */
  settings: RoomParticipationLeaseSettings;
  nowMs?: () => number;
}

export class RoomParticipationLeaseCoordinator {
  private readonly companionId: string;
  private readonly store: RoomParticipationLeaseStorePort;
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort;
  private readonly settings: RoomParticipationLeaseSettings;
  private readonly nowMs: () => number;

  constructor(options: RoomParticipationLeaseCoordinatorOptions) {
    this.companionId = options.companionId;
    this.store = options.store;
    this.scopeClassifier = options.scopeClassifier;
    this.settings = options.settings;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Decide whether one name-free room message may become a contextual
   * continuation candidate, and durably claim it when it may. Called on the
   * observe path before any model call; a room with no lease costs exactly one
   * durable read and produces no candidate.
   */
  async admitContinuation(input: {
    channelId: string;
    observation: RoomParticipationObservation;
  }): Promise<RoomParticipationContinuationOutcome> {
    const nowMs = this.nowMs();
    const lease = await this.store.read({
      companionId: this.companionId,
      channelId: input.channelId,
    });
    const decision = evaluateRoomParticipationContinuation({
      lease,
      observation: input.observation,
      settings: this.settings,
      nowMs,
    });
    if (decision.outcome === 'absent') {
      return { outcome: 'absent' };
    }
    if (decision.outcome === 'close') {
      await this.store.close({
        companionId: this.companionId,
        channelId: input.channelId,
        reason: decision.reason,
        nowMs,
      });
      return { outcome: 'suppressed', suppression: decision.suppression };
    }
    if (decision.outcome === 'suppressed') {
      return { outcome: 'suppressed', suppression: decision.suppression };
    }
    // The atomic claim re-checks status, expiry, the forward-only watermark, and
    // both caps, so a concurrent observer of the same message loses the race
    // instead of producing a second candidate.
    const claimed = await this.store.claimContinuation({
      companionId: this.companionId,
      channelId: input.channelId,
      messageId: input.observation.messageId,
      timestampMs: input.observation.timestampMs,
      authorIsMachine: input.observation.authorIsMachine,
      nowMs,
      maxContinuationCandidates: this.settings.maxContinuationCandidates,
      maxConsecutiveMachineContinuations: this.settings.maxConsecutiveMachineContinuations,
    });
    if (!claimed) {
      return { outcome: 'suppressed', suppression: 'lease_claim_lost' };
    }
    return { outcome: 'admitted' };
  }

  /**
   * Open or refresh the lease after an explicit disposition. Only the
   * owner-admitted dispositions may OPEN membership; any of them refreshes a
   * lease that is already live, because each one is the companion or the room
   * re-engaging.
   *
   * The bot-loop fence outranks both: a machine-authored disposition carries the
   * machine streak forward instead of clearing it, and it can never re-open a
   * lease closed for `machine_streak`. Only a human turn re-opens that room.
   */
  async recordDisposition(
    input: RoomParticipationDispositionInput,
  ): Promise<RoomParticipationDispositionOutcome> {
    if (!this.settings.enabled) {
      return { outcome: 'skipped', reason: 'policy_off' };
    }
    if (input.isDirectMessage === true) {
      return { outcome: 'skipped', reason: 'direct_message' };
    }
    if (input.channelType !== 'discord' && input.channelType !== 'buzz') {
      // The lease is a verified group-room membership; other transports (ICP,
      // terminal, voice) have their own consent moments.
      return { outcome: 'skipped', reason: 'unsupported_channel' };
    }
    const sourceMessageId = input.sourceMessageId.trim();
    if (!sourceMessageId || !Number.isFinite(input.sourceTimestampMs)) {
      return { outcome: 'skipped', reason: 'invalid_source' };
    }
    const scope = await this.scopeClassifier.classifyChannelMemoryScope({
      channelId: input.channelId,
      channelType: input.channelType,
    });
    if (scope !== 'group') {
      return { outcome: 'skipped', reason: 'not_group' };
    }
    const nowMs = input.nowMs ?? this.nowMs();
    const expiresAtMs = nowMs + this.settings.leaseTtlMs;
    const refreshed = await this.store.refresh({
      companionId: this.companionId,
      channelId: input.channelId,
      nowMs,
      expiresAtMs,
      watermarkMessageId: sourceMessageId,
      watermarkTimestampMs: input.sourceTimestampMs,
      authorIsMachine: input.authorIsMachine,
    });
    if (refreshed) {
      return { outcome: 'refreshed', expiresAtMs: refreshed.expiresAtMs };
    }
    if (!this.settings.openOn[OPEN_ON_KEYS[input.disposition]]) {
      return { outcome: 'skipped', reason: 'disposition_not_admitted' };
    }
    // A machine-authored disposition cannot re-open a lease the bot-loop fence
    // closed: the store refuses it atomically and reports null, so two sibling
    // bots cannot mention each other back into a room they were cut off from.
    const opened = await this.store.open({
      companionId: this.companionId,
      channelId: input.channelId,
      disposition: input.disposition,
      watermarkMessageId: sourceMessageId,
      watermarkTimestampMs: input.sourceTimestampMs,
      authorIsMachine: input.authorIsMachine,
      nowMs,
      expiresAtMs,
    });
    if (!opened) {
      return { outcome: 'skipped', reason: 'machine_fenced' };
    }
    return {
      outcome: 'opened',
      disposition: opened.openedDisposition,
      expiresAtMs: opened.expiresAtMs,
    };
  }

  /**
   * Roll the ignore streak after the appraiser's ternary. Repeated silence is a
   * normal terminal outcome, and enough of it in a row withdraws the companion
   * from the running conversation instead of retrying into speech.
   */
  async recordAppraisal(input: {
    channelId: string;
    action: ParticipationAction;
    nowMs?: number;
  }): Promise<{ outcome: 'closed'; reason: RoomParticipationLeaseCloseReason }
    | { outcome: 'recorded' | 'absent' }> {
    if (!this.settings.enabled) {
      return { outcome: 'absent' };
    }
    const nowMs = input.nowMs ?? this.nowMs();
    const updated = await this.store.recordAppraisal({
      companionId: this.companionId,
      channelId: input.channelId,
      action: input.action,
      nowMs,
    });
    if (!updated) {
      return { outcome: 'absent' };
    }
    if (updated.ignoreStreak < this.settings.maxConsecutiveIgnores) {
      return { outcome: 'recorded' };
    }
    await this.store.close({
      companionId: this.companionId,
      channelId: input.channelId,
      reason: 'withdrawn',
      nowMs,
    });
    return { outcome: 'closed', reason: 'withdrawn' };
  }

  /**
   * Retire the lease when the speaking arbiter's deterministic reservation gate
   * reports an unfundable social pot or a flooded room. Transient gates (ICP
   * precedence, availability, gate errors) leave membership alone: they suppress
   * this turn, they are not a reason to leave the conversation.
   */
  async closeForReservationGate(input: {
    channelId: string;
    blockedBy: string;
    nowMs?: number;
  }): Promise<{ outcome: 'closed'; reason: RoomParticipationLeaseCloseReason }
    | { outcome: 'retained' }> {
    const reason = reservationGateCloseReason(input.blockedBy);
    if (!reason) {
      return { outcome: 'retained' };
    }
    const closed = await this.store.close({
      companionId: this.companionId,
      channelId: input.channelId,
      reason,
      nowMs: input.nowMs ?? this.nowMs(),
    });
    return closed ? { outcome: 'closed', reason } : { outcome: 'retained' };
  }
}

/**
 * Disposition → owner-policy key. The owner file names each admitted opener in
 * camelCase; the durable contract names dispositions in the snake_case the
 * arbiter tables use.
 */
const OPEN_ON_KEYS: Record<
  RoomParticipationDisposition,
  keyof RoomParticipationLeaseSettings['openOn']
> = {
  direct_summons: 'directSummons',
  passive_summons: 'passiveSummons',
  reaction: 'reaction',
  reply: 'reply',
  endogenous_room_entry: 'endogenousRoomEntry',
};

function reservationGateCloseReason(
  blockedBy: string,
): RoomParticipationLeaseCloseReason | null {
  if (blockedBy === 'fatigue_pot_insufficient') return 'fatigue';
  if (blockedBy === 'room_flooded') return 'room_pressure';
  return null;
}
