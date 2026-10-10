import type { ExtractionSourceSpeaker, TranscriptSpeaker } from './types.js';
import { resolveClearSourceSpeaker } from './implicit-speaker-routing.js';
import type { Contact } from '../../../core/contacts/types.js';
import { extractionContactNames } from './contact-resolution.js';
import { resolveSessionEntrySpeakerContactId } from '../../../core/session/speaker-attribution.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type {
  ExtractedFact,
  ExtractedFactAttribution,
  GroupMemoryAddressMode,
  MemoryScopeRef,
} from '../types.js';
import type { CogSecStructuredProvenanceRef } from '../../../shared/contracts/provenance-ref.js';
import { isExtractionTranscriptEntry } from './chunk-compose.js';
import {
  normalizeSpeakerPhrase,
  resolveCanonicalFactSubject,
  speakerMatchesName,
  validateStrictGroupAddressing,
} from './strict-group-routing.js';
import {
  classifySessionEntryCompanionRelevance,
  inferAddressMode,
  type FactRoutingOptions,
} from './message-address-mode.js';

export type { ExtractionSourceSpeaker } from './types.js';

export {
  classifySessionEntryCompanionRelevance,
  type FactRoutingOptions,
};

type ExtractionFactRoutingReason =
  | 'single_speaker_transcript'
  | 'speaker_name_prefix'
  | 'transcript_content_match'
  | 'structured_source_metadata'
  | 'unresolved_direct_subject'
  | 'structured_subject_metadata'
  | 'structured_room_context'
  | 'self_directed_companion'
  | 'conversational_companion';

export function isCompanionOwnedRouting(reason: ExtractionFactRoutingReason | undefined): boolean {
  return reason === 'conversational_companion' || reason === 'self_directed_companion';
}

export interface ExtractionFactRouting {
  triggerContactId?: string;
  routedContactId?: string;
  sourceContactId?: string;
  sourceAuthorId?: string;
  sourceSpeakerName?: string;
  subjectContactId?: string;
  subjectName?: string;
  addressMode?: GroupMemoryAddressMode;
  scopeRef?: MemoryScopeRef;
  scopeTags?: string[];
  sourceMessageIds?: number[];
  sourceSpanStartMessageId?: number;
  sourceSpanEndMessageId?: number;
  /** Latest source-message instant (epoch ms) of the routed fact's conversation. */
  sourceConversationAt?: number;
  /** Durable ICP relationship/activity lineage for the attributed source range. */
  icpDyadId?: string;
  sourceActivityIds?: string[];
  sourceTurnIds?: string[];
  /**
   * Admission identity of the source bytes this fact was attributed to
   * (psfn-framework-ccgdz.3). Resolved from the SAME envelope index the
   * memory_write sink gate reads, so the recorded provenance and the gate
   * decision describe one set of source bytes.
   */
  sourceAdmissions?: CogSecStructuredProvenanceRef[];
  /** `AutomataWorkerLineage.runId` of the extraction run that derived the fact. */
  derivationRunId?: string;
  routingReason: ExtractionFactRoutingReason;
}

export interface SpeakerRoutingContext {
  speakers: TranscriptSpeaker[];
  mixedHumanSpeakers: boolean;
  entries: SessionEntry[];
  contacts?: readonly Contact[];
}

export type FactRoutingDecision =
  | {
    status: 'route';
    contactId?: string;
    sourceContactId?: string;
    sourceAuthorId?: string;
    sourceSpeakerName?: string;
    subjectContactId?: string;
    subjectName?: string;
    addressMode?: GroupMemoryAddressMode;
    scopeRef?: MemoryScopeRef;
    scopeTags?: string[];
    sourceMessageIds?: number[];
    sourceSpanStartMessageId?: number;
    sourceSpanEndMessageId?: number;
    /** Latest source-message instant (epoch ms) of this fact's conversation. */
    sourceConversationAt?: number;
    reason: ExtractionFactRoutingReason;
  }
  | {
    status: 'skip';
    reason:
      | 'ambiguous_group_speaker'
      | 'unresolved_speaker_contact'
      | 'missing_structured_attribution'
      | 'missing_structured_addressing'
      | 'missing_source_message_ids'
      | 'ambiguous_source_message_ids'
      | 'conflicting_source_attribution'
      | 'conflicting_resolved_addressee'
      | 'missing_subject_attribution'
      | 'conflicting_subject_attribution'
      | 'conflicting_subject_addressee'
      | 'conflicting_subject_contact'
      | 'conflicting_observer_attribution'
      | 'unverified_direct_address'
      | 'unresolved_subject_contact';
    sourceSpeakerName?: string;
  };

export async function buildSpeakerRoutingContext(
  entries: readonly SessionEntry[],
  resolveSourceSpeakerContactId?: (speaker: ExtractionSourceSpeaker) => Promise<string | undefined>,
  options: {
    contacts?: readonly Contact[];
    canonicalContactId?: string;
    companionName?: string;
  } = {},
): Promise<SpeakerRoutingContext> {
  const speakers = collectTranscriptSpeakers(entries);
  for (const speaker of speakers) {
    const canonicalIds = new Set(speaker.entries.map(resolveSessionEntrySpeakerContactId).filter(Boolean));
    if (canonicalIds.size > 1) throw new Error('Conflicting canonical extraction speaker attribution');
    speaker.contactId = canonicalIds.values().next().value;
    if (!speaker.contactId && resolveSourceSpeakerContactId) {
      const contactId = await resolveSourceSpeakerContactId({
        name: speaker.name,
        ...(speaker.authorId ? { authorId: speaker.authorId } : {}),
      });
      if (contactId) speaker.contactId = contactId;
    }
    if (!speaker.contactId && speakers.length === 1) speaker.contactId = options.canonicalContactId;
    const contact = options.contacts?.find(item => item.id === speaker.contactId && !item.archivedAt);
    speaker.aliases = [...new Set([
      ...speaker.entries.flatMap(entry => entry.authorName ? [entry.authorName] : []),
      ...(contact ? extractionContactNames(contact) : []),
    ])];
  }

  const mixedHumanSpeakers = speakers.length > 1;
  if (options.companionName) {
    speakers.push({
      key: 'companion', name: options.companionName,
      normalizedName: normalizeSpeakerPhrase(options.companionName),
      companion: true,
      entries: entries.filter(entry => isExtractionTranscriptEntry(entry) && entry.role === 'assistant'),
    });
  }
  return {
    speakers,
    mixedHumanSpeakers,
    entries: entries.filter(isExtractionTranscriptEntry),
    contacts: options.contacts,
  };
}

/**
 * The latest message instant (epoch ms) across a set of source entries, or
 * undefined when none carry a usable timestamp. This is the safe upper bound on
 * the conversation's admission time for epoch resolution: it never post-dates the
 * conversation, so it excludes any channel demotion that happened after the last
 * message was sent (the deferred-extraction over-share, psfn-framework-qgqw.2).
 *
 * Exported so other conversation-time producers (sleeptime review, group
 * backfill) stamp `provenance.sourceConversationAt` from the SAME bound as the
 * extractor rather than from a later run clock (psfn-framework-ca980).
 */
export function latestSourceEntryTimestamp(entries: readonly SessionEntry[]): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    const ts = entry.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && (latest === undefined || ts > latest)) {
      latest = ts;
    }
  }
  return latest;
}

export function resolveFactRouting(
  fact: ExtractedFact,
  context: SpeakerRoutingContext,
  triggerContactId: string | undefined,
  options: FactRoutingOptions = {},
): FactRoutingDecision {
  // A turn contact is proof for the sole user in a direct conversation only.
  // Group extraction must continue to resolve each source independently.
  const routingContext = !options.requireStructuredAddressing
    && context.speakers.filter(speaker => !speaker.companion).length === 1
    && triggerContactId
    ? {
      ...context,
      speakers: context.speakers.map(speaker => ({
        ...speaker, contactId: speaker.companion ? undefined : speaker.contactId ?? triggerContactId,
      })),
    }
    : context;
  const conversationAt = latestSourceEntryTimestamp(routingContext.entries);
  const structuredRouting = resolveStructuredFactRouting(
    fact,
    routingContext,
    options,
  );
  if (structuredRouting) return structuredRouting;
  if (options.requireStructuredAddressing) {
    return { status: 'skip', reason: 'missing_structured_attribution' };
  }

  if (!routingContext.mixedHumanSpeakers) {
    const speaker = routingContext.speakers.find(speaker => !speaker.companion);
    return {
      status: 'route',
      ...(triggerContactId ? { contactId: triggerContactId } : {}),
      ...(speaker?.contactId ? { sourceContactId: speaker.contactId } : {}),
      ...(speaker?.authorId ? { sourceAuthorId: speaker.authorId } : {}),
      ...(speaker?.name ? { sourceSpeakerName: speaker.name } : {}),
      ...(speaker && speaker.entries.length > 0
        ? { addressMode: inferAddressMode(speaker.entries, options) }
        : {}),
      ...(conversationAt !== undefined ? { sourceConversationAt: conversationAt } : {}),
      reason: 'single_speaker_transcript',
    };
  }

  const match = resolveClearSourceSpeaker(fact, routingContext.speakers.filter(speaker => !speaker.companion));
  if (!match) {
    return { status: 'skip', reason: 'ambiguous_group_speaker' };
  }
  if (!match.speaker.contactId) {
    return {
      status: 'skip',
      reason: 'unresolved_speaker_contact',
      sourceSpeakerName: match.speaker.name,
    };
  }

  // Implicit (attribution-less) group routing must still carry the social-graph
  // evidence fields: the matched speaker IS the source contact, and the address
  // mode is inferable from that speaker's own entries. Without these, room
  // memories can never qualify as social-graph evidence (psfn-framework-0zd9).
  return {
    status: 'route',
    contactId: match.speaker.contactId,
    sourceContactId: match.speaker.contactId,
    ...(match.speaker.authorId ? { sourceAuthorId: match.speaker.authorId } : {}),
    sourceSpeakerName: match.speaker.name,
    ...(match.speaker.entries.length > 0
      ? { addressMode: inferAddressMode(match.speaker.entries, options) }
      : {}),
    ...(conversationAt !== undefined ? { sourceConversationAt: conversationAt } : {}),
    reason: match.reason,
  };
}

function resolveStructuredFactRouting(
  fact: ExtractedFact,
  context: SpeakerRoutingContext,
  options: FactRoutingOptions,
): FactRoutingDecision | undefined {
  const attribution = fact.attribution;
  if (!attribution) return undefined;

  if (
    options.requireStructuredAddressing
    && (
      !attribution.sourceMessageIds?.length
      || !attribution.sourceSpeakerName?.trim()
      || !attribution.addressMode
    )
  ) {
    return { status: 'skip', reason: 'missing_structured_attribution' };
  }

  const sourceEntries = resolveAttributionSourceEntries(attribution, context.entries);
  if (sourceEntries === null) {
    return options.requireStructuredAddressing
      ? { status: 'skip', reason: 'missing_structured_attribution' }
      : undefined;
  }
  if (sourceEntries.length === 0) {
    return { status: 'skip', reason: 'missing_source_message_ids' };
  }

  const citedSpeakers = resolveSourceSpeakers(sourceEntries, context.speakers);
  // In a direct user/assistant exchange, an explicit source selects the
  // evidence speaker. Without one, the sole human supplies the human evidence.
  // More than one human stays ambiguous, including outside the cited range.
  const humanSpeakers = citedSpeakers.filter(speaker => !speaker.companion);
  const sourceName = attribution.sourceSpeakerName;
  const sourceSpeakers = !options.requireStructuredAddressing
    && !context.mixedHumanSpeakers
    && citedSpeakers.some(speaker => speaker.companion)
    && humanSpeakers.length === 1
    ? sourceName
      ? citedSpeakers.filter(speaker => speakerMatchesName(speaker, sourceName, true))
      : humanSpeakers
    : citedSpeakers;
  if (sourceSpeakers.length !== 1) {
    return { status: 'skip', reason: 'ambiguous_source_message_ids' };
  }

  const sourceSpeaker = sourceSpeakers.at(0);
  if (!sourceSpeaker) {
    return { status: 'skip', reason: 'ambiguous_source_message_ids' };
  }
  if (
    attribution.sourceSpeakerName
    && !speakerMatchesName(sourceSpeaker, attribution.sourceSpeakerName, !options.requireStructuredAddressing)
  ) {
    return {
      status: 'skip',
      reason: 'conflicting_source_attribution',
      sourceSpeakerName: sourceSpeaker.name,
    };
  }
  if (!sourceSpeaker.contactId && !sourceSpeaker.companion) {
    return {
      status: 'skip',
      reason: 'unresolved_speaker_contact',
      sourceSpeakerName: sourceSpeaker.name,
    };
  }

  const groupAddressing = options.requireStructuredAddressing
    ? validateStrictGroupAddressing(fact, attribution, sourceEntries)
    : null;
  if (groupAddressing?.status === 'skip') {
    return {
      status: 'skip',
      reason: groupAddressing.reason,
      sourceSpeakerName: sourceSpeaker.name,
    };
  }

  const addressModeDecision = resolveStructuredAddressMode(
    attribution.addressMode,
    sourceEntries,
    options,
  );
  if (addressModeDecision.status === 'skip') {
    return {
      ...addressModeDecision,
      sourceSpeakerName: sourceSpeaker.name,
    };
  }

  const subjects = options.requireStructuredAddressing
    ? context.speakers
    : [
      ...context.speakers,
      ...(context.contacts ?? []).filter(contact => !contact.archivedAt
        && !context.speakers.some(speaker => speaker.contactId === contact.id))
        .map(contact => ({
          key: `contact:${contact.id}`, name: contact.displayName,
          normalizedName: normalizeSpeakerPhrase(contact.displayName),
          aliases: extractionContactNames(contact), contactId: contact.id, entries: [],
        })),
    ];
  const canonicalSubject = resolveCanonicalFactSubject<TranscriptSpeaker>(
    attribution, subjects, !options.requireStructuredAddressing,
  );
  if (canonicalSubject.status === 'skip') {
    return {
      status: 'skip',
      reason: canonicalSubject.reason,
      sourceSpeakerName: sourceSpeaker.name,
    };
  }
  const subject = canonicalSubject.speaker;
  if (subject?.companion) {
    return buildStructuredRoute({
      attribution, sourceSpeaker, sourceEntries,
      addressMode: addressModeDecision.addressMode,
      reason: 'conversational_companion', subjectName: subject.name,
    });
  }
  // The companion's paraphrase alone is not confirmation of a human fact.
  if (sourceSpeaker.companion && !sourceEntries.some(entry => entry.role === 'user')) {
    return { status: 'skip', reason: 'unresolved_subject_contact', sourceSpeakerName: sourceSpeaker.name };
  }
  const roomContextScope = resolveRoomContextScope(attribution, context.entries);
  const subjectContactId = subject?.contactId;
  // Group subjects must resolve independently. In a DM, an unknown third
  // party can retain source ownership and an unbound subject name until the
  // governed mention-contact path has enough evidence to create a contact.
  if (attribution.subjectName && !subjectContactId) {
    if (roomContextScope) {
      return buildStructuredRoute({
        attribution,
        sourceSpeaker,
        sourceEntries,
        addressMode: addressModeDecision.addressMode,
        reason: 'structured_room_context',
        subjectName: attribution.subjectName,
        scopeRef: roomContextScope,
        scopeTags: ['group_memory', 'room_context'],
      });
    }
    if (groupAddressing?.addressedParticipantNames.some(name => (
      normalizeSpeakerPhrase(name) === normalizeSpeakerPhrase(attribution.subjectName ?? '')
    ))) {
      return buildStructuredRoute({
        attribution,
        sourceSpeaker,
        sourceEntries,
        addressMode: addressModeDecision.addressMode,
        reason: 'structured_source_metadata',
        contactId: sourceSpeaker.contactId,
        subjectName: attribution.subjectName,
      });
    }
    if (
      !options.requireStructuredAddressing
      && !context.mixedHumanSpeakers
      && !subject
      && sourceSpeaker.contactId
    ) {
      return buildStructuredRoute({
        attribution, sourceSpeaker, sourceEntries,
        addressMode: addressModeDecision.addressMode,
        reason: 'unresolved_direct_subject', contactId: sourceSpeaker.contactId,
        subjectName: attribution.subjectName,
      });
    }
    return {
      status: 'skip',
      reason: 'unresolved_subject_contact',
      sourceSpeakerName: sourceSpeaker.name,
    };
  }

  const routedContactId = subjectContactId ?? sourceSpeaker.contactId;

  return buildStructuredRoute({
    attribution,
    sourceSpeaker,
    sourceEntries,
    addressMode: addressModeDecision.addressMode,
    reason: subjectContactId && subjectContactId !== sourceSpeaker.contactId
      ? 'structured_subject_metadata'
      : 'structured_source_metadata',
    contactId: routedContactId,
    ...(subjectContactId ? { subjectContactId } : {}),
    ...(attribution.subjectName ?? subject?.name
      ? { subjectName: attribution.subjectName ?? subject?.name }
      : {}),
  });
}

function resolveStructuredAddressMode(
  claimedAddressMode: GroupMemoryAddressMode | undefined,
  sourceEntries: readonly SessionEntry[],
  options: FactRoutingOptions,
): { status: 'route'; addressMode: GroupMemoryAddressMode } | {
  status: 'skip';
  reason: 'unverified_direct_address';
} {
  const inferredAddressMode = inferAddressMode(sourceEntries, options);
  if (!options.requireStructuredAddressing) {
    return {
      status: 'route',
      addressMode: claimedAddressMode ?? inferredAddressMode,
    };
  }
  if (
    claimedAddressMode === 'direct_to_companion'
    && inferredAddressMode !== 'direct_to_companion'
  ) {
    return { status: 'skip', reason: 'unverified_direct_address' };
  }
  return { status: 'route', addressMode: inferredAddressMode };
}

function buildStructuredRoute(params: {
  attribution: ExtractedFactAttribution;
  sourceSpeaker: TranscriptSpeaker;
  sourceEntries: readonly SessionEntry[];
  addressMode: GroupMemoryAddressMode;
  reason: ExtractionFactRoutingReason;
  contactId?: string;
  subjectContactId?: string;
  subjectName?: string;
  scopeRef?: MemoryScopeRef;
  scopeTags?: string[];
}): Extract<FactRoutingDecision, { status: 'route' }> {
  const sourceMessageIds = params.sourceEntries
    .map(entry => entry.id)
    .sort((left, right) => left - right);
  const sourceSpanStartMessageId =
    params.attribution.sourceSpanStartMessageId ?? sourceMessageIds[0];
  const sourceSpanEndMessageId =
    params.attribution.sourceSpanEndMessageId ?? sourceMessageIds.at(-1);
  // Per-fact conversation instant: the latest of THIS fact's attributed source
  // messages (the tightest safe bound) rather than the whole transcript window.
  const sourceConversationAt = latestSourceEntryTimestamp(params.sourceEntries);

  return {
    status: 'route',
    ...(params.contactId ? { contactId: params.contactId } : {}),
    ...(params.sourceSpeaker.contactId
      ? { sourceContactId: params.sourceSpeaker.contactId }
      : {}),
    ...(params.sourceSpeaker.authorId ? { sourceAuthorId: params.sourceSpeaker.authorId } : {}),
    sourceSpeakerName: params.sourceSpeaker.name,
    ...(params.subjectContactId ? { subjectContactId: params.subjectContactId } : {}),
    ...(params.subjectName ? { subjectName: params.subjectName } : {}),
    addressMode: params.addressMode,
    ...(params.scopeRef ? { scopeRef: params.scopeRef } : {}),
    ...(params.scopeTags ? { scopeTags: params.scopeTags } : {}),
    sourceMessageIds,
    ...(sourceSpanStartMessageId ? { sourceSpanStartMessageId } : {}),
    ...(sourceSpanEndMessageId ? { sourceSpanEndMessageId } : {}),
    ...(sourceConversationAt !== undefined ? { sourceConversationAt } : {}),
    reason: params.reason,
  };
}

const ROOM_CONTEXT_SUBJECTS = new Set([
  'room',
  'channel',
  'group',
  'group chat',
  'chat',
  'conversation',
  'thread',
  'server',
  'community',
  'social context',
  'room context',
]);

function resolveRoomContextScope(
  attribution: ExtractedFactAttribution,
  entries: readonly SessionEntry[],
): MemoryScopeRef | undefined {
  const normalizedSubject = normalizeSpeakerPhrase(attribution.subjectName ?? '');
  if (!ROOM_CONTEXT_SUBJECTS.has(normalizedSubject)) return undefined;
  const channelId = entries.at(0)?.channelId.trim();
  if (!channelId) return undefined;
  return {
    kind: 'conversation',
    id: channelId,
    label: `Group room ${channelId}`,
  };
}

function resolveAttributionSourceEntries(
  attribution: ExtractedFactAttribution,
  entries: readonly SessionEntry[],
): SessionEntry[] | null {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (attribution.sourceMessageIds && attribution.sourceMessageIds.length > 0) {
    const resolved = attribution.sourceMessageIds.map(id => byId.get(id));
    return resolved.every((entry): entry is SessionEntry => Boolean(entry))
      ? resolved
      : [];
  }
  const spanStart = attribution.sourceSpanStartMessageId;
  const spanEnd = attribution.sourceSpanEndMessageId;
  if (spanStart !== undefined && spanEnd !== undefined) {
    return entries.filter(entry => (
      entry.id >= spanStart
      && entry.id <= spanEnd
    ));
  }
  return null;
}

function resolveSourceSpeakers(
  sourceEntries: readonly SessionEntry[],
  speakers: readonly TranscriptSpeaker[],
): TranscriptSpeaker[] {
  const speakersByKey = new Map(speakers.map(speaker => [speaker.key, speaker]));
  const sourceKeys = new Set<string>();
  for (const entry of sourceEntries) {
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    const key = speakerKeyForEntry(entry);
    if (key) sourceKeys.add(key);
  }
  return [...sourceKeys]
    .map(key => speakersByKey.get(key))
    .filter((speaker): speaker is TranscriptSpeaker => Boolean(speaker));
}

function collectTranscriptSpeakers(entries: readonly SessionEntry[]): TranscriptSpeaker[] {
  const speakersByKey = new Map<string, TranscriptSpeaker>();

  for (const entry of entries) {
    if (!isExtractionTranscriptEntry(entry) || entry.role !== 'user') continue;
    const authorId = entry.authorId?.trim();
    const name = entry.authorName?.trim() || authorId || 'user';
    const normalizedName = normalizeSpeakerPhrase(name);
    const key = speakerKeyForEntry(entry);
    if (!key) continue;
    const existing = speakersByKey.get(key);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }

    speakersByKey.set(key, {
      key,
      name,
      normalizedName,
      ...(authorId ? { authorId } : {}),
      entries: [entry],
    });
  }

  return [...speakersByKey.values()];
}

function speakerKeyForEntry(entry: SessionEntry): string | undefined {
  if (entry.role === 'assistant') return 'companion';
  const authorId = entry.authorId?.trim();
  if (authorId) return `author:${authorId}`;
  const normalizedName = normalizeSpeakerPhrase(entry.authorName?.trim() || 'user');
  return normalizedName ? `name:${normalizedName}` : undefined;
}
