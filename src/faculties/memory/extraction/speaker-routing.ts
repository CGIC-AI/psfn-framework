import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact } from '../types.js';
import { isExtractionTranscriptEntry } from './chunk-compose.js';

type ExtractionFactRoutingReason =
  | 'single_speaker_transcript'
  | 'speaker_name_prefix'
  | 'transcript_content_match';

export interface ExtractionSourceSpeaker {
  name: string;
  authorId?: string;
}

export interface ExtractionFactRouting {
  triggerContactId?: string;
  routedContactId?: string;
  sourceSpeakerName?: string;
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
}

export type FactRoutingDecision =
  | {
    status: 'route';
    contactId?: string;
    sourceSpeakerName?: string;
    reason: ExtractionFactRoutingReason;
  }
  | {
    status: 'skip';
    reason: 'ambiguous_group_speaker' | 'unresolved_speaker_contact';
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
  };
}

export function resolveFactRouting(
  fact: ExtractedFact,
  context: SpeakerRoutingContext,
  triggerContactId: string | undefined,
): FactRoutingDecision {
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

function collectTranscriptSpeakers(entries: readonly SessionEntry[]): TranscriptSpeaker[] {
  const speakersByKey = new Map<string, TranscriptSpeaker>();

  for (const entry of entries) {
    if (!isExtractionTranscriptEntry(entry) || entry.role !== 'user') continue;
    const authorId = entry.authorId?.trim();
    const name = entry.authorName?.trim() || authorId || 'user';
    const normalizedName = normalizeSpeakerPhrase(name);
    const key = authorId ? `author:${authorId}` : `name:${normalizedName}`;
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

function resolveClearSourceSpeaker(
  fact: ExtractedFact,
  speakers: readonly TranscriptSpeaker[],
): { speaker: TranscriptSpeaker; reason: ExtractionFactRoutingReason } | undefined {
  const prefixMatches = speakers.filter(speaker => factHasSpeakerAttributionPrefix(fact.text, speaker));
  if (prefixMatches.length === 1) {
    return {
      speaker: prefixMatches[0],
      reason: 'speaker_name_prefix',
    };
  }
  if (prefixMatches.length > 1) return undefined;

  const contentMatch = resolveTranscriptContentSpeaker(fact.text, speakers);
  return contentMatch
    ? { speaker: contentMatch, reason: 'transcript_content_match' }
    : undefined;
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
  's',
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
