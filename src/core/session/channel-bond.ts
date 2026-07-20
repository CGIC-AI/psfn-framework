import {
  classifyChannelDisclosure,
  evaluateMemoryPolicy,
  getVisibilityDisclosureCeiling,
  visibilitiesShareContinuity,
  type ChannelDisclosureContext,
  type ChannelMeta,
} from '../../system/trust/policy.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { ContactChannelIdentity } from '../contacts/types.js';
import type { CrossChannelContinuityPort } from './cross-channel-continuity-contract.js';
import {
  collectRecentEntriesWithinHistorySpan,
  isNonConversationalSessionEntry,
  parseChannelVisibility,
  parseMirrorMetadata,
  type RecentEntryStoreLike,
} from './manager-primitives.js';
import type { SessionEntry } from './types.js';

/**
 * Channel bonding: explicitly opted-in contact channel
 * identities operate as ONE logical conversation. Physical session logs stay
 * split per channel; the bond is a read-time interleave of the bonded
 * members' logs into the current channel's context timeline, ordered by
 * timestamp and annotated with the source channel.
 *
 * Privacy: the bond operates at the LOWEST-COMMON (most restrictive) privacy
 * of its members. A foreign entry crosses into the current channel only when
 * its source disclosure flows into BOTH the bond's effective disclosure and
 * the current channel's disclosure, and the trust/memory policy allows it.
 * Any member whose privacy cannot be determined disables the whole bond —
 * the bond never widens anything it cannot prove safe (fail closed).
 */

/** How far back the continuity thread is scanned for bonded member channels. */
export const DEFAULT_CHANNEL_BOND_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-member cap on entries pulled into the bonded interleave. */
export const CHANNEL_BOND_MEMBER_ENTRY_LIMIT = 40;

/** Metadata key carrying the bond marker on merged foreign entries. */
export const CHANNEL_BOND_METADATA_KEY = 'channelBond';

/** Turn-scoped bond opt-in resolved from the author's contact record. */
export interface TurnChannelBondInput {
  /** Exact identity that authored the current turn. */
  currentIdentity: ContactChannelIdentity;
  /** Exact contact identities carrying the explicit `bonded` opt-in flag. */
  bondedIdentities: readonly ContactChannelIdentity[];
  /** Trust level of the resolved contact, for memory-policy gating. */
  trustLevel: TrustLevel;
}

/** Marker persisted (in-memory, snapshot-scoped) on merged foreign entries. */
export interface ChannelBondEntryMarker {
  kind: 'channel_bond';
  /** Physical channel the entry was read from. */
  sourceChannelId: string;
  /** Strictly parsed persisted visibility of the source entry. */
  sourceVisibility: ChannelPrivacy;
}

export interface ResolvedBondedTimeline {
  /** Merged timeline: own entries (mirror-deduped) + admissible foreign entries. */
  entries: SessionEntry[];
  /** Foreign entries included in the merge. */
  bondedEntryCount: number;
  /** Member channels that contributed at least one candidate entry. */
  memberChannelIds: string[];
  /** Lowest-common (most restrictive) privacy across the bonded set. */
  effectivePrivacy: ChannelPrivacy;
  /** Own-log mirror notes dropped because their source is interleaved. */
  suppressedMirrorEntryCount: number;
}

/**
 * Normalizes a channel id or contact identity channel to a platform key so
 * bonded contact identities ("discord", "api", "satellite:presence") can be
 * matched against physical channel ids ("discord:123", "1234567890",
 * "discord-voice:99", "api:principal:session"). Returns null when no
 * platform can be derived — an unmatchable channel never joins a bond.
 */
export function resolveChannelPlatformKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Bare numeric ids are Discord channel ids (same heuristic as the session
  // mirror channel overrides).
  if (/^\d{6,}$/.test(trimmed)) return 'discord';
  const firstSegment = trimmed.includes(':') ? trimmed.slice(0, trimmed.indexOf(':')) : trimmed;
  if (!firstSegment) return null;
  if (firstSegment === 'discord-voice') return 'discord';
  return firstSegment;
}

function parseMetadataObject(metadata?: string): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseChannelBondEntryMarker(metadata?: string): ChannelBondEntryMarker | null {
  // Fast path: unbonded systems never pay a JSON.parse on the render path.
  if (!metadata || !metadata.includes(CHANNEL_BOND_METADATA_KEY)) return null;
  const parsed = parseMetadataObject(metadata);
  if (!parsed) return null;
  const raw = parsed[CHANNEL_BOND_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (marker.kind !== 'channel_bond') return null;
  if (typeof marker.sourceChannelId !== 'string' || !marker.sourceChannelId) return null;
  const sourceVisibility = parseChannelVisibility(
    typeof marker.sourceVisibility === 'string' ? marker.sourceVisibility : undefined,
  );
  if (sourceVisibility === undefined) return null;
  return {
    kind: 'channel_bond',
    sourceChannelId: marker.sourceChannelId,
    sourceVisibility,
  };
}

export function isBondedForeignEntry(entry: Pick<SessionEntry, 'metadata'>): boolean {
  return parseChannelBondEntryMarker(entry.metadata) !== null;
}

/**
 * Attaches the bond marker to an entry's metadata envelope, preserving every
 * existing key (intake screening taint/provenance rides along untouched).
 * Returns null when the existing metadata is present but not a JSON object —
 * an entry whose provenance cannot be preserved never crosses the bond.
 */
function buildMetadataWithBondMarker(
  existingMetadata: string | undefined,
  marker: ChannelBondEntryMarker,
): string | null {
  if (existingMetadata === undefined || existingMetadata === '') {
    return JSON.stringify({ [CHANNEL_BOND_METADATA_KEY]: marker });
  }
  const parsed = parseMetadataObject(existingMetadata);
  if (!parsed) return null;
  return JSON.stringify({ ...parsed, [CHANNEL_BOND_METADATA_KEY]: marker });
}

/**
 * Lowest-common disclosure of the bonded set: the member whose allowed
 * sensitivity set flows into every other member's (i.e. the most restrictive
 * member). Returns null when no member satisfies that for the active trust
 * policy — the bond then resolves nothing (fail closed).
 */
export function resolveEffectiveBondDisclosure(
  members: readonly ChannelDisclosureContext[],
): ChannelDisclosureContext | null {
  if (members.length === 0) return null;
  for (const candidate of members) {
    if (members.every(other => visibilitiesShareContinuity(candidate, other))) {
      return candidate;
    }
  }
  return null;
}

interface BondMemberCandidate {
  channelId: string;
  disclosure: ChannelDisclosureContext;
  entries: SessionEntry[];
}

/**
 * Deterministic bonded-timeline order: timestamp, own-before-foreign at the
 * same instant, then id, then source channel. Also used to re-interleave a
 * bonded timeline after own-channel-only transforms (e.g. compaction).
 */
export function sortBondedTimelineEntries(entries: SessionEntry[]): SessionEntry[] {
  return [...entries].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const aForeign = isBondedForeignEntry(a);
    const bForeign = isBondedForeignEntry(b);
    // Own entries sort before foreign entries at the same instant.
    if (aForeign !== bForeign) return aForeign ? 1 : -1;
    if (a.id !== b.id) return a.id - b.id;
    return a.channelId.localeCompare(b.channelId);
  });
}

/**
 * Resolves the bonded logical timeline for the current turn's channel.
 *
 * Returns null whenever the bond is inactive or cannot be proven safe:
 * missing continuity identity, no bonded member channels in the continuity
 * window, a member whose privacy cannot be determined from its persisted
 * labels, or no lowest-common disclosure under the active trust policy.
 * A null result leaves the caller's own-channel timeline untouched — the
 * bond never widens anything on failure.
 */
export function resolveBondedSessionTimeline(params: {
  bond: TurnChannelBondInput;
  /** Continuity subject key (canonical contact id) for member discovery. */
  continuityUserId: string | undefined;
  /** Resolved session channel id whose context is being built. */
  channelId: string;
  /** Source channel id used for disclosure classification. */
  sourceChannelId: string;
  channelMeta?: ChannelMeta;
  /** Own-channel entries already collected/windowed/masked for the turn. */
  ownEntries: SessionEntry[];
  crossChannelContinuity: CrossChannelContinuityPort;
  store: RecentEntryStoreLike;
  maxHistorySpanMs: number;
  activeWindowMs?: number;
  memberEntryLimit?: number;
  nowMs?: number;
}): ResolvedBondedTimeline | null {
  const continuityUserId = params.continuityUserId?.trim();
  if (!continuityUserId) return null;

  const currentIdentityChannel = params.bond.currentIdentity.channel.trim().toLowerCase();
  const currentIdentityUserId = params.bond.currentIdentity.userId.trim();
  if (!currentIdentityChannel || !currentIdentityUserId) return null;
  const currentIdentityIsBonded = params.bond.bondedIdentities.some(identity => (
    identity.channel.trim().toLowerCase() === currentIdentityChannel
    && identity.userId.trim() === currentIdentityUserId
  ));
  if (!currentIdentityIsBonded) return null;

  const bondedUserIdsByPlatform = new Map<string, Set<string>>();
  for (const identity of params.bond.bondedIdentities) {
    const platformKey = resolveChannelPlatformKey(identity.channel);
    const userId = identity.userId.trim();
    if (!platformKey || !userId) continue;
    const userIds = bondedUserIdsByPlatform.get(platformKey) ?? new Set<string>();
    userIds.add(userId);
    bondedUserIdsByPlatform.set(platformKey, userIds);
  }
  if (bondedUserIdsByPlatform.size === 0) return null;

  // The current physical surface must match the exact bonded identity's
  // platform. A same-platform account cannot activate somebody else's bond.
  const currentPlatformKey = resolveChannelPlatformKey(params.sourceChannelId)
    ?? resolveChannelPlatformKey(params.channelId);
  const currentIdentityPlatformKey = resolveChannelPlatformKey(currentIdentityChannel);
  if (
    !currentPlatformKey
    || currentIdentityPlatformKey !== currentPlatformKey
    || !bondedUserIdsByPlatform.get(currentPlatformKey)?.has(currentIdentityUserId)
  ) {
    return null;
  }

  const nowMs = params.nowMs ?? Date.now();
  const activeWindowMs = Math.max(1_000, params.activeWindowMs ?? DEFAULT_CHANNEL_BOND_ACTIVE_WINDOW_MS);
  const memberEntryLimit = Math.max(1, params.memberEntryLimit ?? CHANNEL_BOND_MEMBER_ENTRY_LIMIT);

  const activeChannels = params.crossChannelContinuity.getActiveChannels(continuityUserId, {
    excludeChannelId: params.sourceChannelId,
    withinMs: activeWindowMs,
    nowMs,
  });

  const memberCandidates: BondMemberCandidate[] = [];
  for (const active of activeChannels) {
    if (active.channelId === params.channelId || active.channelId === params.sourceChannelId) continue;
    const platformKey = resolveChannelPlatformKey(active.channelId);
    const authorizedUserIds = platformKey
      ? bondedUserIdsByPlatform.get(platformKey)
      : undefined;
    if (!platformKey || !authorizedUserIds) continue;

    const collected = collectRecentEntriesWithinHistorySpan({
      store: params.store,
      channelId: active.channelId,
      estimatedCount: memberEntryLimit,
      maxHistorySpanMs: params.maxHistorySpanMs,
      nowMs,
    });
    const allConversational = collected.entries.filter(entry => (
      (entry.role === 'user' || entry.role === 'assistant')
      && !isNonConversationalSessionEntry(entry)
    ));
    const memberUserEntries = allConversational.filter(entry => entry.role === 'user');
    // A physical channel joins only when every user speaker in its retained
    // history is one of the exact bonded identities for that platform. This
    // rejects same-platform alternate accounts and mixed group logs. An
    // assistant-only log cannot prove who the conversation belonged to.
    if (
      memberUserEntries.length === 0
      || memberUserEntries.some(entry => (
        typeof entry.authorId !== 'string'
        || !authorizedUserIds.has(entry.authorId.trim())
      ))
    ) {
      continue;
    }
    const conversational = allConversational.slice(-memberEntryLimit);
    if (conversational.length === 0) continue;

    // Member privacy is determined STRICTLY from the member's own persisted
    // visibility labels — never from a classifier default for a channel this
    // turn cannot see metadata for. No parseable label on any entry means the
    // member's privacy is undeterminable and the whole bond stays down.
    let memberPrivacy: ChannelPrivacy | undefined;
    for (let index = conversational.length - 1; index >= 0; index -= 1) {
      memberPrivacy = parseChannelVisibility(conversational[index].channelVisibility);
      if (memberPrivacy !== undefined) break;
    }
    if (memberPrivacy === undefined) return null;

    memberCandidates.push({
      channelId: active.channelId,
      disclosure: { channelPrivacy: memberPrivacy, broadcast: false },
      entries: conversational,
    });
  }
  if (memberCandidates.length === 0) return null;

  const currentDisclosure = classifyChannelDisclosure(params.sourceChannelId, params.channelMeta);
  const effectiveDisclosure = resolveEffectiveBondDisclosure([
    currentDisclosure,
    ...memberCandidates.map(member => member.disclosure),
  ]);
  if (!effectiveDisclosure) return null;

  const foreignEntries: SessionEntry[] = [];
  const contributingMembers = new Set<string>();
  for (const member of memberCandidates) {
    for (const entry of member.entries) {
      const entryVisibility = parseChannelVisibility(entry.channelVisibility);
      // An entry without a determinable persisted visibility never crosses.
      if (entryVisibility === undefined) continue;
      const sourceDisclosure: ChannelDisclosureContext = {
        channelPrivacy: entryVisibility,
        broadcast: false,
      };
      // Lowest-common enforcement: the source must flow into the bond's
      // effective disclosure AND into the current channel's disclosure, so
      // higher-privacy content never renders in a lower-privacy channel.
      if (!visibilitiesShareContinuity(sourceDisclosure, effectiveDisclosure)) continue;
      if (!visibilitiesShareContinuity(sourceDisclosure, currentDisclosure)) continue;
      const policy = evaluateMemoryPolicy({
        trustLevel: params.bond.trustLevel,
        channelPrivacy: effectiveDisclosure.channelPrivacy,
        broadcast: effectiveDisclosure.broadcast,
        memorySensitivity: getVisibilityDisclosureCeiling(sourceDisclosure),
      });
      if (policy.decision !== 'allow') continue;
      const metadata = buildMetadataWithBondMarker(entry.metadata, {
        kind: 'channel_bond',
        sourceChannelId: member.channelId,
        sourceVisibility: entryVisibility,
      });
      // Metadata that cannot be preserved (malformed envelope) fails closed.
      if (metadata === null) continue;
      foreignEntries.push({
        ...entry,
        // Foreign ids are namespaced out of the target channel's id space so
        // id-keyed machinery (current-turn exclusion, leak guard, compaction
        // coverage) can never bind them to own-channel entries. The `- 1` keeps
        // the id strictly negative even for a source id of 0 (`-0 < 0` is false
        // in JS), so the "foreign ids are always negative" contract holds for
        // every source id >= 0, not just BIGSERIAL ids >= 1.
        id: -Math.abs(entry.id) - 1,
        metadata,
        originChannelId: entry.originChannelId ?? entry.channelId,
      });
      contributingMembers.add(member.channelId);
    }
  }
  if (foreignEntries.length === 0) return null;

  // Drop own-log mirror notes whose source conversation is now interleaved
  // directly — the originals supersede the truncated mirror copies.
  let suppressedMirrorEntryCount = 0;
  const dedupedOwn = params.ownEntries.filter(entry => {
    if (entry.role !== 'system') return true;
    const mirror = parseMirrorMetadata(entry.metadata);
    if (!mirror || !contributingMembers.has(mirror.sourceChannelId)) return true;
    suppressedMirrorEntryCount += 1;
    return false;
  });

  return {
    entries: sortBondedTimelineEntries([...dedupedOwn, ...foreignEntries]),
    bondedEntryCount: foreignEntries.length,
    memberChannelIds: [...contributingMembers].sort((a, b) => a.localeCompare(b)),
    effectivePrivacy: effectiveDisclosure.channelPrivacy,
    suppressedMirrorEntryCount,
  };
}
