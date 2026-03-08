import type { SessionEntry } from '../session/types.js';
import { BOUNDARY_LOG_REFUSAL_PATTERNS, matchesRefusalPatterns } from '../security/refusal-patterns.js';
import type { ExtractedFact, PurrMemory } from './types.js';

const BOUNDARY_HINT_PATTERNS = [
  /\bboundar(?:y|ies)\b/i,
  /\bnot comfortable\b/i,
  /\bunsafe\b/i,
  /\bharmful\b/i,
  /\billegal\b/i,
  /\bprivacy\b/i,
];

const STOPWORD_TAGS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'can',
  'do',
  'for',
  'from',
  'help',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'should',
  'that',
  'the',
  'this',
  'to',
  'us',
  'we',
  'with',
  'you',
  'your',
]);

const USER_LOOKBACK_LIMIT = 6;
const MAX_FACTS_DEFAULT = 3;
const MAX_REQUEST_CHARS = 220;
const MAX_REFUSAL_CHARS = 220;
const MAX_DYNAMIC_TAGS = 6;

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeForSimilarity(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeForSimilarity(text)
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

function truncateForFact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function isLikelyRefusal(content: string): boolean {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return false;
  if (/\b(can(?:not|'t)|won't)\s+wait\b/i.test(normalized)) return false;

  const hasRefusalSignal = matchesRefusalPatterns(normalized, BOUNDARY_LOG_REFUSAL_PATTERNS);
  if (!hasRefusalSignal) return false;

  return BOUNDARY_HINT_PATTERNS.some(pattern => pattern.test(normalized))
    || /\b(help|assist|guide|provide|share|comply|request)\b/i.test(normalized);
}

function findNearestUserRequest(entries: readonly SessionEntry[], refusalIndex: number): string | null {
  let checkedUsers = 0;
  for (let index = refusalIndex - 1; index >= 0; index--) {
    const candidate = entries[index];
    if (candidate.role !== 'user') continue;

    checkedUsers++;
    const normalized = normalizeWhitespace(candidate.content);
    if (normalized.length > 0) return normalized;
    if (checkedUsers >= USER_LOOKBACK_LIMIT) break;
  }
  return null;
}

function extractDynamicTags(userRequest: string | null, assistantRefusal: string): string[] {
  const source = userRequest && userRequest.length > 0
    ? userRequest
    : assistantRefusal;

  const tags: string[] = [];
  for (const token of tokenize(source)) {
    if (token.length < 4 || STOPWORD_TAGS.has(token)) continue;
    if (tags.includes(token)) continue;
    tags.push(token);
    if (tags.length >= MAX_DYNAMIC_TAGS) break;
  }
  return tags;
}

function buildBoundaryFact(userRequest: string | null, assistantRefusal: string): ExtractedFact {
  const requestSummary = userRequest
    ? truncateForFact(userRequest, MAX_REQUEST_CHARS)
    : null;
  const refusalSummary = truncateForFact(assistantRefusal, MAX_REFUSAL_CHARS);

  const text = requestSummary
    ? `I declined a similar request before: "${requestSummary}". Refusal boundary: "${refusalSummary}".`
    : `I set a refusal boundary previously: "${refusalSummary}".`;

  const tags = Array.from(new Set([
    'boundary',
    'refusal',
    'safety',
    'cross_session',
    ...extractDynamicTags(userRequest, assistantRefusal),
  ]));

  return {
    text,
    type: 'boundary',
    importance: 0.98,
    emotionalValence: -0.1,
    confidence: 0.95,
    tags,
    sensitivity: 'personal',
  };
}

function hasBoundaryTag(tags: readonly string[]): boolean {
  return tags.some(tag => normalizeWhitespace(tag).toLowerCase() === 'boundary');
}

export function isBoundaryMemory(memory: Pick<PurrMemory, 'type' | 'tags'>): boolean {
  return memory.type === 'boundary' || hasBoundaryTag(memory.tags);
}

export interface BoundaryFactExtractionOptions {
  maxFacts?: number;
}

export function extractBoundaryFactsFromEntries(
  entries: readonly SessionEntry[],
  existingFacts: readonly ExtractedFact[] = [],
  options: BoundaryFactExtractionOptions = {},
): ExtractedFact[] {
  if (entries.length === 0) return [];

  const maxFacts = clampInteger(options.maxFacts ?? MAX_FACTS_DEFAULT, 1, 20);
  const seenFacts = new Set<string>(
    existingFacts
      .filter(fact => fact.type === 'boundary' || hasBoundaryTag(fact.tags))
      .map(fact => normalizeForSimilarity(fact.text))
      .filter(Boolean),
  );

  const extracted: ExtractedFact[] = [];

  for (const [index, entry] of entries.entries()) {
    if (entry.role !== 'assistant') continue;
    if (!isLikelyRefusal(entry.content)) continue;

    const refusal = normalizeWhitespace(entry.content);
    if (!refusal) continue;

    const request = findNearestUserRequest(entries, index);
    const candidate = buildBoundaryFact(request, refusal);
    const dedupeKey = normalizeForSimilarity(candidate.text);
    if (!dedupeKey || seenFacts.has(dedupeKey)) continue;

    seenFacts.add(dedupeKey);
    extracted.push(candidate);
  }

  if (extracted.length <= maxFacts) return extracted;
  return extracted.slice(-maxFacts);
}

export function computeBoundarySimilarityBoost(
  contextText: string,
  memory: Pick<PurrMemory, 'text' | 'tags'>,
): number {
  const queryTokens = tokenize(contextText).filter(token => token.length >= 3 && !STOPWORD_TAGS.has(token));
  if (queryTokens.length === 0) return 1;

  const memoryTokens = new Set<string>([
    ...tokenize(memory.text).filter(token => token.length >= 3),
    ...memory.tags.flatMap(tag => tokenize(tag).filter(token => token.length >= 3)),
  ]);
  if (memoryTokens.size === 0) return 1;

  let overlap = 0;
  for (const token of new Set(queryTokens)) {
    if (memoryTokens.has(token)) overlap++;
  }

  if (overlap === 0) return 1;
  const overlapRatio = overlap / new Set(queryTokens).size;
  return 1 + Math.min(0.65, overlapRatio * 0.85);
}
