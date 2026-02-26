import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  readStoredEmbeddingDimensions,
  runDatabaseIntegrityCheck,
  validateEmbeddingDimensions,
} from './startup-checks.js';

function createMockDb(options: {
  integrityRows?: Array<Record<string, unknown>>;
  schemaSql?: string | null;
  sampleBytes?: number | null;
}): Database.Database {
  const {
    integrityRows = [{ integrity_check: 'ok' }],
    schemaSql = null,
    sampleBytes = null,
  } = options;

  const prepare = vi.fn((sql: string) => {
    const normalized = sql.trim().toLowerCase();
    if (normalized === 'pragma integrity_check') {
      return { all: () => integrityRows };
    }
    if (normalized.includes('from sqlite_master')) {
      return { get: () => (schemaSql === null ? undefined : { sql: schemaSql }) };
    }
    if (normalized.includes('length(embedding)')) {
      if (sampleBytes === null) {
        return {
          get: () => {
            throw new Error('no rows');
          },
        };
      }
      return { get: () => ({ bytes: sampleBytes }) };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });

  return { prepare } as unknown as Database.Database;
}

describe('runDatabaseIntegrityCheck', () => {
  it('returns ok when pragma result is healthy', () => {
    const db = createMockDb({
      integrityRows: [{ integrity_check: 'ok' }],
    });

    expect(runDatabaseIntegrityCheck(db)).toEqual({
      ok: true,
      details: ['ok'],
    });
  });

  it('throws when pragma reports corruption', () => {
    const db = createMockDb({
      integrityRows: [{ integrity_check: 'rowid out of order' }],
    });

    expect(() => runDatabaseIntegrityCheck(db)).toThrow(
      'SQLite integrity check failed: rowid out of order',
    );
  });
});

describe('embedding dimension checks', () => {
  it('reads dims from sqlite schema definition when available', () => {
    const db = createMockDb({
      schemaSql: 'CREATE VIRTUAL TABLE l2_memory_embeddings USING vec0(embedding float[1536])',
    });

    expect(readStoredEmbeddingDimensions(db)).toBe(1536);
  });

  it('falls back to sample vector byte length when schema does not expose dims', () => {
    const db = createMockDb({
      schemaSql: 'CREATE TABLE l2_memory_embeddings (embedding BLOB)',
      sampleBytes: 2048,
    });

    expect(readStoredEmbeddingDimensions(db)).toBe(512);
  });

  it('returns mismatch when stored dims differ from configured dims', () => {
    const db = createMockDb({
      schemaSql: 'CREATE VIRTUAL TABLE l2_memory_embeddings USING vec0(embedding float[768])',
    });

    expect(validateEmbeddingDimensions(db, 1024)).toEqual({
      status: 'mismatch',
      configuredDims: 1024,
      storedDims: 768,
    });
  });

  it('returns unknown when stored dims cannot be determined', () => {
    const db = createMockDb({
      schemaSql: null,
      sampleBytes: null,
    });

    expect(validateEmbeddingDimensions(db, 1024)).toEqual({
      status: 'unknown',
      configuredDims: 1024,
      storedDims: null,
    });
  });
});
