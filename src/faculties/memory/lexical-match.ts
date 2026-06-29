import type { PurrMemory } from './types.js';

const LEXICAL_QUERY_MAX_TOKENS = 10;
const LEXICAL_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'with',
  'you',
  'your',
]);

export function normalizeLexicalMemoryQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenizeLexicalMemoryQuery(query: string): string[] {
  const normalized = normalizeLexicalMemoryQuery(query);
  if (!normalized) return [];

  const rawTokens = normalized.match(/[a-z0-9']+/g) ?? [];
  const unique: string[] = [];
  for (const token of rawTokens) {
    if (token.length < 3) continue;
    if (LEXICAL_STOPWORDS.has(token)) continue;
    if (unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= LEXICAL_QUERY_MAX_TOKENS) break;
  }

  if (unique.length > 0) return unique;

  for (const token of rawTokens) {
    if (token.length < 2) continue;
    if (LEXICAL_STOPWORDS.has(token)) continue;
    if (unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= LEXICAL_QUERY_MAX_TOKENS) break;
  }
  return unique;
}

export function scoreLexicalMemoryMatch(
  memory: Pick<PurrMemory, 'text' | 'tags' | 'extractedAt' | 'salience' | 'importance'>,
  tokens: readonly string[],
  normalizedQuery: string,
): number {
  if (tokens.length === 0) return 0;
  const text = memory.text.toLowerCase();
  const tags = memory.tags.map(tag => tag.toLowerCase());

  let tokenHits = 0;
  for (const token of tokens) {
    if (text.includes(token)) {
      tokenHits += 1;
      continue;
    }
    if (tags.some(tag => tag.includes(token))) {
      tokenHits += 0.75;
    }
  }

  if (tokenHits <= 0) return 0;

  const coverage = Math.min(1, tokenHits / tokens.length);
  const phraseBonus = normalizedQuery.length >= 3 && text.includes(normalizedQuery) ? 0.3 : 0;
  const recencyDays = Math.max(0, (Date.now() - memory.extractedAt) / (1000 * 60 * 60 * 24));
  const recencyBoost = 1 / (1 + recencyDays / 90);
  const salienceBoost = Math.max(0, Math.min(0.2, memory.salience * 0.2));
  const importanceBoost = Math.max(0, Math.min(0.2, memory.importance * 0.2));

  return Math.min(1.5, coverage + phraseBonus + recencyBoost * 0.2 + salienceBoost + importanceBoost);
}

export function lexicalMemoryScoreToSimilarity(score: number): number {
  const normalized = Math.max(0, Math.min(1, score));
  return Math.max(0.3, Math.min(0.98, 0.3 + normalized * 0.68));
}
