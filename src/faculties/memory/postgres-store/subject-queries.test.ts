import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../../shared/contracts/memory-subject.js';
import { queryAuthorizedMemorySubjects } from './subject-queries.js';

function makeAuthorization() {
  return {
    action: 'search' as const,
    viewerContactIds: ['contact-viewer-1'],
    allowedSubjectClasses: ['single_contact' as const],
    allowedViewerRelations: ['self' as const],
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    grantBindings: [],
  };
}

describe('queryAuthorizedMemorySubjects text_search FTS query building (d5e0p.24)', () => {
  it('builds a bounded disjunctive to_tsquery prioritizing latest-turn keywords and stripping tsquery metacharacters', async () => {
    const executed: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        executed.push({ sql, values });
        return { rows: [] };
      }),
    } as unknown as Pool;

    const filler = Array.from({ length: 120 }, (_, index) => `fillerword${index}`).join(' ');
    const query = `${filler} and the with that !danger & (inject):*'; DROP TABLE l2_memories; Did Mateo mention the astrolabe observatory?`;

    await queryAuthorizedMemorySubjects(
      pool,
      384,
      {
        authorization: makeAuthorization(),
        selector: { kind: 'text_search', query, limit: 20 },
      },
      { iterativeScanAvailable: true },
    );

    expect(executed).toHaveLength(1);
    const { sql, values } = executed[0]!;
    expect(sql).toContain("to_tsquery('simple', $1)");
    expect(sql).not.toContain('plainto_tsquery');
    const boundTsQuery = values[0];
    expect(typeof boundTsQuery).toBe('string');
    const terms = (boundTsQuery as string).split(' | ');
    expect(terms.length).toBeLessThanOrEqual(24);
    expect(terms).toContain('observatory');
    expect(terms).toContain('astrolabe');
    expect(terms).toContain('mateo');
    // Stop words and tsquery metacharacters must not survive into the bound query.
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('and');
    expect(terms).not.toContain('did');
    for (const term of terms) {
      expect(term).toMatch(/^[\p{L}\p{N}]+$/u);
    }
  });

  it('falls back safely to parameterized plainto_tsquery on punctuation-only queries', async () => {
    const executed: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        executed.push({ sql, values });
        return { rows: [] };
      }),
    } as unknown as Pool;

    await queryAuthorizedMemorySubjects(
      pool,
      384,
      {
        authorization: makeAuthorization(),
        selector: { kind: 'text_search', query: '??? !!! :::', limit: 20 },
      },
      { iterativeScanAvailable: true },
    );

    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toContain("plainto_tsquery('simple', $1)");
    expect(executed[0]?.values[0]).toBe('??? !!! :::');
  });
});
