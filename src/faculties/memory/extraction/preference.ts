import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact } from '../types.js';

const MAX_PREFERENCE_VALUE_CHARS = 96;
const GENERIC_SPEAKER_NAMES = new Set(['user', 'human', 'participant', 'speaker']);

type PreferencePolarity = 'favorite' | 'prefer' | 'like' | 'dislike';

interface PreferenceMatch {
  text: string;
  tags: string[];
  polarity: PreferencePolarity;
}

export interface ExplicitPreferenceExtractionOptions {
  fallbackSubjectName?: string;
}

export function extractExplicitPreferenceFactsFromEntries(
  entries: readonly SessionEntry[],
  options: ExplicitPreferenceExtractionOptions = {},
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content || content.includes('?')) continue;

    const subjectName = resolveSubjectName(entry, options.fallbackSubjectName);
    for (const match of extractPreferenceMatches(content, subjectName)) {
      const key = match.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        text: match.text,
        type: 'semantic',
        importance: match.polarity === 'favorite' ? 0.82 : 0.72,
        emotionalValence: match.polarity === 'dislike' ? -0.2 : 0.25,
        confidence: 0.9,
        tags: match.tags,
        retentionClass: 'durable',
        sensitivity: 'personal',
        attribution: {
          sourceMessageIds: [entry.id],
          sourceSpanStartMessageId: entry.id,
          sourceSpanEndMessageId: entry.id,
          ...(entry.authorName?.trim() ? { sourceSpeakerName: entry.authorName.trim() } : {}),
          subjectName,
          addressMode: 'direct_to_companion',
        },
      });
    }
  }

  return facts;
}

function extractPreferenceMatches(content: string, subjectName: string): PreferenceMatch[] {
  const normalized = content.trim();
  const matches: PreferenceMatch[] = [];

  collectFavoriteMatches(normalized, subjectName, matches);
  collectPreferenceVerbMatches(normalized, subjectName, matches);

  return matches;
}

function collectFavoriteMatches(
  content: string,
  subjectName: string,
  matches: PreferenceMatch[],
): void {
  for (const match of content.matchAll(/\bmy\s+favou?rite\s+([a-z][a-z0-9 -]{0,36}?)\s+(?:is|are|was|were)\s+([^.!?\n]{1,120})/gi)) {
    const category = normalizeCategory(match[1]);
    const value = normalizePreferenceValue(match[2]);
    if (!category || !value) continue;
    matches.push({
      text: `${possessive(subjectName)} favorite ${category} is ${value}.`,
      tags: preferenceTags('favorite', category),
      polarity: 'favorite',
    });
  }

  for (const match of content.matchAll(/\b([^.!?\n]{1,80}?)\s+(?:is|are|was|were)\s+my\s+favou?rite(?:\s+([a-z][a-z0-9 -]{0,36}))?/gi)) {
    const value = normalizePreferenceValue(match[1]);
    const category = normalizeCategory(match[2]);
    if (!value) continue;
    matches.push({
      text: category
        ? `${possessive(subjectName)} favorite ${category} is ${value}.`
        : `${possessive(subjectName)} favorite is ${value}.`,
      tags: preferenceTags('favorite', category),
      polarity: 'favorite',
    });
  }
}

function collectPreferenceVerbMatches(
  content: string,
  subjectName: string,
  matches: PreferenceMatch[],
): void {
  const patterns: Array<readonly [RegExp, PreferencePolarity, string]> = [
    [/\bi\s+(?:really\s+)?prefer\s+([^.!?\n]{1,120})/gi, 'prefer', 'prefers'],
    [/\bi\s+(?:really\s+)?(?:like|love|enjoy)\s+([^.!?\n]{1,120})/gi, 'like', 'likes'],
    [/\bi\s+(?:do not|don't)\s+like\s+([^.!?\n]{1,120})/gi, 'dislike', 'dislikes'],
    [/\bi\s+(?:really\s+)?(?:hate|dislike)\s+([^.!?\n]{1,120})/gi, 'dislike', 'dislikes'],
  ];

  for (const [pattern, polarity, verb] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = normalizePreferenceValue(match[1]);
      if (!value) continue;
      matches.push({
        text: `${subjectName} ${verb} ${value}.`,
        tags: preferenceTags(polarity, ''),
        polarity,
      });
    }
  }
}

function resolveSubjectName(entry: SessionEntry, fallbackSubjectName: string | undefined): string {
  const authorName = normalizeSpeakerName(entry.authorName);
  if (authorName) return authorName;
  const fallback = normalizeSpeakerName(fallbackSubjectName);
  return fallback ?? 'User';
}

function normalizeSpeakerName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (GENERIC_SPEAKER_NAMES.has(normalized.toLowerCase())) return undefined;
  return normalized;
}

function normalizeCategory(value: string | undefined): string {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(?:kind of|type of)\s+/, '')
    .replace(/[^a-z0-9 -]/g, '')
    .trim() ?? '';
}

function normalizePreferenceValue(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[;,]\s*(?:and|but|because)\b.*$/i, '')
    .replace(/\s+(?:for now|right now|today|tonight|this week)$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  if (!normalized || normalized.length > MAX_PREFERENCE_VALUE_CHARS) return null;
  if (/^(?:not sure|maybe|i don't know|do you know)\b/i.test(normalized)) return null;
  return normalized;
}

function preferenceTags(polarity: PreferencePolarity, category: string): string[] {
  const tags = ['preference'];
  if (polarity === 'favorite') tags.push('favorite');
  if (polarity === 'dislike') tags.push('dislike');
  const categoryTag = preferenceCategoryTag(category);
  if (categoryTag) tags.push(categoryTag);
  return tags;
}

function preferenceCategoryTag(category: string): string | null {
  const normalized = category.trim().toLowerCase();
  if (!normalized) return null;
  if (/\bcolou?r|palette|shade|hue\b/.test(normalized)) return 'preference:color';
  if (/\boutfit|clothes?|clothing|dress|shirt|jacket|wear\b/.test(normalized)) return 'preference:outfit';
  if (/\bmoment|memory|occasion|tradition|ritual\b/.test(normalized)) return 'preference:moment';
  if (/\bfood|meal|coffee|tea|drink|dessert|snack|restaurant|cuisine\b/.test(normalized)) return 'preference:food';
  return `preference:${normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}
