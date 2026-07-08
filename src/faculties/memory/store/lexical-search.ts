import type Database from 'better-sqlite3';
import { normalizeMemoryScopeQuery, type MemoryScopeQuery } from '../types.js';
import {
  lexicalMemoryScoreToSimilarity,
  normalizeLexicalMemoryQuery,
  scoreLexicalMemoryMatch,
  tokenizeLexicalMemoryQuery,
} from '../lexical-match.js';
import { mapMemoryRow } from './mappers.js';
import { buildScopeQuerySql } from './trust-filters.js';
import type { MemoryRow, MemorySearchResult } from './types.js';

const LEXICAL_SCAN_MAX_ROWS = 500;

function normalizeListLimit(
  limit: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

export function searchByText(
  db: Database.Database,
  query: string,
  limit: number,
  scopeQuery?: MemoryScopeQuery,
): MemorySearchResult[] {
  const normalizedQuery = normalizeLexicalMemoryQuery(query);
  if (!normalizedQuery) return [];
  const tokens = tokenizeLexicalMemoryQuery(normalizedQuery);
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
      const lexicalScore = scoreLexicalMemoryMatch(memory, tokens, normalizedQuery);
      if (lexicalScore <= 0) return null;
      return {
        ...memory,
        similarity: lexicalMemoryScoreToSimilarity(lexicalScore),
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
