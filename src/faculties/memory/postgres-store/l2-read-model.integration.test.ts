import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import type { PurrMemory } from '../types.js';
import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  type MemorySubjectQueryAuthorization,
} from '../../../shared/contracts/memory-subject.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const EMBEDDING = new Float32Array([0.9, 0.1, 0.1, 0.1]);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

interface RecordingPool {
  pool: Pool;
  statements: string[];
}

async function withRecordingPool<T>(handler: (recording: RecordingPool) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-memory-read-model-integration',
    allowExitOnIdle: true,
    max: 4,
  });
  const statements: string[] = [];
  const query = pool.query.bind(pool) as (text: unknown, values?: unknown) => Promise<unknown>;
  const recordingQuery = async (text: unknown, values?: unknown): Promise<unknown> => {
    if (typeof text === 'string') statements.push(text.replace(/\s+/g, ' ').trim());
    return await query(text, values);
  };
  Object.assign(pool, { query: recordingQuery });
  try {
    return await handler({ pool, statements });
  } finally {
    await pool.end();
  }
}

function makeMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `read model memory ${id}`,
    type: 'semantic',
    importance: 0.6,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.4,
    sourceRef: `channel-a:${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: ['read-model'],
    sensitivity: 'personal',
    consentFlags: {},
    ...overrides,
  };
}

function authorization(action: MemorySubjectQueryAuthorization['action']): MemorySubjectQueryAuthorization {
  return {
    action,
    viewerContactIds: ['contact-a'],
    allowedSubjectClasses: ['single_contact'],
    allowedViewerRelations: ['self'],
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    grantBindings: [],
  };
}

async function evidenceDigests(pool: Pool): Promise<Record<string, string>> {
  const rows = await pool.query<{ memory_id: string; evidence_digest: string }>(
    'SELECT memory_id, evidence_digest FROM l2_memory_subject_classifications ORDER BY memory_id',
  );
  return Object.fromEntries(rows.rows.map(row => [row.memory_id, row.evidence_digest]));
}

describe('L2 read selectors project metadata only', () => {
  it('never transfers embedding::text on read selectors and leaves subject evidence digests unchanged', async () => {
    await withRecordingPool(async ({ pool, statements }) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      for (const index of [1, 2, 3]) {
        await store.insertMemory(makeMemory(`subject-${index}`, {
          extractedAt: 1_700_000_000_000 + index,
          contactId: 'contact-a',
          provenance: { subjectContactId: 'contact-a' },
        }), EMBEDDING);
      }
      const digestsBefore = await evidenceDigests(pool);
      expect(Object.keys(digestsBefore)).toHaveLength(3);

      statements.length = 0;
      const list = await store.queryAuthorizedMemorySubjects({
        authorization: authorization('list'), selector: { kind: 'list' },
      });
      const detail = await store.queryAuthorizedMemorySubjects({
        authorization: authorization('detail'), selector: { kind: 'detail', memoryId: 'subject-2' },
      });
      const count = await store.queryAuthorizedMemorySubjects({
        authorization: authorization('count'), selector: { kind: 'count' },
      });
      const search = await store.queryAuthorizedMemorySubjects({
        authorization: authorization('search'), selector: { kind: 'text_search', query: 'read model' },
      });
      const semantic = await store.queryAuthorizedMemorySubjects({
        authorization: authorization('embedding'),
        selector: { kind: 'embedding_search', embedding: EMBEDDING, threshold: 0.5 },
      });
      const adminPage = await store.aggregateAuthorizedMemorySubjects({
        authorization: authorization('list'), selector: { kind: 'admin_page' },
      });
      const channelSlice = await store.aggregateAuthorizedMemorySubjects({
        authorization: authorization('list'), selector: { kind: 'channel_prefix', channelId: 'channel-a', limit: 10 },
      });
      const rawAdmin = await store.listAdminMemories({ limit: 10 });
      const rawSemantic = await store.searchByEmbedding(
        EMBEDDING, 0.5, 5, undefined, { authorization: 'bypass-system-internal' },
      );

      expect(list.total).toBe(3);
      expect(detail.memories.map(memory => memory.id)).toEqual(['subject-2']);
      expect(count.total).toBe(3);
      expect(search.total).toBe(3);
      expect(semantic.total).toBe(3);
      expect(adminPage.kind === 'memories' ? adminPage.total : -1).toBe(3);
      expect(channelSlice.kind === 'memories' ? channelSlice.memories.length : -1).toBe(3);
      expect(rawAdmin.total).toBe(3);
      expect(rawSemantic).toHaveLength(3);
      const l2Reads = statements.filter(sql => /from l2_memories/i.test(sql));
      expect(l2Reads.length).toBeGreaterThanOrEqual(9);
      expect(l2Reads.filter(sql => /embedding::text/i.test(sql))).toEqual([]);

      // Authorized mutation still locks, validates, and re-persists the stored
      // vector; its digest input (the vector) is unchanged, so the digest is too.
      await store.mutateAuthorizedMemorySubjects({
        authorization: authorization('update'), memoryIds: ['subject-1'], updates: { salience: 0.9 },
      });
      expect(await evidenceDigests(pool)).toEqual(digestsBefore);
      const stored = await pool.query<{ embedding: string }>(
        "SELECT embedding::text AS embedding FROM l2_memories WHERE id = 'subject-1'",
      );
      expect(stored.rows[0]?.embedding).toBe('[0.9,0.1,0.1,0.1]');
    });
  }, INTEGRATION_TIMEOUT_MS);
});
