import type { ChannelType } from '../../shared/contracts/runtime.js';

/**
 * Room-participation candidate contracts (free-time social autonomy, bible
 * §8.1). A candidate is a content-light request to *consider* a room action; it
 * does not itself grant a turn or run a model. The cheap participation appraiser
 * (jp36.3.3) and the gateway speaking arbiter (jp36.5) consume candidates behind
 * the Room Participation Coordinator seam (§13.1).
 */

/**
 * Which deterministic trigger produced the candidate.
 *
 * - `passive_name`   — an ambient name/alias occurrence in room chatter.
 * - `direct_mention` — the message opens by addressing the companion (a leading
 *                      platform mention or a message that starts with an alias).
 */
export type ParticipationCandidateTrigger = 'direct_mention' | 'passive_name';

/** A bounded preceding room message attached for same-name disambiguation. */
export interface ParticipationContextMessage {
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestampMs: number;
}

export interface ParticipationCandidate {
  schemaVersion: 1;
  channelId: string;
  channelType: ChannelType;
  /** The room message that triggered the candidate. */
  sourceMessageId: string;
  trigger: ParticipationCandidateTrigger;
  triggerAuthorId: string;
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

export const PARTICIPATION_SUPPRESSION_REASONS = [
  'disabled',
  'own_message',
  'icp_lane',
  'direct_message',
  'not_group',
  'no_name_match',
  'autonomy_disabled',
  'stale',
  'duplicate',
  'debounced',
] as const;

export type ParticipationSuppressionReason =
  typeof PARTICIPATION_SUPPRESSION_REASONS[number];

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

/** The ternary participation action the appraiser may choose (bible §8.2). */
export const PARTICIPATION_ACTIONS = ['ignore', 'react', 'reply'] as const;
export type ParticipationAction = typeof PARTICIPATION_ACTIONS[number];

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
