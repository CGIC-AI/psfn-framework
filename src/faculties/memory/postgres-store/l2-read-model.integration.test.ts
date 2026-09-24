import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import type { MemoryScopeQuery, PurrMemory } from '../types.js';
import { normalizeMemoryScopeQuery } from '../types.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { lexicalScore } from './utils.js';
import { buildHighImpactLowConfidenceReviewInput } from '../maintenance-review.js';
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

// Former in-memory (pre-ufgwv) read semantics, copied verbatim from the
// hydrated-Map implementation, used as the parity oracle over the decoded
// fixture. Fixture keys avoid ties the Map resolved by insertion order.
const oracle = {
  active: (memories: PurrMemory[]) => memories.filter(memory => !memory.supersededBy && !memory.deletedAt),
  listMemories(memories: PurrMemory[], offset: number, limit?: number): PurrMemory[] {
    const sorted = [...memories].sort((left, right) => {
      const leftArchived = left.supersededBy || left.deletedAt ? 1 : 0;
      const rightArchived = right.supersededBy || right.deletedAt ? 1 : 0;
      return leftArchived - rightArchived
        || right.extractedAt - left.extractedAt
        || right.id.localeCompare(left.id);
    });
    return limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
  },
  listActiveMemories(memories: PurrMemory[], limit: number, offset: number, before?: { extractedAt: number; memoryId: string }) {
    return memories
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .filter(memory => before === undefined || memory.extractedAt < before.extractedAt
        || (memory.extractedAt === before.extractedAt && memory.id.localeCompare(before.memoryId) < 0))
      .sort((left, right) => right.extractedAt - left.extractedAt || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  },
  getAllActiveMemories(memories: PurrMemory[], limit: number) {
    return memories
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .sort((left, right) => right.extractedAt - left.extractedAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  },
  getMemoriesByChannel(memories: PurrMemory[], channelId: string, limit: number) {
    return memories
      .filter(memory => !memory.supersededBy && !memory.deletedAt && memory.sourceRef.startsWith(`${channelId}:`))
      .sort((left, right) => right.extractedAt - left.extractedAt)
      .slice(0, limit);
  },
  getMemoriesByContact(memories: PurrMemory[], contactId: string, limit: number) {
    return memories
      .filter(memory => !memory.supersededBy && !memory.deletedAt && memory.contactId === contactId)
      .sort((left, right) => right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  },
  searchByText(memories: PurrMemory[], query: string, limit: number, scopeQuery?: MemoryScopeQuery) {
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    return memories
      .filter((memory) => {
        if (memory.supersededBy || memory.deletedAt) return false;
        if (!normalizedScopeQuery) return true;
        const refs = normalizedScopeQuery.refs ?? [];
        const tags = normalizedScopeQuery.tags ?? [];
        if (refs.length === 0 && tags.length === 0) return true;
        const scopeMatch = refs.length === 0 || refs.some(ref => {
          const scope = memory.scopeRef;
          return scope?.kind === ref.kind && scope.id === ref.id;
        });
        const tagMatch = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
        return normalizedScopeQuery.mode === 'only' ? scopeMatch && tagMatch : scopeMatch || tagMatch;
      })
      .map(memory => ({ ...memory, similarity: lexicalScore(memory, query) }))
      .filter(memory => memory.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  },
};

const ids = (memories: readonly PurrMemory[]): string[] => memories.map(memory => memory.id);

function fixture(): PurrMemory[] {
  const memories: PurrMemory[] = [];
  const texts = [
    'Garden roses bloom in June',
    'The partner prefers green tea over coffee',
    'Roses and tulips in the garden',
    'Quarterly planning notes for the garden project',
    'Tea ceremony practice on Sunday',
    'Coffee grinder maintenance reminder',
    'Birthday gift idea: rose tea set',
    'Weekly garden watering schedule',
    'Tulips need cold stratification',
    'Project alpha kickoff with the team',
    'Green garden hose replacement',
    'Rose pruning technique from the workshop',
  ];
  texts.forEach((text, index) => {
    const id = `m${String(index).padStart(2, '0')}${'abcdef'[index % 6]}`;
    memories.push(makeMemory(id, {
      text,
      // Duplicate timestamps exercise the id tie-break in list/active orders.
      extractedAt: 1_700_000_000_000 + Math.floor(index / 2) * 1000,
      lastAccessed: 1_700_000_000_000,
      salience: 0.05 + index * 0.07,
      sourceRef: `${index % 3 === 0 ? 'channel-a' : index % 3 === 1 ? 'channel-b' : 'channel-a_x'}:turn-${index}`,
      tags: index % 2 === 0 ? ['garden', `tag${index}`] : ['misc'],
      ...(index % 4 === 0 ? { contactId: 'contact-a' } : index % 4 === 1 ? { contactId: 'contact-b' } : {}),
      ...(index % 5 === 0 ? { scopeRef: { kind: 'project' as const, id: 'alpha' } } : {}),
      ...(index % 3 === 1 ? { scopeTags: ['focus'] } : {}),
      ...(index === 10 ? { supersededBy: 'm11f' } : {}),
    }));
  });
  return memories;
}

async function seed(store: MemoryStorePort, memories: readonly PurrMemory[]): Promise<void> {
  for (const memory of memories) {
    await store.insertMemory(memory, EMBEDDING);
  }
}

describe('PostgresL2ReadModel query-time reads (ufgwv)', () => {
  it('boots without any unbounded L2 row SELECT and answers reads from Postgres', async () => {
    await withRecordingPool(async ({ pool, statements }) => {
      const seeded = await createPostgresMemoryStoreFromPool(pool, 4);
      await seed(seeded, fixture());

      statements.length = 0;
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const bootRowSelects = statements
        .filter(sql => /\bFROM l2_memories\b/i.test(sql))
        .filter(sql => !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql))
        .filter(sql => !/\bCOUNT\(/i.test(sql) && !/\bLIMIT\b/i.test(sql));
      expect(bootRowSelects).toEqual([]);

      statements.length = 0;
      expect(await store.countActiveMemories()).toBe(11);
      expect((await store.getById('m03d'))?.text).toBe('Quarterly planning notes for the garden project');
      expect(statements.some(sql => /\bFROM l2_memories memory\b/i.test(sql))).toBe(true);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('matches the former in-memory detail/list/count/slice/stats/search semantics, across restart', async () => {
    await withRecordingPool(async ({ pool }) => {
      const first = await createPostgresMemoryStoreFromPool(pool, 4);
      const memories = fixture();
      await seed(first, memories);
      await first.softDeleteMemory('m05f', { deleteId: 'delete-m05f', deletedBy: 'tester' });

      for (const store of [first, await createPostgresMemoryStoreFromPool(pool, 4)]) {
        const decoded = await store.getByIds([...ids(memories), 'm05f', 'missing', 'm00a']);
        expect(ids(decoded)).toEqual([...ids(memories), 'missing'].filter(id => id !== 'missing'));
        expect(decoded.find(memory => memory.id === 'm05f')?.deletedAt).toBeDefined();
        expect(await store.getById('missing')).toBeUndefined();
        for (const memory of memories) {
          expect(await store.getById(memory.id)).toMatchObject({
            id: memory.id, text: memory.text, sourceRef: memory.sourceRef, salience: memory.salience,
          });
        }

        expect(await store.countActiveMemories()).toBe(oracle.active(decoded).length);
        expect(ids(await store.listMemories())).toEqual(ids(oracle.listMemories(decoded, 0)));
        expect(ids(await store.listMemories({ offset: 3 }))).toEqual(ids(oracle.listMemories(decoded, 3)));
        expect(ids(await store.listMemories({ limit: 4, offset: 2 }))).toEqual(ids(oracle.listMemories(decoded, 2, 4)));
        expect(ids(await store.listActiveMemories({ limit: 5 }))).toEqual(ids(oracle.listActiveMemories(decoded, 5, 0)));
        const before = { extractedAt: 1_700_000_000_000 + 3000, memoryId: 'm07b' };
        expect(ids(await store.listActiveMemories({ limit: 50, offset: 1, before })))
          .toEqual(ids(oracle.listActiveMemories(decoded, 50, 1, before)));
        expect(ids(await store.getAllActiveMemories(7))).toEqual(ids(oracle.getAllActiveMemories(decoded, 7)));
        expect(ids(await store.getAllActiveMemories())).toEqual(ids(oracle.getAllActiveMemories(decoded, 10_000)));
        for (const channelId of ['channel-a', 'channel-b', 'channel-a_x', 'channel-%']) {
          expect(ids(await store.getMemoriesByChannel(channelId, 3)), channelId)
            .toEqual(ids(oracle.getMemoriesByChannel(decoded, channelId, 3)));
        }
        for (const contactId of ['contact-a', 'contact-b', 'contact-z']) {
          expect(ids(await store.getMemoriesByContact(contactId, 10)), contactId)
            .toEqual(ids(oracle.getMemoriesByContact(decoded, contactId, 10)));
        }
        const stats = await store.getStats();
        const active = oracle.active(decoded);
        expect(stats.total).toBe(active.length);
        expect(stats.byType).toEqual({ semantic: active.length });
        expect(stats.avgSalience).toBeCloseTo(active.reduce((sum, memory) => sum + memory.salience, 0) / active.length, 10);

        const searches: Array<[string, number, MemoryScopeQuery | undefined]> = [
          ['garden rose', 20, undefined],
          ['GARDEN tea', 3, undefined],
          ['tea tea coffee', 20, undefined],
          ['channel-b', 20, undefined],
          ['tag4 misc', 20, undefined],
          ['!!!', 20, undefined],
          ['garden', 20, { mode: 'only', refs: [{ kind: 'project', id: 'alpha' }] }],
          ['garden', 20, { mode: 'only', tags: ['focus'] }],
          ['garden', 20, { mode: 'prefer', tags: ['focus'] }],
          ['garden tea', 20, { mode: 'prefer', refs: [{ kind: 'project', id: 'alpha' }], tags: ['focus'] }],
        ];
        for (const [query, limit, scopeQuery] of searches) {
          const actual = await store.searchByText(query, limit, scopeQuery);
          const expected = oracle.searchByText(decoded, query, limit, scopeQuery);
          expect(actual.map(memory => [memory.id, memory.similarity]), query)
            .toEqual(expected.map(memory => [memory.id, memory.similarity]));
        }
      }
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('reads staged rows inside a transaction and never exposes them after rollback', async () => {
    await withRecordingPool(async ({ pool }) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await seed(store, fixture().slice(0, 2));
      const staged = makeMemory('staged-row', { text: 'staged transactional memory' });

      await expect(store.runInTransaction(async () => {
        await store.insertMemory(staged, EMBEDDING);
        expect((await store.getById('staged-row'))?.text).toBe('staged transactional memory');
        expect(await store.countActiveMemories()).toBe(3);
        throw new Error('force rollback');
      })).rejects.toThrow('force rollback');

      expect(await store.getById('staged-row')).toBeUndefined();
      expect(await store.countActiveMemories()).toBe(2);
      expect(await store.searchByText('staged transactional', 5)).toEqual([]);

      const deleted = await store.softDeleteMemory('m00a', { deleteId: 'delete-m00a' });
      expect(deleted?.snapshot.id).toBe('m00a');
      expect((await store.getById('m00a'))?.deletedAt).toBeDefined();
      expect(await store.undoSoftDelete('delete-m00a')).toMatchObject({ memoryId: 'm00a' });
      expect((await store.getById('m00a'))?.deletedAt).toBeUndefined();
      expect(await store.bulkUpdate(['m00a', 'm01b', 'missing'], { sensitivity: 'confidential' })).toBe(2);
      expect((await store.getByIds(['m00a', 'm01b'])).map(memory => memory.sensitivity))
        .toEqual(['confidential', 'confidential']);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps subject-authorized reads unchanged and fail-closed across the cutover', async () => {
    await withRecordingPool(async ({ pool }) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await store.insertMemory(makeMemory('own', { provenance: { subjectContactId: 'contact-a' } }), EMBEDDING);
      await store.insertMemory(makeMemory('other', { provenance: { subjectContactId: 'contact-b' } }), EMBEDDING);
      const restarted = await createPostgresMemoryStoreFromPool(pool, 4);
      for (const current of [store, restarted]) {
        const list = await current.queryAuthorizedMemorySubjects({
          authorization: authorization('list'), selector: { kind: 'list' },
        });
        expect(ids(list.memories)).toEqual(['own']);
        expect(await current.queryAuthorizedMemorySubjects({
          authorization: authorization('detail'), selector: { kind: 'detail', memoryId: 'other' },
        })).toEqual({ memories: [], total: 0 });
        await expect(current.mutateAuthorizedMemorySubjects({
          authorization: authorization('update'), memoryIds: ['own', 'other'], updates: { salience: 0.9 },
        })).rejects.toThrow();
        expect((await current.getById('other'))?.salience).toBe(0.4);
      }
    });
  }, INTEGRATION_TIMEOUT_MS);
});

const SIDE_TABLES = /\bFROM (l2_memory_delete_versions|l2_memory_abstraction_links|memory_evolution_links|memory_links|l2_memory_maintenance_reviews|recent_contact_shapes)\b/i;

async function seedSideTables(store: MemoryStorePort): Promise<void> {
  await store.softDeleteMemory('m05f', { deleteId: 'delete-m05f', deletedBy: 'tester', reason: 'side' });
  await store.recordAbstractionLink({
    linkId: 'abstraction-1', sourceMemoryId: 'm00a', abstractedMemoryId: 'm01b',
    externalRef: 'ext:abstraction-1', createdAt: 10, createdBy: 'tester', reason: 'summary',
  });
  await store.recordAbstractionLink({
    linkId: 'abstraction-2', sourceMemoryId: 'm00a', abstractedMemoryId: 'm02c',
    externalRef: 'ext:abstraction-2', createdAt: 20,
  });
  await store.recordEvolutionLink({
    linkId: 'evolution-1', sourceMemoryId: 'm01b', targetMemoryId: 'm00a', relation: 'supersedes', createdAt: 30,
  });
  await store.recordEvolutionLink({
    linkId: 'evolution-2', sourceMemoryId: 'm01b', targetMemoryId: 'm02c', relation: 'conflicts_with', createdAt: 40,
  });
  expect(await store.linkMemories('m02c', 'm00a')).toMatchObject({ id1: 'm00a', id2: 'm02c' });
  expect(await store.linkMemories('m00a', 'm02c')).toBeNull();
  expect(await store.linkMemories('m00a', 'm03d', 'contrast')).toMatchObject({ linkType: 'contrast' });
  const review = buildHighImpactLowConfidenceReviewInput({
    memoryId: 'm00a', text: 'Potential high-impact boundary with weak evidence.',
    sourceRef: 'channel-a:m00a', confidence: 0.2, type: 'boundary',
  }, 1_000);
  if (!review) throw new Error('fixture must queue a review');
  await store.upsertMemoryMaintenanceReview(review);
  for (const [contactId, updatedAt] of [['contact-a', 5], ['contact-b', 9]] as const) {
    await store.upsertRecentContactShape({
      schemaVersion: 1, contactId, summary: `shape ${contactId}`, sourceMemoryIds: ['m00a'],
      confidenceScore: 0.5, noveltyScore: 0.25, updatedAt, freshUntil: updatedAt + 100,
    });
  }
}

async function sideTableView(store: MemoryStorePort): Promise<unknown> {
  return {
    deleteVersion: await store.getDeleteVersion('delete-m05f'),
    missingVersion: await store.getDeleteVersion('missing'),
    abstractionsBySource: await store.getAbstractionLinksForSourceMemory('m00a'),
    abstractionsByTarget: await store.getAbstractionLinksForAbstractedMemory('m01b'),
    evolutionBySource: await store.getEvolutionLinksForSourceMemory('m01b'),
    evolutionSupersedes: await store.getEvolutionLinksForSourceMemory('m01b', 'supersedes'),
    evolutionByTarget: await store.getEvolutionLinksForTargetMemory('m02c'),
    linked: await store.getLinkedMemories('m00a'),
    reviews: await store.listMemoryMaintenanceReviews(),
    pendingReviews: await store.listMemoryMaintenanceReviews({ status: 'pending', limit: 5 }),
    diagnostics: await store.getMemoryMaintenanceDiagnostics({ now: 4_000 }),
    shape: await store.getRecentContactShape('contact-a'),
    shapes: await store.listRecentContactShapes(),
  };
}

describe('PostgresMemoryStore side tables read at query time (t4mia)', () => {
  it('boots without reading any side table and answers identical getters across restart', async () => {
    await withRecordingPool(async ({ pool, statements }) => {
      const first = await createPostgresMemoryStoreFromPool(pool, 4);
      await seed(first, fixture());
      await seedSideTables(first);
      const before = await sideTableView(first);

      statements.length = 0;
      const restarted = await createPostgresMemoryStoreFromPool(pool, 4);
      const bootSideReads = statements
        .filter(sql => SIDE_TABLES.test(sql))
        .filter(sql => !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql));
      expect(bootSideReads).toEqual([]);

      expect(await sideTableView(restarted)).toEqual(before);
      expect(before).toMatchObject({
        deleteVersion: { deleteId: 'delete-m05f', memoryId: 'm05f', deletedBy: 'tester', deleteReason: 'side' },
        abstractionsBySource: [{ id: 'abstraction-1', createdAt: 10 }, { id: 'abstraction-2', createdAt: 20 }],
        evolutionBySource: [{ id: 'evolution-2' }, { id: 'evolution-1' }],
        evolutionSupersedes: [{ id: 'evolution-1' }],
        diagnostics: {
          reviewCount: 1, pendingReviewCount: 1, oldestPendingReviewAgeMs: 3_000,
          evolutionDecisionCount: 2, supersessionDecisionCount: 1, conflictDecisionCount: 1,
          latestEvolutionDecisionAt: 40,
        },
        shapes: [{ contactId: 'contact-b' }, { contactId: 'contact-a' }],
      });
      expect((before as { linked: Array<{ id2: string }> }).linked.map(link => link.id2).sort())
        .toEqual(['m02c', 'm03d']);
      expect(await restarted.unlinkMemories('m02c', 'm00a')).toBe(true);
      expect(await restarted.unlinkMemories('m02c', 'm00a')).toBe(false);
      expect((await first.getLinkedMemories('m00a')).map(link => link.id2)).toEqual(['m03d']);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('reads delete versions by id across restart and restores through the SQL version', async () => {
    await withRecordingPool(async ({ pool }) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await seed(store, fixture().slice(0, 2));
      expect(await store.getDeleteVersion('delete-kept')).toBeUndefined();
      expect(await store.undoSoftDelete('delete-kept')).toBeNull();

      await store.softDeleteMemory('m00a', { deleteId: 'delete-kept' });
      const restarted = await createPostgresMemoryStoreFromPool(pool, 4);
      expect(await restarted.undoSoftDelete('delete-kept', { restoredBy: 'tester' }))
        .toMatchObject({ deleteId: 'delete-kept', restoredBy: 'tester' });
      expect(await store.getDeleteVersion('delete-kept')).toMatchObject({ restoredBy: 'tester' });
      expect((await store.getById('m00a'))?.deletedAt).toBeUndefined();
    });
  }, INTEGRATION_TIMEOUT_MS);
});
