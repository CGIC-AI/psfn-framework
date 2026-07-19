export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';

/**
 * Structural privacy of a channel. Replaces ChannelVisibility:
 * 'semi_private' was renamed to 'invite_only' (no alias) and 'broadcast'
 * stops being a privacy level — it becomes a boolean flag on the envelope.
 */
export type ChannelPrivacy = 'private' | 'invite_only' | 'public';

// Reason-tag mapping through the E3.3 envelope re-key:
// - 'visibility.channel_restricted' is KEPT for the channelPrivacy-keyed
//   restriction (identical semantics: the channel's structural class denies
//   the sensitivity; the reason string now cites the channelPrivacy value).
// - 'visibility.broadcast_restricted' is NEW: the old broadcast-visibility
//   denial (retired 'broadcast' ChannelVisibility row) now cites the
//   broadcast envelope dimension explicitly.
// - All other tags are unchanged.
export type PolicyReasonTag =
  | 'operator.approval_override'
  | 'boundary.withhold'
  | 'boundary.consent_required'
  | 'consent.allow_recall_denied'
  | 'trust.ceiling_exceeded'
  | 'visibility.channel_restricted'
  | 'visibility.broadcast_restricted'
  | 'default.within_bounds';
