import type { ChannelType } from '../../shared/contracts/runtime.js';
import {
  PARTICIPATION_ACTIONS,
  type ParticipationAction,
  type ParticipationCandidateTrigger,
  type ParticipationSuppressionReason,
  type PrecomputedNoReplyDisposition,
} from '../../shared/contracts/participation-types.js';

export {
  PARTICIPATION_ACTIONS,
  type ParticipationAction,
  type ParticipationCandidateTrigger,
  type ParticipationSuppressionReason,
  type PrecomputedNoReplyDisposition,
};

/**
 * Room-participation candidate contracts (free-time social autonomy, bible
 * §8.1). A candidate is a content-light request to *consider* a room action; it
 * does not itself grant a turn or run a model. The cheap participation appraiser
 * (jp36.3.3) and the gateway speaking arbiter (jp36.5) consume candidates behind
 * the Room Participation Coordinator seam (§13.1).
 */

/** The conversation surface on which the speaking decision is being made. */
type ParticipationSurface = 'group_room' | 'companion_dm';

/** A bounded preceding room message attached for same-name disambiguation. */
export interface ParticipationContextMessage {
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestampMs: number;
}

/**
 * A companion-authored request to consider entering a room. Unlike an inbound
 * participation candidate, this is derived from a durable social-impulse
 * disposition and therefore has no participant author or fabricated message.
 * The room intent is chosen by the companion after selecting an exact,
 * authorized destination; the originating affect signal remains content-free.
 */
export interface EndogenousRoomParticipationCandidate {
  schemaVersion: 1;
  kind: 'endogenous_room_candidate';
  source: 'social_impulse_disposition';
  /** Durable social-impulse opportunity/correlation identity. */
  sourceEventId: string;
  /** Hash-bound identity of the companion's exact disposition and room choice. */
  candidateId: string;
  channelId: string;
  channelType: 'discord';
  companionId: string;
  /** Companion-authored local topic/intent; never represented as participant speech. */
  roomIntent: string;
  occurredAtMs: number;
}

export interface ParticipationCandidate {
  schemaVersion: 1;
  channelId: string;
  channelType: ChannelType;
  /** Defaults to `group_room` for candidates created before ICP reused this arbiter. */
  participationSurface?: ParticipationSurface;
  /** The room message that triggered the candidate. */
  sourceMessageId: string;
  trigger: ParticipationCandidateTrigger;
  triggerAuthorId: string;
  /**
   * Whether the triggering author is a machine (a sibling bot or a peer
   * companion). Carried on the candidate so downstream dispositions — notably
   * the room-participation lease's bot-loop fence — never have to re-derive it
   * from connector-shaped routing fields.
   */
  triggerAuthorIsMachine: boolean;
  triggerAuthorName: string;
  triggerContent: string;
  triggerTimestampMs: number;
  /** A textual name/alias/`<@id>` reference matched. */
  matchedName: boolean;
  /** The message opened by addressing the companion. */
  matchedDirectAddress: boolean;
  /**
   * Immediately-preceding room messages (chronological, bounded) so the
   * appraiser can tell "about me" from "a same-named human" (bible §8.2/§11.5).
   */
  precedingContext: ParticipationContextMessage[];
  createdAtMs: number;
}

export type PassiveNameCandidateDecision =
  | { status: 'created'; candidate: ParticipationCandidate }
  | {
    status: 'suppressed';
    reason: ParticipationSuppressionReason;
    channelId: string;
    sourceMessageId: string;
    /** Present once a name match has been classified (autonomy/stale/duplicate/debounced). */
    trigger?: ParticipationCandidateTrigger;
  };

/**
 * Strict ternary output contract of the participation appraiser (bible §8.2).
 * The appraiser is a cheap, tool-less background-model call run from the
 * companion's own perspective ("they mentioned me; do I want to reply?"); its
 * ONLY authority is to pick one of these three actions. A `reply` here does not
 * itself speak — it still routes through the full normal response path and its
 * egress gates downstream (the gateway speaking arbiter, jp36.5). Room text
 * that reaches the model is datamarked/quoted, so an injected line can at worst
 * flip one cheap ternary, never exceed it.
 */
export type ParticipationAppraisal =
  | { action: 'ignore'; reasonCode: string; confidence: number }
  | { action: 'react'; reasonCode: string; confidence: number; reactionClass: string }
  | { action: 'reply'; reasonCode: string; confidence: number };

/**
 * The appraiser always yields a ternary. When the model call is disabled,
 * times out, errors, or returns output that does not satisfy the strict
 * contract, the appraiser fails closed to `ignore` (never a default-respond;
 * bible §18 "Passive-name appraiser unavailable"): `failClosed` is then true
 * and `failClosedReason` records why for content-free telemetry.
 */
export interface ParticipationAppraisalResult {
  appraisal: ParticipationAppraisal;
  failClosed: boolean;
  failClosedReason?: string;
}
