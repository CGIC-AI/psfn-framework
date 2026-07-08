import type { SessionEntry } from '../../../core/session/types.js';
import type {
  ExtractedFact,
  ExtractedFactAttribution,
  GroupMemoryAddressMode,
  MemoryScopeRef,
} from '../types.js';
import { isRecord } from '../../../shared/utils/types.js';
import { isExtractionTranscriptEntry } from './chunk-compose.js';

type ExtractionFactRoutingReason =
  | 'single_speaker_transcript'
  | 'speaker_name_prefix'
  | 'transcript_content_match'
  | 'structured_source_metadata'
  | 'structured_subject_metadata'
  | 'structured_room_context';

export interface ExtractionSourceSpeaker {
  name: string;
  authorId?: string;
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
  routingReason: ExtractionFactRoutingReason;
}

interface TranscriptSpeaker {
  key: string;
  name: string;
  normalizedName: string;
  authorId?: string;
  entries: SessionEntry[];
  contactId?: string;
}

export interface SpeakerRoutingContext {
  speakers: TranscriptSpeaker[];
  mixedHumanSpeakers: boolean;
  entries: SessionEntry[];
}

export interface FactRoutingOptions {
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
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
    reason: ExtractionFactRoutingReason;
  }
  | {
    status: 'skip';
    reason:
      | 'ambiguous_group_speaker'
      | 'unresolved_speaker_contact'
      | 'missing_source_message_ids'
      | 'ambiguous_source_message_ids'
      | 'conflicting_source_attribution'
      | 'unresolved_subject_contact';
    sourceSpeakerName?: string;
  };

export async function buildSpeakerRoutingContext(
  entries: readonly SessionEntry[],
  resolveSourceSpeakerContactId?: (speaker: ExtractionSourceSpeaker) => Promise<string | undefined>,
): Promise<SpeakerRoutingContext> {
  const speakers = collectTranscriptSpeakers(entries);
  if (resolveSourceSpeakerContactId) {
    for (const speaker of speakers) {
      const contactId = await resolveSourceSpeakerContactId({
        name: speaker.name,
        ...(speaker.authorId ? { authorId: speaker.authorId } : {}),
      });
      if (contactId) speaker.contactId = contactId;
    }
  }

  return {
    speakers,
    mixedHumanSpeakers: speakers.length > 1,
    entries: entries.filter(isExtractionTranscriptEntry),
  };
}

export function resolveFactRouting(
  fact: ExtractedFact,
  context: SpeakerRoutingContext,
  triggerContactId: string | undefined,
  options: FactRoutingOptions = {},
): FactRoutingDecision {
  const structuredRouting = resolveStructuredFactRouting(
    fact,
    context,
    options,
  );
  if (structuredRouting) return structuredRouting;

  if (!context.mixedHumanSpeakers) {
    const speakerName = context.speakers.at(0)?.name;
    return {
      status: 'route',
      ...(triggerContactId ? { contactId: triggerContactId } : {}),
      ...(speakerName ? { sourceSpeakerName: speakerName } : {}),
      reason: 'single_speaker_transcript',
    };
  }

  const match = resolveClearSourceSpeaker(fact, context.speakers);
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

  return {
    status: 'route',
    contactId: match.speaker.contactId,
    sourceSpeakerName: match.speaker.name,
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

  const sourceEntries = resolveAttributionSourceEntries(attribution, context.entries);
  if (sourceEntries === null) return undefined;
  if (sourceEntries.length === 0) {
    return { status: 'skip', reason: 'missing_source_message_ids' };
  }

  const sourceSpeakers = resolveSourceSpeakers(sourceEntries, context.speakers);
  if (sourceSpeakers.length !== 1) {
    return { status: 'skip', reason: 'ambiguous_source_message_ids' };
  }

  const sourceSpeaker = sourceSpeakers[0];
  if (
    attribution.sourceSpeakerName
    && normalizeSpeakerPhrase(attribution.sourceSpeakerName) !== sourceSpeaker.normalizedName
  ) {
    return {
      status: 'skip',
      reason: 'conflicting_source_attribution',
      sourceSpeakerName: sourceSpeaker.name,
    };
  }
  if (!sourceSpeaker.contactId) {
    return {
      status: 'skip',
      reason: 'unresolved_speaker_contact',
      sourceSpeakerName: sourceSpeaker.name,
    };
  }

  const subject = resolveSubjectSpeaker(attribution, context.speakers);
  const roomContextScope = resolveRoomContextScope(attribution, context.entries);
  const subjectContactId = attribution.subjectContactId ?? subject?.contactId;
  // A named subject whose contact could not be resolved — either no matching
  // speaker, or a name-matched speaker that still lacks a contactId — must not
  // fall back to the source speaker's contact, or the subject's fact would be
  // misattributed to the source. Route room-scoped context where applicable,
  // otherwise skip.
  if (attribution.subjectName && !subjectContactId) {
    if (roomContextScope) {
      return buildStructuredRoute({
        attribution,
        sourceSpeaker,
        sourceEntries,
        addressMode: attribution.addressMode ?? inferAddressMode(sourceEntries, options),
        reason: 'structured_room_context',
        subjectName: attribution.subjectName,
        scopeRef: roomContextScope,
        scopeTags: ['group_memory', 'room_context'],
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
    addressMode: attribution.addressMode ?? inferAddressMode(sourceEntries, options),
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
    return attribution.sourceMessageIds
      .map(id => byId.get(id))
      .filter((entry): entry is SessionEntry => Boolean(entry));
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
    if (entry.role !== 'user') continue;
    const key = speakerKeyForEntry(entry);
    if (key) sourceKeys.add(key);
  }
  return [...sourceKeys]
    .map(key => speakersByKey.get(key))
    .filter((speaker): speaker is TranscriptSpeaker => Boolean(speaker));
}

function resolveSubjectSpeaker(
  attribution: ExtractedFactAttribution,
  speakers: readonly TranscriptSpeaker[],
): TranscriptSpeaker | undefined {
  if (attribution.subjectContactId) {
    return speakers.find(speaker => speaker.contactId === attribution.subjectContactId);
  }
  if (!attribution.subjectName) return undefined;
  const normalizedSubject = normalizeSpeakerPhrase(attribution.subjectName);
  if (!normalizedSubject) return undefined;
  const matches = speakers.filter(speaker => speaker.normalizedName === normalizedSubject);
  return matches.length === 1 ? matches[0] : undefined;
}

export type SessionEntryCompanionRelevance =
  | 'companion_turn'
  | 'reply_to_companion'
  | 'direct_to_companion'
  | 'mention_of_companion'
  | 'not_relevant';

/**
 * Deterministic per-entry companion-relevance classification for background
 * gating (E5.3). Reuses the same addressing/mention detection as group fact
 * routing (`inferAddressMode`) instead of growing a parallel detector:
 *
 * - the companion's own turns are relevant (conversation with her);
 * - replies to the companion, direct address, and mentions are relevant;
 * - async group traffic between other members is NOT relevant on its own.
 */
export function classifySessionEntryCompanionRelevance(
  entry: SessionEntry,
  options: FactRoutingOptions,
): SessionEntryCompanionRelevance {
  if (entry.role === 'assistant') {
    return 'companion_turn';
  }
  if (entry.role !== 'user') {
    return 'not_relevant';
  }
  if (isReplyToCompanion(entry, options)) {
    return 'reply_to_companion';
  }
  if (isDirectCompanionAddress(entry, options)) {
    return 'direct_to_companion';
  }
  if (containsCompanionMention(entry, options)) {
    return 'mention_of_companion';
  }
  return 'not_relevant';
}

function isReplyToCompanion(entry: SessionEntry, options: FactRoutingOptions): boolean {
  const companionAuthorIds = options.companionAuthorIds ?? [];
  if (companionAuthorIds.length === 0) return false;
  const metadata = parseEntryMetadata(entry);
  const replyAuthorId = normalizeOptionalMetadataString(metadata?.replyToAuthorId)
    ?? normalizeOptionalMetadataString(metadata?.referencedMessageAuthorId);
  return replyAuthorId !== undefined && companionAuthorIds.includes(replyAuthorId);
}

function inferAddressMode(
  sourceEntries: readonly SessionEntry[],
  options: FactRoutingOptions,
): GroupMemoryAddressMode {
  if (sourceEntries.some(entry => entry.role === 'system' || entry.role === 'tool')) {
    return 'system_api';
  }
  if (sourceEntries.some(entry => isReplyToUser(entry))) {
    return 'reply_to_user';
  }
  if (sourceEntries.some(entry => isDirectCompanionAddress(entry, options))) {
    return 'direct_to_companion';
  }
  if (sourceEntries.some(entry => containsCompanionMention(entry, options))) {
    return 'mention_of_companion';
  }
  return 'overheard_room_context';
}

function isReplyToUser(entry: SessionEntry): boolean {
  const metadata = parseEntryMetadata(entry);
  return Boolean(
    normalizeOptionalMetadataString(metadata?.replyToAuthorId)
    || normalizeOptionalMetadataString(metadata?.referencedMessageAuthorId)
    || normalizeOptionalMetadataString(metadata?.replyToMessageId)
    || normalizeOptionalMetadataString(metadata?.referencedMessageId),
  );
}

function isDirectCompanionAddress(entry: SessionEntry, options: FactRoutingOptions): boolean {
  const content = entry.content.trim();
  if (options.companionAuthorIds?.some(authorId => content.startsWith(`<@${authorId}>`))) {
    return true;
  }
  const normalized = normalizeSpeakerPhrase(content);
  return buildCompanionAliases(options.companionNames).some(alias => (
    normalized === alias || normalized.startsWith(`${alias} `)
  ));
}

function containsCompanionMention(entry: SessionEntry, options: FactRoutingOptions): boolean {
  const content = entry.content;
  if (options.companionAuthorIds?.some(authorId => content.includes(`<@${authorId}>`))) {
    return true;
  }
  const normalized = normalizeSpeakerPhrase(content);
  return buildCompanionAliases(options.companionNames)
    .some(alias => hasSpeakerWord(normalized, alias));
}

function buildCompanionAliases(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? [])
    .map(name => normalizeSpeakerPhrase(name))
    .filter(Boolean))];
}

function hasSpeakerWord(normalized: string, word: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(word)}(\\s|$)`).test(normalized);
}

function parseEntryMetadata(entry: SessionEntry): Record<string, unknown> | undefined {
  if (!entry.metadata) return undefined;
  try {
    const parsed = JSON.parse(entry.metadata) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalMetadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  const authorId = entry.authorId?.trim();
  if (authorId) return `author:${authorId}`;
  const normalizedName = normalizeSpeakerPhrase(entry.authorName?.trim() || 'user');
  return normalizedName ? `name:${normalizedName}` : undefined;
}

function resolveClearSourceSpeaker(
  fact: ExtractedFact,
  speakers: readonly TranscriptSpeaker[],
): { speaker: TranscriptSpeaker; reason: ExtractionFactRoutingReason } | undefined {
  const prefixMatches = speakers.filter(speaker => factHasSpeakerAttributionPrefix(fact.text, speaker));
  if (prefixMatches.length === 1) {
    if (factMentionsOtherSpeaker(fact.text, prefixMatches[0], speakers)) return undefined;
    return {
      speaker: prefixMatches[0],
      reason: 'speaker_name_prefix',
    };
  }
  if (prefixMatches.length > 1) return undefined;

  const contentMatch = resolveTranscriptContentSpeaker(fact.text, speakers);
  if (contentMatch && factMentionsOtherSpeaker(fact.text, contentMatch, speakers)) {
    return undefined;
  }
  return contentMatch
    ? { speaker: contentMatch, reason: 'transcript_content_match' }
    : undefined;
}

function factMentionsOtherSpeaker(
  factText: string,
  sourceSpeaker: TranscriptSpeaker,
  speakers: readonly TranscriptSpeaker[],
): boolean {
  const normalizedFact = normalizeSpeakerPhrase(factText);
  if (!normalizedFact) return false;
  return speakers.some(speaker => (
    speaker.key !== sourceSpeaker.key
    && speaker.normalizedName
    && hasSpeakerWord(normalizedFact, speaker.normalizedName)
  ));
}

const ATTRIBUTION_START_WORDS = new Set([
  'asked',
  'asks',
  'believe',
  'believes',
  'directly',
  'dislike',
  'dislikes',
  'enjoy',
  'enjoys',
  'feel',
  'feels',
  'felt',
  'had',
  'has',
  'have',
  'is',
  'like',
  'likes',
  'mention',
  'mentioned',
  'mentions',
  'need',
  'needed',
  'needs',
  'note',
  'noted',
  'notes',
  'oppose',
  'opposes',
  'prefer',
  'prefers',
  'report',
  'reported',
  'reports',
  'said',
  'says',
  'state',
  'stated',
  'states',
  'support',
  'supports',
  'think',
  'thinks',
  'use',
  'uses',
  'want',
  'wants',
  'was',
  'work',
  'works',
  'worry',
  'worries',
]);

function factHasSpeakerAttributionPrefix(factText: string, speaker: TranscriptSpeaker): boolean {
  if (!speaker.normalizedName) return false;
  const normalizedFact = normalizeSpeakerPhrase(factText);
  if (!normalizedFact) return false;

  const accordingPrefix = `according to ${speaker.normalizedName}`;
  if (normalizedFact === accordingPrefix || normalizedFact.startsWith(`${accordingPrefix} `)) {
    return true;
  }

  if (normalizedFact === speaker.normalizedName) return true;
  if (!normalizedFact.startsWith(`${speaker.normalizedName} `)) return false;

  const afterName = normalizedFact.slice(speaker.normalizedName.length).trim();
  const firstWord = afterName.split(' ')[0] ?? '';
  return ATTRIBUTION_START_WORDS.has(firstWord);
}

function resolveTranscriptContentSpeaker(
  factText: string,
  speakers: readonly TranscriptSpeaker[],
): TranscriptSpeaker | undefined {
  const speakerNameTokens = collectSpeakerNameTokens(speakers);
  const factTokens = tokenizeForSourceMatch(factText, speakerNameTokens);
  if (factTokens.size < 3) return undefined;

  const scores = speakers
    .map(speaker => scoreSpeakerContentMatch(speaker, factTokens, speakerNameTokens))
    .sort((left, right) => (
      right.overlap - left.overlap
        || right.ratio - left.ratio
        || left.speaker.key.localeCompare(right.speaker.key)
    ));
  const best = scores[0];
  if (best.overlap < 3 || best.ratio < 0.45) return undefined;

  const second = scores[1];
  if (best.overlap - second.overlap < 2) return undefined;

  return best.speaker;
}

function scoreSpeakerContentMatch(
  speaker: TranscriptSpeaker,
  factTokens: ReadonlySet<string>,
  speakerNameTokens: ReadonlySet<string>,
): { speaker: TranscriptSpeaker; overlap: number; ratio: number } {
  let bestOverlap = 0;
  let bestRatio = 0;

  for (const entry of speaker.entries) {
    const entryTokens = tokenizeForSourceMatch(entry.content, speakerNameTokens);
    if (entryTokens.size === 0) continue;
    let overlap = 0;
    for (const token of entryTokens) {
      if (factTokens.has(token)) overlap++;
    }
    const ratio = overlap / Math.min(entryTokens.size, factTokens.size);
    if (overlap > bestOverlap || (overlap === bestOverlap && ratio > bestRatio)) {
      bestOverlap = overlap;
      bestRatio = ratio;
    }
  }

  return {
    speaker,
    overlap: bestOverlap,
    ratio: bestRatio,
  };
}

function collectSpeakerNameTokens(speakers: readonly TranscriptSpeaker[]): Set<string> {
  const tokens = new Set<string>();
  for (const speaker of speakers) {
    for (const token of normalizeSpeakerPhrase(speaker.name).split(' ')) {
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

const SOURCE_MATCH_STOPWORDS = new Set([
  'about',
  'also',
  'and',
  'are',
  'because',
  'been',
  'being',
  'believe',
  'believes',
  'but',
  'can',
  'could',
  'did',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'her',
  'him',
  'his',
  'i',
  'if',
  'into',
  'its',
  'mean',
  'not',
  'our',
  'said',
  'says',
  'she',
  'that',
  'the',
  'their',
  'them',
  'then',
  'they',
  'this',
  'was',
  'were',
  'with',
  'would',
  'you',
]);

function tokenizeForSourceMatch(
  text: string,
  speakerNameTokens: ReadonlySet<string>,
): Set<string> {
  const normalized = normalizeSpeakerPhrase(text)
    .replace(/\byt\b/g, 'youtube')
    .replace(/\byoutube\b/g, 'youtube')
    .replace(/\byou tube\b/g, 'youtube')
    .replace(/\bticktok\b/g, 'tiktok');
  const tokens = new Set<string>();

  for (const rawToken of normalized.split(' ')) {
    const token = normalizeSourceMatchToken(rawToken);
    if (!token || token.length < 3) continue;
    if (SOURCE_MATCH_STOPWORDS.has(token)) continue;
    if (speakerNameTokens.has(token)) continue;
    tokens.add(token);
  }

  return tokens;
}

function normalizeSourceMatchToken(token: string): string {
  if (token === 'needed') return 'need';
  if (token === 'needs') return 'need';
  if (token === 'putting') return 'put';
  return token;
}

function normalizeSpeakerPhrase(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
