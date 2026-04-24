import type Database from 'better-sqlite3';
import { normalizeMemoryScopeQuery, type MemoryScopeQuery, type PurrMemory } from '../types.js';
import { mapMemoryRow } from './mappers.js';
import { buildScopeQuerySql } from './trust-filters.js';
import type { MemoryRow, MemorySearchResult } from './types.js';

const LEXICAL_QUERY_MAX_TOKENS = 10;
const LEXICAL_SCAN_MAX_ROWS = 500;
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

function normalizeListLimit(
  limit: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

function normalizeLexicalQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeLexicalQuery(query: string): string[] {
  const normalized = normalizeLexicalQuery(query);
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

function scoreLexicalMatch(
  memory: PurrMemory,
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

function lexicalScoreToSimilarity(score: number): number {
  const normalized = Math.max(0, Math.min(1, score));
  return Math.max(0.3, Math.min(0.98, 0.3 + normalized * 0.68));
}

export function searchByText(
  db: Database.Database,
  query: string,
  limit: number,
  scopeQuery?: MemoryScopeQuery,
): MemorySearchResult[] {
  const normalizedQuery = normalizeLexicalQuery(query);
  if (!normalizedQuery) return [];
  const tokens = tokenizeLexicalQuery(normalizedQuery);
  if (tokens.length === 0) return [];
  const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
  const scopeSql = buildScopeQuerySql(normalizedScopeQuery);

  const clauses = tokens.map(() => '(LOWER(text) LIKE ? OR LOWER(tags) LIKE ?)');
  const params: unknown[] = [];
  for (const token of tokens) {
    const pattern = `%${token}%`;
    params.push(pattern, pattern);
  }

  const normalizedLimit = normalizeListLimit(limit, 10, 1, 500);
  const scanLimit = normalizeListLimit(
    Math.max(40, normalizedLimit * 8),
    80,
    20,
    LEXICAL_SCAN_MAX_ROWS,
  );
  const stmt = db.prepare(`
    SELECT *
    FROM l2_memories
    WHERE superseded_by IS NULL
      AND deleted_at IS NULL
      AND (${clauses.join(' OR ')})
      ${scopeSql.clause}
    ORDER BY extracted_at DESC, id DESC
    LIMIT ?
  `);

  const rows = stmt.all(...params, ...scopeSql.params, scanLimit) as MemoryRow[];
  return rows
    .map(mapMemoryRow)
    .map(memory => {
      const lexicalScore = scoreLexicalMatch(memory, tokens, normalizedQuery);
      if (lexicalScore <= 0) return null;
      return {
        ...memory,
        similarity: lexicalScoreToSimilarity(lexicalScore),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => {
      if (right.similarity !== left.similarity) {
        return right.similarity - left.similarity;
      }
      if (right.salience !== left.salience) {
        return right.salience - left.salience;
      }
      return right.extractedAt - left.extractedAt;
    })
    .slice(0, normalizedLimit);
}
