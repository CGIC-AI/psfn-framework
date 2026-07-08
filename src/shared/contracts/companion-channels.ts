// ── Same-cluster inter-companion channel identifiers (sprint 10, W6) ──
//
// Companion-to-companion conversation happens through ORDINARY CHANNELS in the
// normal turn pipeline — that is the entire loop-safety argument. Every peer
// message enters the receiving agent as a normal inbound channel turn, so the
// conversation-fatigue system (MI↔MI charging, human-resets-free, soft
// wrap-up, hard suppression) applies with zero new mechanism. There is no
// side-channel dispatch, ever (working_docs/sprint-10-multi-companion.md §8,
// "fatigue bypass" risk).
//
// Two channel shapes (review §9):
//
//  - ROOM (`companion-room:<placeId>`) — many-to-many. A virtual place's
//    conversation venue: companions whose shared-schema presence is at the
//    place are the room's members. The channelId contains "companion" and is
//    not a direct message, so the fatigue policy classifies it as
//    `companion_room` (channel setting `quiet_companion_room` in
//    charge-policy.json).
//
//  - DM (`companion-dm:<a>:<b>`) — one-to-one IPC (the SMS/DM/phone-call
//    analogue). Participant ids are sorted so both sides share ONE canonical
//    channelId; because fatigue budgets key on
//    {localCompanionId, peerContactId, channelId, dayKey}, the DM budget is
//    independent of any room budget by construction.
//
//    FATIGUE CLASSIFICATION DECISION (documented per W6): companion DMs are
//    delivered with `isDirectMessage: true`, so `resolvePolicyChannelType`
//    classifies them as `dm` (channel setting `dm`, the most generous limits
//    in charge-policy.seed.json), NOT `quiet_companion_room`. This follows the
//    seed config's intent: `dm` is the setting for one-to-one channels, and
//    the sprint doc frames companion IPC as the DM analogue. The MI↔MI
//    relationship budget still applies and hard exhaustion still suppresses —
//    the classification only picks which channel-setting cap bounds it.
//
// CONVERSATION INITIATION POLICY (documented per W6): minimal. A co-location
// arrival appends a system-only room-entry note to the room channel session —
// context, not a triggered turn. No auto-greeting is dispatched on arrival;
// a free-time/outreach lane choosing to speak into a room is future work.

export const COMPANION_CHANNEL_TYPE = 'companion';

export const COMPANION_ROOM_CHANNEL_PREFIX = 'companion-room:';
export const COMPANION_DM_CHANNEL_PREFIX = 'companion-dm:';

export type ParsedCompanionChannel =
  | { kind: 'room'; placeId: string }
  | { kind: 'dm'; participants: [string, string] };

function isValidIdSegment(value: string): boolean {
  // Companion ids are UUIDs and place ids follow the places-registry token
  // grammar; neither contains ':'. Reject anything empty or colon-bearing so
  // channel-id parsing stays unambiguous.
  return value.length > 0 && !value.includes(':') && value.trim() === value;
}

/** Canonical room channelId for a place's conversation venue. */
export function composeCompanionRoomChannelId(placeId: string): string {
  const normalized = placeId.trim();
  if (!isValidIdSegment(normalized)) {
    throw new Error(`Invalid companion room placeId: ${JSON.stringify(placeId)}`);
  }
  return `${COMPANION_ROOM_CHANNEL_PREFIX}${normalized}`;
}

/**
 * Canonical DM channelId for a companion pair. Participant order is
 * normalized (lexicographic sort) so both sides derive the same channelId —
 * one channel, one fatigue budget, regardless of who addresses whom.
 */
export function composeCompanionDmChannelId(companionA: string, companionB: string): string {
  const a = companionA.trim();
  const b = companionB.trim();
  if (!isValidIdSegment(a) || !isValidIdSegment(b)) {
    throw new Error(
      `Invalid companion DM participant ids: ${JSON.stringify(companionA)}, ${JSON.stringify(companionB)}`,
    );
  }
  if (a === b) {
    throw new Error(`Companion DM requires two distinct participants, got ${JSON.stringify(a)} twice`);
  }
  const [first, second] = [a, b].sort();
  return `${COMPANION_DM_CHANNEL_PREFIX}${first}:${second}`;
}

/**
 * Parse a companion channelId. Returns null for anything that is not a
 * well-formed companion channel — callers fail closed on null. A DM channelId
 * must already be in canonical (sorted, distinct) participant order; a
 * non-canonical id is rejected rather than silently normalized so two spellings
 * of one conversation can never split into two fatigue budgets.
 */
export function parseCompanionChannelId(channelId: string): ParsedCompanionChannel | null {
  if (channelId.startsWith(COMPANION_ROOM_CHANNEL_PREFIX)) {
    const placeId = channelId.slice(COMPANION_ROOM_CHANNEL_PREFIX.length);
    if (!isValidIdSegment(placeId)) return null;
    return { kind: 'room', placeId };
  }
  if (channelId.startsWith(COMPANION_DM_CHANNEL_PREFIX)) {
    const rest = channelId.slice(COMPANION_DM_CHANNEL_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 2) return null;
    const [a, b] = parts;
    if (!isValidIdSegment(a) || !isValidIdSegment(b)) return null;
    if (a === b || a > b) return null;
    return { kind: 'dm', participants: [a, b] };
  }
  return null;
}

/** True when the channelId belongs to the inter-companion lane. */
export function isCompanionChannelId(channelId: string): boolean {
  return channelId.startsWith(COMPANION_ROOM_CHANNEL_PREFIX)
    || channelId.startsWith(COMPANION_DM_CHANNEL_PREFIX);
}
