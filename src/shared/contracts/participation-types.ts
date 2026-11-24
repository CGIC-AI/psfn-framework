// ── Room participation core contracts (psfn-framework-kbdvl.1) ──
//
// Core-owned participation trigger, suppression, action, and trusted
// precomputed-no-reply types shared across the event bus, message handler
// options, and the host participation appraiser.

/**
 * Which deterministic trigger produced the candidate.
 *
 * - `passive_name`   — an ambient name/alias occurrence in room chatter.
 * - `direct_mention` — the message opens by addressing the companion (a leading
 *                      platform mention or a message that starts with an alias).
 * - `contextual_continuation` — no name at all: an ordinary follow-up in a room
 *                      where this companion already holds a bounded durable
 *                      participation lease (jp36.5.5). Admission is decided by
 *                      the deterministic lease gate before any model call.
 */
export type ParticipationCandidateTrigger =
  | 'direct_mention'
  | 'passive_name'
  | 'companion_message'
  | 'contextual_continuation';

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
  /** Owner policy disabled continuation while a lease was still live. */
  'lease_policy_off',
  /** The bounded membership lifetime elapsed. */
  'lease_expired',
  /** Nothing was considered for the configured silence window. */
  'lease_silent',
  /** The per-lease continuation budget is spent. */
  'lease_message_cap',
  /** The consecutive machine-author fence tripped (no bot-to-bot loop). */
  'lease_machine_streak',
  /** Already considered: the message is at or behind the context watermark. */
  'lease_watermark',
  /** Continuations are rate-limited within one room. */
  'lease_cooldown',
  /** Bounded relevance hint: too little content to read as a follow-up. */
  'lease_low_signal',
  /** Another observer claimed this message first (restart/redelivery race). */
  'lease_claim_lost',
  /** The connector never asserted a verified group room. */
  'room_unverified',
  /** Untrusted/unknown room member: direct address only (owner policy). */
  'untrusted_room_member',
  /** The room is moving faster than contextual participation is allowed in. */
  'room_velocity',
  /** Reviewed coarse topics gave no relevance for this companion. */
  'topic_mismatch',
  /** Ambiguity remained and no shared bounded classifier could resolve it. */
  'room_signal_ambiguous',
] as const;

export type ParticipationSuppressionReason =
  typeof PARTICIPATION_SUPPRESSION_REASONS[number];

/** The ternary participation action the appraiser may choose (bible §8.2). */
export const PARTICIPATION_ACTIONS = ['ignore', 'react', 'reply'] as const;
export type ParticipationAction = typeof PARTICIPATION_ACTIONS[number];

/**
 * Trusted in-process result threaded from the cheap participation appraiser to
 * the ordinary turn runtime. It may suppress generation only for an
 * authenticated inbound ICP turn; peer-controlled routing metadata can never
 * construct this object.
 */
export interface PrecomputedNoReplyDisposition {
  source: 'participation_appraiser';
  reasonCode: string;
  confidence: number;
  failClosed: boolean;
}
