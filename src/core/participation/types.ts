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
    /** Present once a name match has been classified (autonomy/stale/duplicate). */
    trigger?: ParticipationCandidateTrigger;
  };
