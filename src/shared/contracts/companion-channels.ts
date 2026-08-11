// ── Same-cluster inter-companion channel identifiers ──
//
// Companion-to-companion conversation happens through ORDINARY CHANNELS in the
// normal turn pipeline — that is the entire loop-safety argument. Every peer
// message enters the receiving agent as a normal inbound channel turn, so the
// conversation-fatigue system (MI↔MI charging, human-resets-free, soft
// wrap-up, hard suppression) applies with zero new mechanism. There is no
// side-channel dispatch, ever; that would create a fatigue bypass.
//
// Two channel shapes (docs/chat-turn-lifecycle.md, "Situated presence and
// companion-room delivery"):
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
//    FATIGUE CLASSIFICATION DECISION: companion DMs are
//    delivered with `isDirectMessage: true`, so `resolvePolicyChannelType`
//    classifies them as `dm` (channel setting `dm`, the most generous limits
//    in charge-policy.seed.json), NOT `quiet_companion_room`. This follows the
//    seed config's intent: `dm` is the setting for one-to-one channels, and
//    the canonical channel contract frames companion IPC as the DM analogue.
//    The MI↔MI relationship budget still applies and hard exhaustion still
//    suppresses — the classification only picks which channel-setting cap bounds it.
//
// CONVERSATION INITIATION POLICY: minimal. A co-location
// arrival appends a system-only room-entry note to the room channel session —
// context, not a triggered turn. No auto-greeting is dispatched on arrival;
// a free-time/outreach lane choosing to speak into a room is future work.

import {
  createCompanionId,
  parseCompanionId,
  type CompanionId,
} from '../routing/companion-id.js';

export const COMPANION_CHANNEL_TYPE = 'companion';

export const COMPANION_ROOM_CHANNEL_PREFIX = 'companion-room:';
export const COMPANION_DM_CHANNEL_PREFIX = 'companion-dm:';

export type ParsedCompanionChannel =
  | { kind: 'room'; placeId: string }
  | { kind: 'dm'; participants: [CompanionId, CompanionId] };

function isValidRoomPlaceId(value: string): boolean {
  // Place ids follow the places-registry token grammar and never contain ':'.
  // Companion participants use the canonical CompanionId parser below.
  return value.length > 0 && !value.includes(':') && value.trim() === value;
}

/** Canonical room channelId for a place's conversation venue. */
export function composeCompanionRoomChannelId(placeId: string): string {
  const normalized = placeId.trim();
  if (!isValidRoomPlaceId(normalized)) {
    throw new Error(`Invalid companion room placeId: ${JSON.stringify(placeId)}`);
  }
  return `${COMPANION_ROOM_CHANNEL_PREFIX}${normalized}`;
}

/**
 * Canonical DM channelId for a companion pair. Participant order is
 * normalized (lexicographic sort) so both sides derive the same channelId —
 * one channel, one fatigue budget, regardless of who addresses whom.
 */
export function composeCompanionDmChannelId(
  companionA: CompanionId,
  companionB: CompanionId,
): string {
  const a = createCompanionId(companionA, 'companion DM participant A');
  const b = createCompanionId(companionB, 'companion DM participant B');
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
    if (!isValidRoomPlaceId(placeId)) return null;
    return { kind: 'room', placeId };
  }
  if (channelId.startsWith(COMPANION_DM_CHANNEL_PREFIX)) {
    const rest = channelId.slice(COMPANION_DM_CHANNEL_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 2) return null;
    const [a, b] = parts;
    const companionA = parseCompanionId(a);
    const companionB = parseCompanionId(b);
    // Channel IDs are canonical wire values: parsing may never trim or repair
    // a participant token because that would create multiple spellings of one
    // fatigue budget.
    if (!companionA || !companionB || companionA !== a || companionB !== b) return null;
    if (companionA === companionB || companionA > companionB) return null;
    return {
      kind: 'dm',
      participants: [companionA, companionB],
    };
  }
  return null;
}

/** True when the channelId belongs to the inter-companion lane. */
export function isCompanionChannelId(channelId: string): boolean {
  return channelId.startsWith(COMPANION_ROOM_CHANNEL_PREFIX)
    || channelId.startsWith(COMPANION_DM_CHANNEL_PREFIX);
}
