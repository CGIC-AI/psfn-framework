// ── ConversationScope ──
// Value object answering "who is this conversation with" for one turn.
//
// The runtime's group-chat binding bugs all live at points where consumers
// independently rederive scope from loose params (message.isDirectMessage,
// authorId, singular contact lookups). ConversationScope is resolved ONCE per
// turn at session-manager ingress (SessionManager.resolveConversationScope,
// called from turn-execution prepareTurnIdentityState) and threaded to every
// consumer that needs to answer a scope question.
//
// Type guarantees:
// - discriminated union on `kind` ('dm' | 'group');
// - a group scope can NEVER carry a single canonical contact: the
//   `contact?: never` member makes that a compile error, not a convention;
// - `key` is a stable identity ('dm:<contactId>' | 'room:<channelId>')
//   precomputed at construction. It is a readonly data property (not a
//   method) so scope objects stay structuredClone- and JSON-safe.
//
// This bead (E1.1) is mechanical threading only: constructing and plumbing the
// scope changes zero behavior. The dependent beads flip behavior using it:
// E1.2 core-memory participant binding, E1.3 speaking_with gating,
// E1.5 emotion scoping, E1.7 reflection scoping.

/** Canonical contact binding for a DM scope. */
export interface ConversationScopeContact {
  readonly contactId: string;
  readonly displayName?: string;
}

/** One distinct recent user-role speaker observed in the session window. */
export interface ConversationScopeSpeaker {
  /** Stable speaker key: trimmed authorId when present, else authorName. */
  readonly authorId: string;
  readonly name: string;
}

/** Recent-speaker roster cap (mirrors the core-memory participant scan cap). */
export const CONVERSATION_SCOPE_RECENT_SPEAKER_LIMIT = 5;

export type ConversationScopeKey = `dm:${string}` | `room:${string}`;

interface ConversationScopeBase {
  readonly channelId: string;
  /**
   * Distinct recent user-role speakers, most recent session window first
   * (max CONVERSATION_SCOPE_RECENT_SPEAKER_LIMIT). Carried on both kinds so
   * consumers that render participant rosters (core-memory format context)
   * can consume the scope without rescanning the session store.
   */
  readonly recentSpeakers: readonly ConversationScopeSpeaker[];
  /** Stable scope identity: 'dm:<contactId>' | 'room:<channelId>'. */
  readonly key: ConversationScopeKey;
}

export interface DmConversationScope extends ConversationScopeBase {
  readonly kind: 'dm';
  /** The canonical DM partner. */
  readonly contact: ConversationScopeContact;
}

export interface GroupConversationScope extends ConversationScopeBase {
  readonly kind: 'group';
  readonly roomName?: string;
  readonly memberCountHint?: number;
  /**
   * Compile-time guard: a group scope cannot carry a single canonical
   * contact. Any attempt to bind "the" contact of a group is the exact bug
   * class this type exists to prevent.
   */
  readonly contact?: never;
}

export type ConversationScope = DmConversationScope | GroupConversationScope;

export class ConversationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationScopeError';
  }
}

function normalizeRecentSpeakers(
  recentSpeakers: readonly ConversationScopeSpeaker[],
): readonly ConversationScopeSpeaker[] {
  const seen = new Set<string>();
  const normalized: ConversationScopeSpeaker[] = [];
  for (const speaker of recentSpeakers) {
    const authorId = speaker.authorId.trim();
    const name = speaker.name.trim();
    if (!authorId || !name) {
      throw new ConversationScopeError(
        'ConversationScope recent speakers require non-empty authorId and name.',
      );
    }
    if (seen.has(authorId)) continue;
    seen.add(authorId);
    normalized.push(Object.freeze({ authorId, name }));
    if (normalized.length >= CONVERSATION_SCOPE_RECENT_SPEAKER_LIMIT) break;
  }
  return Object.freeze(normalized);
}

function requireChannelId(channelId: string): string {
  const normalized = channelId.trim();
  if (!normalized) {
    throw new ConversationScopeError('ConversationScope requires a non-empty channelId.');
  }
  return normalized;
}

export function createDmConversationScope(input: {
  channelId: string;
  contact: ConversationScopeContact;
  recentSpeakers?: readonly ConversationScopeSpeaker[];
}): DmConversationScope {
  const channelId = requireChannelId(input.channelId);
  const contactId = input.contact.contactId.trim();
  if (!contactId) {
    throw new ConversationScopeError('DM ConversationScope requires a non-empty contactId.');
  }
  const displayName = input.contact.displayName?.trim();
  return Object.freeze({
    kind: 'dm' as const,
    channelId,
    contact: Object.freeze({
      contactId,
      ...(displayName ? { displayName } : {}),
    }),
    recentSpeakers: normalizeRecentSpeakers(input.recentSpeakers ?? []),
    key: `dm:${contactId}` as const,
  });
}

export function createGroupConversationScope(input: {
  channelId: string;
  recentSpeakers?: readonly ConversationScopeSpeaker[];
  roomName?: string;
  memberCountHint?: number;
}): GroupConversationScope {
  const channelId = requireChannelId(input.channelId);
  const roomName = input.roomName?.trim();
  if (input.memberCountHint !== undefined
    && (!Number.isInteger(input.memberCountHint) || input.memberCountHint < 0)) {
    throw new ConversationScopeError(
      'Group ConversationScope memberCountHint must be a non-negative integer when present.',
    );
  }
  return Object.freeze({
    kind: 'group' as const,
    channelId,
    recentSpeakers: normalizeRecentSpeakers(input.recentSpeakers ?? []),
    ...(roomName ? { roomName } : {}),
    ...(input.memberCountHint !== undefined ? { memberCountHint: input.memberCountHint } : {}),
    key: `room:${channelId}` as const,
  });
}

/**
 * Pure ingress resolution rule shared by SessionManager.resolveConversationScope
 * and test fixtures. Group/direct determination is intentionally identical to
 * the runtime's existing detector (resolveConversationChatType /
 * message.isDirectMessage): only an explicit `isDirectMessage === true` is a DM.
 *
 * DM contact identity precedence (documented, not silent):
 * 1. `contact` — canonical contact resolution from turn ingress;
 * 2. `participantId` — the same identity that feeds the core-memory
 *    participantId today (continuity subject / userId);
 * 3. channel-derived `{ contactId: channelId }` — degraded identity for DM
 *    ingress with no canonical id. E1.2 tightens DM contact resolution and
 *    removes this degradation.
 */
export function resolveConversationScopeFromMetadata(input: {
  channelId: string;
  isDirectMessage: boolean | undefined;
  contact?: ConversationScopeContact;
  participantId?: string;
  recentSpeakers?: readonly ConversationScopeSpeaker[];
}): ConversationScope {
  const channelId = requireChannelId(input.channelId);
  if (input.isDirectMessage === true) {
    const participantId = input.participantId?.trim();
    const contact = input.contact
      ?? (participantId ? { contactId: participantId } : { contactId: channelId });
    return createDmConversationScope({
      channelId,
      contact,
      recentSpeakers: input.recentSpeakers ?? [],
    });
  }
  return createGroupConversationScope({
    channelId,
    recentSpeakers: input.recentSpeakers ?? [],
  });
}
