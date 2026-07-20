import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema } from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from './postgres-store.js';
import type { PurrMemory } from './types.js';
import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../shared/contracts/memory-subject.js';
import type { MemorySubjectQueryAuthorization } from '../../shared/contracts/memory-subject.js';
import { createPostgresContactStore } from '../../core/contacts/postgres-adapter.js';
import { persistMemorySubjectProjection } from './postgres-store/subject-projection.js';
import { createSubjectAuthorizedMemoryStore } from './subject-authorized-store.js';
import { MemoryWriter } from './writer.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { MemoryRetriever } from './retrieval.js';
import { describeMemorySubjectMutationContract } from '../../test-support/memory-subject-mutation-contract.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const DEFAULT_EMBEDDING = new Float32Array([0.9, 0.1, 0.1, 0.1]);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

function makeMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: overrides.id ?? 'memory-test-id',
    text: overrides.text ?? 'Postgres integration memory',
    type: overrides.type ?? 'semantic',
    importance: overrides.importance ?? 0.6,
    confidence: overrides.confidence ?? 0.9,
    emotionalValence: overrides.emotionalValence ?? 0.1,
    salience: overrides.salience ?? 0.3,
    sourceRef: overrides.sourceRef ?? 'api:test:postgres',
    extractedAt: overrides.extractedAt ?? 1_700_000_000_000,
    lastAccessed: overrides.lastAccessed ?? 1_700_000_000_000,
    accessCount: overrides.accessCount ?? 0,
    tags: overrides.tags ?? ['postgres', 'integration'],
    sensitivity: overrides.sensitivity ?? 'low',
    consentFlags: overrides.consentFlags ?? {},
    ...(overrides.formationVAD ? { formationVAD: overrides.formationVAD } : {}),
    ...(overrides.sourceType ? { sourceType: overrides.sourceType } : {}),
    ...(overrides.provenance ? { provenance: overrides.provenance } : {}),
    ...(overrides.scopeRef ? { scopeRef: overrides.scopeRef } : {}),
    ...(overrides.scopeTags ? { scopeTags: overrides.scopeTags } : {}),
    ...(overrides.provenanceRefs ? { provenanceRefs: overrides.provenanceRefs } : {}),
    ...(overrides.retentionClass ? { retentionClass: overrides.retentionClass } : {}),
    ...(overrides.supersededBy ? { supersededBy: overrides.supersededBy } : {}),
    ...(overrides.contactId ? { contactId: overrides.contactId } : {}),
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
    ...(overrides.deletedBy ? { deletedBy: overrides.deletedBy } : {}),
    ...(overrides.deleteReason ? { deleteReason: overrides.deleteReason } : {}),
  };
}

function encodeJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function subjectAuthorization(
  viewerContactId: string,
  action: MemorySubjectQueryAuthorization['action'],
  overrides: Partial<MemorySubjectQueryAuthorization> = {},
): MemorySubjectQueryAuthorization {
  return {
    action,
    viewerContactIds: [viewerContactId],
    allowedSubjectClasses: ['single_contact'],
    allowedViewerRelations: ['self'],
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    grantBindings: [],
    ...overrides,
  };
}

async function withMemoryDatabase<T>(handler: (pool: Pool) => Promise<T>): Promise<T> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-memory-integration',
    allowExitOnIdle: true,
    max: 4,
  });
  try {
    return await handler(pool);
  } finally {
    await pool.end();
  }
}

async function seedMemoryRow(pool: Pool, memory: PurrMemory, embedding: readonly number[]): Promise<void> {
  await pool.query(`
    INSERT INTO l2_memories (
      id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
      salience_decay_anchor_at, source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,
      scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
      retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
      delete_reason, embedding
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::vector
    )
  `, [
    memory.id,
    memory.text,
    memory.type,
    memory.importance,
    memory.confidence,
    memory.emotionalValence,
    encodeJsonValue(memory.formationVAD),
    memory.salience,
    memory.salienceDecayAnchorAt ?? memory.lastAccessed,
    memory.sourceRef,
    memory.extractedAt,
    memory.lastAccessed,
    memory.accessCount,
    memory.supersededBy ?? null,
    encodeJsonValue(memory.tags),
    memory.scopeRef?.kind ?? null,
    memory.scopeRef?.id ?? null,
    memory.scopeRef?.label ?? null,
    encodeJsonValue(memory.scopeTags ?? []),
    encodeJsonValue(memory.provenanceRefs ?? []),
    memory.retentionClass ?? null,
    memory.sensitivity,
    encodeJsonValue(memory.consentFlags ?? {}),
    memory.contactId ?? null,
    memory.deletedAt ?? null,
    memory.deletedBy ?? null,
    memory.deleteReason ?? null,
    `[${embedding.join(',')}]`,
  ]);
}

describeMemorySubjectMutationContract(
  'PostgreSQL',
  async run => await withMemoryDatabase(async pool => (
    await run(await createPostgresMemoryStoreFromPool(pool, 4))
  )),
  INTEGRATION_TIMEOUT_MS,
);

describe('postgres memory store integration', () => {
  it('makes patched text immediately retrievable through new semantic and lexical projections', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const oldText = 'obsolete amber baseline memory';
      const patchedText = 'shakedown probe cobalt thunderstamp 7749 [PATCHED]';
      const oldEmbedding = new Float32Array([1, 0, 0, 0]);
      const patchedEmbedding = new Float32Array([0, 1, 0, 0]);
      const embeddingCalls: string[] = [];
      const embedText = async (text: string): Promise<Float32Array> => {
        embeddingCalls.push(text);
        if (text === patchedText || text === 'patched memory query') return patchedEmbedding;
        if (text === oldText || text === 'original memory query') return oldEmbedding;
        throw new Error(`Unexpected embedding input: ${text}`);
      };
      const embeddings: EmbeddingProviderPort = {
        dims: 4,
        embed: embedText,
        embedBatch: async (texts) => await Promise.all(texts.map(embedText)),
      };
      const memory = makeMemory({
        id: 'patched-retrieval-projection',
        text: oldText,
        // A renderable sensitivity: 'low' is not a valid SensitivityLevel and
        // the trust ceiling withholds it from the context block under every
        // trust tier, which would mask the retrieval-projection assertion.
        sensitivity: 'public',
        provenance: { subjectContactId: 'contact-a' },
      });
      await store.insertMemory(memory, oldEmbedding);
      const authorizedStore = createSubjectAuthorizedMemoryStore(store, {
        viewerContactId: 'contact-a',
      });
      const writer = new MemoryWriter(authorizedStore, embeddings);
      const retriever = new MemoryRetriever(authorizedStore, embeddings, {
        retrievalThreshold: 0.99,
        telemetryEnabled: false,
        contextWindow: 32_000,
      });
      const retrievalRequest = {
        contextText: 'patched memory query',
        channelId: 'api:patched-memory-regression',
        trustLevel: 'primary' as const,
      };

      const beforePatch = await retriever.refreshActiveMemoryContext(retrievalRequest);
      expect(beforePatch?.contextBlock ?? '').not.toContain(memory.text);

      await writer.patchMemory({
        memoryId: memory.id,
        text: patchedText,
        reason: 'integration regression',
      });

      await expect(authorizedStore.searchByEmbedding(patchedEmbedding, 0.99, 10))
        .resolves.toEqual([expect.objectContaining({ id: memory.id, text: patchedText })]);
      await expect(authorizedStore.searchByEmbedding(oldEmbedding, 0.99, 10))
        .resolves.toEqual([]);
      await expect(authorizedStore.searchByText('cobalt patched', 10))
        .resolves.toEqual([expect.objectContaining({ id: memory.id, text: patchedText })]);

      const afterPatch = await retriever.refreshActiveMemoryContext(retrievalRequest);
      expect(afterPatch?.contextBlock).toContain(patchedText);
      expect(afterPatch?.selectedMemoryIds).toContain(memory.id);

      const deleted = await authorizedStore.softDeleteMemory(memory.id, {
        deletedBy: 'integration:test',
        reason: 'restore projection regression',
      });
      expect(deleted).not.toBeNull();
      const embeddingCallCountBeforeRestore = embeddingCalls.length;
      await expect(authorizedStore.undoSoftDelete(deleted!.deleteId, {
        restoredBy: 'integration:test',
      })).resolves.not.toBeNull();
      expect(embeddingCalls).toHaveLength(embeddingCallCountBeforeRestore);
      await expect(authorizedStore.searchByEmbedding(patchedEmbedding, 0.99, 10))
        .resolves.toEqual([expect.objectContaining({ id: memory.id, text: patchedText })]);
      await expect(authorizedStore.searchByText('cobalt patched', 10))
        .resolves.toEqual([expect.objectContaining({ id: memory.id, text: patchedText })]);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps the forward schema insert-compatible with the pre-anchor rollback writer', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      const beforeInsert = Date.now();

      const rollbackWriterUpsert = `
        INSERT INTO l2_memories (
          id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
          source_ref, source_type, provenance_json, extracted_at, last_accessed, access_count,
          superseded_by, tags,
          scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
          retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
          delete_reason, embedding
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,
          $17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24::jsonb,$25,$26,$27,$28,$29::vector
        )
        ON CONFLICT (id) DO UPDATE SET
          text = EXCLUDED.text,
          type = EXCLUDED.type,
          importance = EXCLUDED.importance,
          confidence = EXCLUDED.confidence,
          emotional_valence = EXCLUDED.emotional_valence,
          formation_vad = EXCLUDED.formation_vad,
          salience = EXCLUDED.salience,
          source_ref = EXCLUDED.source_ref,
          source_type = EXCLUDED.source_type,
          provenance_json = EXCLUDED.provenance_json,
          extracted_at = EXCLUDED.extracted_at,
          last_accessed = EXCLUDED.last_accessed,
          access_count = EXCLUDED.access_count,
          superseded_by = EXCLUDED.superseded_by,
          tags = EXCLUDED.tags,
          scope_ref_kind = EXCLUDED.scope_ref_kind,
          scope_ref_id = EXCLUDED.scope_ref_id,
          scope_ref_label = EXCLUDED.scope_ref_label,
          scope_tags = EXCLUDED.scope_tags,
          provenance_refs = EXCLUDED.provenance_refs,
          retention_class = EXCLUDED.retention_class,
          sensitivity = EXCLUDED.sensitivity,
          consent_flags = EXCLUDED.consent_flags,
          contact_id = EXCLUDED.contact_id,
          deleted_at = EXCLUDED.deleted_at,
          deleted_by = EXCLUDED.deleted_by,
          delete_reason = EXCLUDED.delete_reason,
          embedding = EXCLUDED.embedding
      `;
      const rollbackWriterValues = (text: string, lastAccessed: number, accessCount: number) => [
        'rollback-writer-memory',
        text,
        'semantic',
        0.6,
        0.9,
        0.1,
        '{"valence":0.1,"arousal":0.2,"dominance":0.3}',
        0.3,
        'api:test:rollback-writer',
        'conversation',
        '{}',
        1_700_000_000_000,
        lastAccessed,
        accessCount,
        null,
        '["rollback"]',
        null,
        null,
        null,
        '[]',
        '[]',
        null,
        'personal',
        '{}',
        null,
        null,
        null,
        null,
        '[0.1,0.2]',
      ];

      await pool.query(
        rollbackWriterUpsert,
        rollbackWriterValues('Legacy writer compatibility memory', 1_700_000_000_000, 0),
      );

      const result = await pool.query<{
        salience_decay_anchor_at: string;
        text: string;
        access_count: number;
      }>(`
        SELECT salience_decay_anchor_at, text, access_count
        FROM l2_memories
        WHERE id = 'rollback-writer-memory'
      `);
      const anchor = Number(result.rows[0]?.salience_decay_anchor_at);
      expect(anchor).toBeGreaterThanOrEqual(beforeInsert);
      expect(anchor).toBeLessThanOrEqual(Date.now());

      await pool.query(
        rollbackWriterUpsert,
        rollbackWriterValues('Legacy rollback writer conflict update', 1_700_000_000_500, 1),
      );
      const updated = await pool.query<{
        salience_decay_anchor_at: string;
        text: string;
        access_count: number;
      }>(`
        SELECT salience_decay_anchor_at, text, access_count
        FROM l2_memories
        WHERE id = 'rollback-writer-memory'
      `);
      expect(updated.rows[0]).toEqual({
        salience_decay_anchor_at: String(anchor),
        text: 'Legacy rollback writer conflict update',
        access_count: 1,
      });
    });
  });

  it('classifies inserts atomically and keeps idempotent retries on the same revision', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const input = makeMemory({
        id: 'atomic-subject-write',
        provenance: { subjectContactId: 'contact-a' },
      });

      await store.insertMemory(input, DEFAULT_EMBEDDING);
      await store.insertMemory(input, DEFAULT_EMBEDDING);

      const projection = await pool.query<{
        subject_class: string;
        status: string;
        classifier_version: number;
        memory_revision: string;
        evidence_digest: string;
        memory_digest: string;
        authorization_revision: string;
        contacts: string[];
      }>(`
        SELECT c.subject_class, c.status, c.classifier_version, c.memory_revision,
               c.evidence_digest, m.subject_evidence_digest AS memory_digest,
               m.authorization_revision,
               COALESCE(array_agg(sc.contact_id ORDER BY sc.contact_id)
                 FILTER (WHERE sc.contact_id IS NOT NULL), '{}') AS contacts
        FROM l2_memories m
        JOIN l2_memory_subject_classifications c ON c.memory_id = m.id
        LEFT JOIN l2_memory_subject_contacts sc ON sc.memory_id = m.id
        WHERE m.id = $1
        GROUP BY c.memory_id, c.subject_class, c.status, c.classifier_version,
                 c.memory_revision, c.evidence_digest, m.subject_evidence_digest,
                 m.authorization_revision
      `, [input.id]);
      expect(projection.rows[0]).toMatchObject({
        subject_class: 'single_contact',
        status: 'current',
        classifier_version: MEMORY_SUBJECT_CLASSIFIER_VERSION,
        memory_revision: '1',
        authorization_revision: '1',
        contacts: ['contact-a'],
      });
      expect(projection.rows[0]?.evidence_digest).toBe(projection.rows[0]?.memory_digest);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rolls back the memory row when classification persistence fails', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await pool.query('DROP TABLE l2_memory_subject_classifications CASCADE');

      await expect(store.insertMemory(makeMemory({ id: 'classification-failure' }), DEFAULT_EMBEDDING))
        .rejects.toThrow();
      const rows = await pool.query('SELECT id FROM l2_memories WHERE id = $1', ['classification-failure']);
      expect(rows.rows).toEqual([]);
      expect(await store.getById('classification-failure')).toBeUndefined();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('reclassifies every subject-evidence mutation and leaves access counters revision-stable', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const input = makeMemory({
        id: 'subject-mutation-memory',
        provenance: { subjectContactId: 'contact-a' },
        provenanceRefs: ['turn:1'],
      });
      await store.insertMemory(input, DEFAULT_EMBEDDING);
      const before = await pool.query<{
        authorization_revision: string;
        evidence_digest: string;
      }>(`
        SELECT m.authorization_revision, c.evidence_digest
        FROM l2_memories m
        JOIN l2_memory_subject_classifications c ON c.memory_id = m.id
        WHERE m.id = $1
      `, [input.id]);

      await store.updateMemory(input.id, {
        text: 'Changed subject evidence text',
        provenance: { subjectContactIds: ['contact-a', 'contact-b'] },
        provenanceRefs: ['turn:2'],
        contactId: 'contact-mentioned',
        embedding: new Float32Array([0.1, 0.9, 0.1, 0.1]),
      });
      const after = await pool.query<{
        authorization_revision: string;
        memory_revision: string;
        evidence_digest: string;
        memory_digest: string;
        subject_class: string;
        status: string;
        contacts: string[];
      }>(`
        SELECT m.authorization_revision, c.memory_revision, c.evidence_digest,
               m.subject_evidence_digest AS memory_digest, c.subject_class, c.status,
               array_agg(sc.contact_id ORDER BY sc.contact_id) AS contacts
        FROM l2_memories m
        JOIN l2_memory_subject_classifications c ON c.memory_id = m.id
        JOIN l2_memory_subject_contacts sc ON sc.memory_id = m.id
        WHERE m.id = $1
        GROUP BY m.authorization_revision, c.memory_revision, c.evidence_digest,
                 m.subject_evidence_digest, c.subject_class, c.status
      `, [input.id]);
      expect(after.rows[0]).toMatchObject({
        authorization_revision: '2',
        memory_revision: '2',
        subject_class: 'multiple_contacts',
        status: 'current',
        contacts: ['contact-a', 'contact-b'],
      });
      expect(after.rows[0]?.evidence_digest).toBe(after.rows[0]?.memory_digest);
      expect(after.rows[0]?.evidence_digest).not.toBe(before.rows[0]?.evidence_digest);

      await store.updateMemory(input.id, { accessCount: 9, lastAccessed: 999 });
      const afterAccess = await pool.query<{
        authorization_revision: string;
        status: string;
      }>(`
        SELECT m.authorization_revision, c.status
        FROM l2_memories m
        JOIN l2_memory_subject_classifications c ON c.memory_id = m.id
        WHERE m.id = $1
      `, [input.id]);
      expect(afterAccess.rows[0]).toEqual({ authorization_revision: '2', status: 'current' });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('filters every named-memory sensitivity from list, detail, search, count, snippet, embedding, export, and prompt inputs in SQL', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const sensitivities = ['public', 'personal', 'intimate', 'confidential'] as const;
      const authorizedIds = sensitivities.map(sensitivity => `authorized-${sensitivity}`);
      for (const sensitivity of sensitivities) {
        await store.insertMemory(makeMemory({
          id: `authorized-${sensitivity}`,
          text: `private ${sensitivity} subject marker`,
          sensitivity,
          provenance: { subjectContactId: 'contact-a' },
          ...(sensitivity === 'public' ? {
            scopeRef: { kind: 'project' as const, id: 'alpha' },
            scopeTags: ['private-alpha'],
          } : {}),
        }), DEFAULT_EMBEDDING);
        await store.insertMemory(makeMemory({
          id: `unauthorized-${sensitivity}`,
          text: `private ${sensitivity} subject marker`,
          sensitivity,
          provenance: { subjectContactId: 'contact-b' },
        }), DEFAULT_EMBEDDING);
      }
      await store.insertMemory(makeMemory({
        id: 'unattributed',
        text: 'private unattributed marker',
      }), DEFAULT_EMBEDDING);

      const requests = [
        { action: 'list' as const, selector: { kind: 'list' as const } },
        {
          action: 'detail' as const,
          selector: { kind: 'detail' as const, memoryId: 'authorized-personal' },
        },
        { action: 'search' as const, selector: { kind: 'text_search' as const, query: 'subject marker' } },
        { action: 'snippet' as const, selector: { kind: 'text_search' as const, query: 'marker' } },
        { action: 'embedding' as const, selector: {
          kind: 'embedding_search' as const,
          embedding: DEFAULT_EMBEDDING,
          threshold: 0.99,
        } },
        { action: 'export' as const, selector: { kind: 'list' as const } },
        { action: 'prompt_preview' as const, selector: { kind: 'list' as const } },
      ];
      for (const request of requests) {
        const result = await store.queryAuthorizedMemorySubjects({
          authorization: subjectAuthorization('contact-a', request.action),
          selector: request.selector,
        });
        const expectedIds = request.selector.kind === 'detail'
          ? ['authorized-personal']
          : authorizedIds;
        expect(result.total, request.action).toBe(expectedIds.length);
        expect(result.memories.map(memory => memory.id).sort(), request.action)
          .toEqual([...expectedIds].sort());
      }
      const count = await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count'),
        selector: { kind: 'count' },
      });
      expect(count).toEqual({ memories: [], total: sensitivities.length });

      expect(await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'search'),
        selector: {
          kind: 'text_search',
          query: 'subject marker',
          scopeQuery: { mode: 'only', refs: [{ kind: 'project', id: 'other' }] },
        },
      })).toEqual({ memories: [], total: 0 });

      const hiddenDetail = await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'detail'),
        selector: { kind: 'detail', memoryId: 'unauthorized-public' },
      });
      expect(hiddenDetail).toEqual({ memories: [], total: 0 });

      const failClosedUnknownSubjects = await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count', {
          allowedSubjectClasses: ['ambiguous', 'unattributed', 'unbound_person'],
          allowedViewerRelations: ['none'],
        }),
        selector: { kind: 'count' },
      });
      expect(failClosedUnknownSubjects).toEqual({ memories: [], total: 0 });

      await expect(store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count'),
        selector: {
          kind: 'embedding_search',
          embedding: DEFAULT_EMBEDDING,
          threshold: 0.99,
        },
      })).rejects.toThrow(/does not permit embedding_search/);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('computes memory statistics only from rows authorized for the trusted subject', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await store.insertMemory(makeMemory({
        id: 'stats-visible-semantic',
        text: 'visible semantic content',
        type: 'semantic',
        salience: 0.25,
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'stats-visible-procedural',
        text: 'visible procedural content',
        type: 'procedural',
        salience: 0.75,
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'stats-hidden-subject',
        text: 'hidden subject content',
        type: 'emotional',
        salience: 1,
        provenance: { subjectContactId: 'contact-b' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'stats-unattributed',
        text: 'unattributed content',
        type: 'relational',
        salience: 1,
      }), DEFAULT_EMBEDDING);

      const authorized = createSubjectAuthorizedMemoryStore(store, {
        viewerContactId: 'contact-a',
      });
      const stats = await authorized.getStats();
      expect(stats).toEqual({
        total: 2,
        byType: { semantic: 1, procedural: 1 },
        avgSalience: 0.5,
      });
      expect(JSON.stringify(stats)).not.toContain('content');

      const denied = createSubjectAuthorizedMemoryStore(store, {});
      await expect(denied.getStats()).resolves.toEqual({
        total: 0,
        byType: {},
        avgSalience: 0,
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('hides stale projections and invalidates exact grant bindings after mutation', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const input = makeMemory({
        id: 'grant-bound-memory',
        provenance: { subjectContactId: 'contact-a' },
      });
      await store.insertMemory(input, DEFAULT_EMBEDDING);
      const classification = await store.getMemorySubjectClassification(input.id);
      expect(classification).toBeDefined();
      const grantBindings = [{
        memoryId: input.id,
        memoryRevision: classification!.memoryRevision,
        classifierVersion: classification!.classifierVersion,
        evidenceDigest: classification!.evidenceDigest,
      }];
      expect((await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'detail', { grantBindings }),
        selector: { kind: 'detail', memoryId: input.id },
      })).total).toBe(1);

      await store.updateMemory(input.id, {
        text: 'revision changed',
        embedding: new Float32Array([0.1, 0.9, 0.1, 0.1]),
      });
      expect(await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'detail', { grantBindings }),
        selector: { kind: 'detail', memoryId: input.id },
      })).toEqual({ memories: [], total: 0 });

      await pool.query(`
        UPDATE l2_memory_subject_classifications
        SET classifier_version = classifier_version + 1
        WHERE memory_id = $1
      `, [input.id]);
      expect((await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count'),
        selector: { kind: 'count' },
      })).total).toBe(0);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('hides internal derived artifacts from human subject authorization before counts and IDs', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await store.insertMemory(makeMemory({
        id: 'subject-visible',
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'subject-derived-internal',
        sourceRef: 'source:context_feedback|contact-a',
        tags: ['context_feedback'],
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);

      expect((await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count'),
        selector: { kind: 'count' },
      })).total).toBe(1);
      expect(await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'detail'),
        selector: { kind: 'detail', memoryId: 'subject-derived-internal' },
      })).toEqual({ memories: [], total: 0 });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('preauthorizes every bulk target and mutates atomically without revealing inaccessible counts', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await store.insertMemory(makeMemory({
        id: 'bulk-a',
        sensitivity: 'public',
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'bulk-b',
        sensitivity: 'personal',
        provenance: { subjectContactId: 'contact-b' },
      }), DEFAULT_EMBEDDING);

      await expect(store.mutateAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'bulk_mutation'),
        memoryIds: ['bulk-a', 'bulk-b'],
        updates: { sensitivity: 'confidential' },
      })).rejects.toThrow('Memory subject authorization denied');
      expect((await store.getById('bulk-a'))?.sensitivity).toBe('public');
      expect((await store.getById('bulk-b'))?.sensitivity).toBe('personal');

      expect(await store.mutateAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'update'),
        memoryIds: ['bulk-a'],
        updates: {
          sensitivity: 'confidential',
          text: 'authorized update',
          embedding: new Float32Array([0.1, 0.9, 0.1, 0.1]),
        },
      })).toBe(1);
      expect(await store.getById('bulk-a')).toMatchObject({
        sensitivity: 'confidential',
        text: 'authorized update',
      });

      await pool.query('UPDATE l2_memories SET importance = 0.99 WHERE id = $1', ['bulk-a']);
      expect(await store.mutateAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'update'),
        memoryIds: ['bulk-a'],
        updates: { sensitivity: 'intimate' },
      })).toBe(1);
      const preservedSiblingWrite = await pool.query<{ importance: number; sensitivity: string }>(
        'SELECT importance, sensitivity FROM l2_memories WHERE id = $1',
        ['bulk-a'],
      );
      expect(preservedSiblingWrite.rows[0]).toMatchObject({
        importance: 0.99,
        sensitivity: 'intimate',
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps subject-authorized replacement writes atomic inside an existing transaction', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await store.insertMemory(makeMemory({
        id: 'replace-a',
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'replace-b',
        provenance: { subjectContactId: 'contact-b' },
      }), DEFAULT_EMBEDDING);

      await expect(store.persistAuthorizedMemoryWrite({
        authorization: subjectAuthorization('contact-a', 'bulk_mutation'),
        memory: makeMemory({
          id: 'replacement-denied',
          provenance: { subjectContactId: 'contact-a' },
        }),
        embedding: DEFAULT_EMBEDDING,
        supersededMemoryIds: ['replace-a', 'replace-b'],
      })).rejects.toThrow('Memory subject authorization denied');
      expect(await store.getById('replacement-denied')).toBeUndefined();
      expect((await store.getById('replace-a'))?.supersededBy).toBeUndefined();
      expect((await store.getById('replace-b'))?.supersededBy).toBeUndefined();

      await store.runInTransaction(async () => {
        await store.persistAuthorizedMemoryWrite({
          authorization: subjectAuthorization('contact-a', 'bulk_mutation'),
          memory: makeMemory({
            id: 'replacement-allowed',
            provenance: { subjectContactId: 'contact-a' },
          }),
          embedding: DEFAULT_EMBEDDING,
          supersededMemoryIds: ['replace-a'],
        });
      });
      expect((await store.getById('replace-a'))?.supersededBy).toBe('replacement-allowed');
      expect(await store.getById('replacement-allowed')).toBeDefined();

      await store.runInTransaction(async () => {
        await store.mutateAuthorizedMemorySubjects({
          authorization: subjectAuthorization('contact-a', 'update'),
          memoryIds: ['replacement-allowed'],
          updates: { sensitivity: 'confidential' },
        });
      });
      expect((await store.getById('replacement-allowed'))?.sensitivity).toBe('confidential');
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('authorizes soft-delete and restore checkpoints without exposing known inaccessible ids', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      await store.insertMemory(makeMemory({
        id: 'delete-authorized-a',
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await store.insertMemory(makeMemory({
        id: 'delete-unauthorized-b',
        provenance: { subjectContactId: 'contact-b' },
      }), DEFAULT_EMBEDDING);

      expect(await store.softDeleteAuthorizedMemorySubject({
        authorization: subjectAuthorization('contact-a', 'update'),
        memoryId: 'delete-unauthorized-b',
      })).toBeNull();
      expect((await store.getById('delete-unauthorized-b'))?.deletedAt).toBeUndefined();

      const deleted = await store.softDeleteAuthorizedMemorySubject({
        authorization: subjectAuthorization('contact-a', 'update'),
        memoryId: 'delete-authorized-a',
        options: { deleteId: 'authorized-delete-version', deletedAt: 1_800_000_000_000 },
      });
      expect(deleted).toMatchObject({
        deleteId: 'authorized-delete-version',
        memoryId: 'delete-authorized-a',
        deletedAt: 1_800_000_000_000,
      });
      expect((await store.getById('delete-authorized-a'))?.deletedAt).toBe(1_800_000_000_000);

      expect(await store.undoAuthorizedMemorySubjectDelete({
        authorization: subjectAuthorization('contact-b', 'update'),
        deleteId: 'authorized-delete-version',
      })).toBeNull();
      expect((await store.getById('delete-authorized-a'))?.deletedAt).toBe(1_800_000_000_000);

      expect(await store.undoAuthorizedMemorySubjectDelete({
        authorization: subjectAuthorization('contact-a', 'update'),
        deleteId: 'authorized-delete-version',
        options: { restoredAt: 1_800_000_000_100 },
      })).toMatchObject({
        deleteId: 'authorized-delete-version',
        restoredAt: 1_800_000_000_100,
      });
      expect((await store.getById('delete-authorized-a'))?.deletedAt).toBeUndefined();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('backfills historical rows in bounded resumable batches and records ambiguity without guessing', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
        await seedMemoryRow(pool, makeMemory({ id }), [0.9, 0.1, 0.1, 0.1]);
      }
      await pool.query(`
        UPDATE l2_memories
        SET provenance_json = '{"subjectContactId":"contact-a","channelId":"room-a"}'::jsonb,
            scope_ref_kind = 'conversation', scope_ref_id = 'room-b'
        WHERE id = 'legacy-b'
      `);
      await pool.query(`
        UPDATE l2_memories
        SET provenance_json = '{"subjectContactId":"contact-c"}'::jsonb
        WHERE id = 'legacy-c'
      `);
      const store = await createPostgresMemoryStoreFromPool(pool, 4, { subjectBackfill: false });

      const first = await store.backfillMemorySubjectClassifications({ batchSize: 2, now: 1000 });
      expect(first).toMatchObject({
        state: 'processed',
        processedCount: 2,
        totalProcessedCount: 2,
        classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      });
      expect(Object.keys(first).sort()).toEqual([
        'classifierVersion',
        'durationMs',
        'processedCount',
        'reasonCounts',
        'state',
        'totalProcessedCount',
      ]);

      const second = await store.backfillMemorySubjectClassifications({ batchSize: 2, now: 2000 });
      expect(second).toMatchObject({ state: 'processed', processedCount: 1, totalProcessedCount: 3 });
      const complete = await store.backfillMemorySubjectClassifications({ batchSize: 2, now: 3000 });
      expect(complete).toMatchObject({ state: 'complete', processedCount: 0, totalProcessedCount: 3 });

      expect(await store.getMemorySubjectClassification('legacy-b')).toMatchObject({
        subjectClass: 'ambiguous',
        status: 'current',
        subjectContactIds: ['contact-a'],
        reasonClass: 'conflicting_room_evidence',
      });
      expect(await store.getMemorySubjectClassification('legacy-c')).toMatchObject({
        subjectClass: 'single_contact',
        subjectContactIds: ['contact-c'],
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('finishes the resumable subject backfill before exposing a historical corpus', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      await seedMemoryRow(pool, makeMemory({
        id: 'startup-backfill-memory',
        provenance: { subjectContactId: 'contact-a' },
      }), [0.9, 0.1, 0.1, 0.1]);
      await pool.query(`
        UPDATE l2_memories
        SET provenance_json = '{"subjectContactId":"contact-a"}'::jsonb
        WHERE id = 'startup-backfill-memory'
      `);

      const store = await createPostgresMemoryStoreFromPool(pool, 4);

      expect(await store.getMemorySubjectClassification('startup-backfill-memory')).toMatchObject({
        subjectClass: 'single_contact',
        status: 'current',
        subjectContactIds: ['contact-a'],
      });
      expect((await store.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'detail'),
        selector: { kind: 'detail', memoryId: 'startup-backfill-memory' },
      })).total).toBe(1);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps subject projections and authorization isolated between companion schemas', async () => {
    if (!harness) throw new Error('Postgres integration harness is not available');
    const database = await harness.createDatabase();
    const admin = createPostgresPool(database.databaseUrl, { max: 1, allowExitOnIdle: true });
    const poolA = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
      allowExitOnIdle: true,
    });
    const poolB = createPostgresPool(database.databaseUrl, {
      schema: 'companion_b',
      max: 1,
      allowExitOnIdle: true,
    });
    try {
      await admin.query('CREATE SCHEMA companion_a');
      await admin.query('CREATE SCHEMA companion_b');
      const storeA = await createPostgresMemoryStoreFromPool(poolA, 4);
      const storeB = await createPostgresMemoryStoreFromPool(poolB, 4);
      await storeA.insertMemory(makeMemory({
        id: 'same-memory-id',
        provenance: { subjectContactId: 'contact-a' },
      }), DEFAULT_EMBEDDING);
      await storeB.insertMemory(makeMemory({
        id: 'same-memory-id',
        provenance: { subjectContactId: 'contact-b' },
      }), DEFAULT_EMBEDDING);

      expect((await storeA.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count'),
        selector: { kind: 'count' },
      })).total).toBe(1);
      expect((await storeB.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-a', 'count'),
        selector: { kind: 'count' },
      })).total).toBe(0);
      expect((await storeB.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization('contact-b', 'count'),
        selector: { kind: 'count' },
      })).total).toBe(1);
    } finally {
      await Promise.all([
        admin.end(),
        poolA.end(),
        poolB.end(),
      ]);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('invalidates contact subjects transactionally on merge and delete', async () => {
    await withMemoryDatabase(async (pool) => {
      const databaseUrl = pool.options.connectionString;
      if (!databaseUrl) throw new Error('Postgres test pool is missing its connection string');
      const memoryStore = await createPostgresMemoryStoreFromPool(pool, 4);
      const contactStore = await createPostgresContactStore(databaseUrl, undefined, { pool });
      const source = await contactStore.upsert({
        id: '00000000-0000-4000-8000-000000000001',
        displayName: 'Source',
        trustLevel: 'regular',
      });
      const target = await contactStore.upsert({
        id: '00000000-0000-4000-8000-000000000002',
        displayName: 'Target',
        trustLevel: 'regular',
      });
      await memoryStore.insertMemory(makeMemory({
        id: 'merge-subject-memory',
        provenance: { subjectContactId: source.id },
      }), DEFAULT_EMBEDDING);

      expect(await contactStore.mergeContacts(source.id, target.id)).toBe(true);
      expect(await memoryStore.getMemorySubjectClassification('merge-subject-memory')).toMatchObject({
        status: 'invalidated',
      });
      expect((await memoryStore.queryAuthorizedMemorySubjects({
        authorization: subjectAuthorization(source.id, 'count'),
        selector: { kind: 'count' },
      })).total).toBe(0);

      await memoryStore.backfillMemorySubjectClassifications({ resetCheckpoint: true });
      expect(await memoryStore.getMemorySubjectClassification('merge-subject-memory')).toMatchObject({
        subjectClass: 'ambiguous',
        status: 'current',
        reasonClass: 'unknown_subject_contact',
      });

      await memoryStore.insertMemory(makeMemory({
        id: 'delete-subject-memory',
        provenance: { subjectContactId: target.id },
      }), DEFAULT_EMBEDDING);
      expect(await contactStore.deleteContact(target.id)).toBe(true);
      expect(await memoryStore.getMemorySubjectClassification('delete-subject-memory')).toMatchObject({
        status: 'invalidated',
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it.each(['merge', 'delete'] as const)(
    'reloads the locked SQL row before an access-stat update after contact %s',
    async (operation) => {
      await withMemoryDatabase(async (pool) => {
        const databaseUrl = pool.options.connectionString;
        if (!databaseUrl) throw new Error('Postgres test pool is missing its connection string');
        const memoryStore = await createPostgresMemoryStoreFromPool(pool, 4);
        const contactStore = await createPostgresContactStore(databaseUrl, undefined, { pool });
        const source = await contactStore.upsert({
          id: '00000000-0000-4000-8000-000000000011',
          displayName: 'Access Source',
          trustLevel: 'regular',
        });
        const target = await contactStore.upsert({
          id: '00000000-0000-4000-8000-000000000012',
          displayName: 'Access Target',
          trustLevel: 'regular',
        });
        const memoryId = `access-after-${operation}`;
        await memoryStore.insertMemory(makeMemory({
          id: memoryId,
          contactId: source.id,
          provenance: { subjectContactId: source.id },
        }), DEFAULT_EMBEDDING);

        if (operation === 'merge') {
          expect(await contactStore.mergeContacts(source.id, target.id)).toBe(true);
        } else {
          expect(await contactStore.deleteContact(source.id)).toBe(true);
        }
        await memoryStore.updateMemory(memoryId, { lastAccessed: 1_800_000_000_000, accessCount: 7 });

        const row = await pool.query<{
          contact_id: string | null;
          last_accessed: string;
          access_count: number;
          status: string;
          subject_class: string;
          retired_subject_count: string;
        }>(`
          SELECT memory.contact_id, memory.last_accessed, memory.access_count,
                 classification.status, classification.subject_class,
                 COUNT(subject_contact.contact_id) FILTER (
                   WHERE subject_contact.contact_id = $2
                 ) AS retired_subject_count
          FROM l2_memories memory
          JOIN l2_memory_subject_classifications classification ON classification.memory_id = memory.id
          LEFT JOIN l2_memory_subject_contacts subject_contact ON subject_contact.memory_id = memory.id
          WHERE memory.id = $1
          GROUP BY memory.id, classification.memory_id
        `, [memoryId, source.id]);
        expect(row.rows[0]).toMatchObject({
          contact_id: operation === 'merge' ? target.id : null,
          last_accessed: '1800000000000',
          access_count: 7,
        });
        expect(row.rows[0]).toMatchObject({
          status: 'current',
          subject_class: 'ambiguous',
          retired_subject_count: '0',
        });
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it.each(['merge', 'delete'] as const)(
    'serializes subject contact validation against concurrent contact %s',
    async (operation) => {
      await withMemoryDatabase(async (pool) => {
        const databaseUrl = pool.options.connectionString;
        if (!databaseUrl) throw new Error('Postgres test pool is missing its connection string');
        const memoryStore = await createPostgresMemoryStoreFromPool(pool, 4);
        const contactStore = await createPostgresContactStore(databaseUrl, undefined, { pool });
        const source = await contactStore.upsert({
          id: '00000000-0000-4000-8000-000000000021',
          displayName: 'Concurrent Source',
          trustLevel: 'regular',
        });
        const target = await contactStore.upsert({
          id: '00000000-0000-4000-8000-000000000022',
          displayName: 'Concurrent Target',
          trustLevel: 'regular',
        });
        const memory = makeMemory({
          id: `concurrent-${operation}`,
          provenance: { subjectContactId: source.id },
        });
        await memoryStore.insertMemory(memory, DEFAULT_EMBEDDING);
        const revision = await pool.query<{ authorization_revision: string }>(
          'SELECT authorization_revision FROM l2_memories WHERE id = $1',
          [memory.id],
        );
        const classifier = await pool.connect();
        try {
          await classifier.query('BEGIN');
          await persistMemorySubjectProjection(
            classifier,
            memory,
            Number(revision.rows[0]?.authorization_revision),
            DEFAULT_EMBEDDING,
          );
          let settled = false;
          const mutation = (operation === 'merge'
            ? contactStore.mergeContacts(source.id, target.id)
            : contactStore.deleteContact(source.id)).then((value) => {
            settled = true;
            return value;
          });
          await new Promise(resolve => setTimeout(resolve, 50));
          expect(settled).toBe(false);
          await classifier.query('COMMIT');
          expect(await mutation).toBe(true);
        } catch (error) {
          await classifier.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          classifier.release();
        }

        const projection = await pool.query<{ current_projection_count: string }>(`
          SELECT COUNT(*) AS current_projection_count
          FROM l2_memory_subject_classifications classification
          JOIN l2_memories memory ON memory.id = classification.memory_id
          JOIN l2_memory_subject_contacts subject_contact ON subject_contact.memory_id = memory.id
          WHERE memory.id = $1
            AND classification.status = 'current'
            AND classification.memory_revision = memory.authorization_revision
            AND subject_contact.contact_id = $2
        `, [memory.id, source.id]);
        expect(projection.rows[0]?.current_projection_count).toBe('0');
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it('invalidates the subject projection in the same transaction as direct evidence mutation', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      const seededMemory = makeMemory({ id: 'subject-trigger-memory' });
      await seedMemoryRow(pool, seededMemory, [0.9, 0.1, 0.1, 0.1]);
      const digest = 'a'.repeat(64);
      await pool.query(
        'UPDATE l2_memories SET subject_evidence_digest = $2 WHERE id = $1',
        [seededMemory.id, digest],
      );
      await pool.query(`
        INSERT INTO l2_memory_subject_classifications (
          memory_id, subject_class, status, classifier_version, memory_revision,
          evidence_digest, evidence_json, reason_class, classified_at, updated_at
        ) VALUES ($1, 'single_contact', 'current', 1, 1, $2, '["explicit_subject_contact"]',
          'classified', 100, 100)
      `, [seededMemory.id, digest]);

      await pool.query('BEGIN');
      await pool.query('UPDATE l2_memories SET text = $2 WHERE id = $1', [
        seededMemory.id,
        'subject evidence changed',
      ]);
      const inside = await pool.query<{
        authorization_revision: string;
        subject_evidence_digest: string | null;
        status: string;
      }>(`
        SELECT m.authorization_revision, m.subject_evidence_digest, c.status
        FROM l2_memories m
        JOIN l2_memory_subject_classifications c ON c.memory_id = m.id
        WHERE m.id = $1
      `, [seededMemory.id]);
      expect(inside.rows[0]).toEqual({
        authorization_revision: '2',
        subject_evidence_digest: null,
        status: 'invalidated',
      });
      await pool.query('ROLLBACK');

      const rolledBack = await pool.query<{
        authorization_revision: string;
        subject_evidence_digest: string;
        status: string;
      }>(`
        SELECT m.authorization_revision, m.subject_evidence_digest, c.status
        FROM l2_memories m
        JOIN l2_memory_subject_classifications c ON c.memory_id = m.id
        WHERE m.id = $1
      `, [seededMemory.id]);
      expect(rolledBack.rows[0]).toEqual({
        authorization_revision: '1',
        subject_evidence_digest: digest,
        status: 'current',
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('initializes the supported schema and hydrates seeded rows from postgres', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);

      const schemaTables = await pool.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('l2_memories', 'l2_memory_embeddings')
        ORDER BY table_name
      `);
      expect(schemaTables.rows.map(row => row.table_name)).toEqual(['l2_memories']);

      const embeddingColumn = await pool.query<{ column_name: string; data_type: string; udt_name: string }>(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'l2_memories'
          AND column_name = 'embedding'
      `);
      expect(embeddingColumn.rows).toHaveLength(1);
      expect(embeddingColumn.rows[0]).toMatchObject({
        column_name: 'embedding',
        data_type: 'USER-DEFINED',
        udt_name: 'vector',
      });

      const seededMemory = makeMemory({
        id: 'seeded-memory',
        text: 'Seeded memory for postgres hydration',
        sourceRef: 'seed:postgres',
        extractedAt: 1_700_000_100_000,
        lastAccessed: 1_700_000_100_000,
        tags: ['hydration', 'postgres'],
      });
      await seedMemoryRow(pool, seededMemory, [0.9, 0.1, 0.1, 0.1]);

      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      expect(await store.getById(seededMemory.id)).toMatchObject({
        id: seededMemory.id,
        text: seededMemory.text,
        sourceRef: seededMemory.sourceRef,
      });

      const textSearch = await store.searchByText('hydration', 10);
      expect(textSearch).toHaveLength(1);
      expect(textSearch[0]).toMatchObject({
        id: seededMemory.id,
        text: seededMemory.text,
      });

      const embeddingSearch = await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10);
      expect(embeddingSearch).toHaveLength(1);
      expect(embeddingSearch[0]).toMatchObject({
        id: seededMemory.id,
        text: seededMemory.text,
      });
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('persists insert, update, retrieval, and soft delete flows to postgres', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const memory = makeMemory({
        id: 'write-memory',
        text: 'Write path memory for postgres persistence',
        sourceRef: 'api:test:write',
        extractedAt: 1_700_000_200_000,
        lastAccessed: 1_700_000_200_000,
        tags: ['write', 'postgres'],
      });

      await store.insertMemory(memory, DEFAULT_EMBEDDING);

      const inserted = await pool.query<{
        id: string;
        text: string;
        salience: number;
        deleted_at: number | null;
        embedding: string | null;
      }>('SELECT id, text, salience, deleted_at, embedding::text AS embedding FROM l2_memories WHERE id = $1', [memory.id]);
      expect(inserted.rows).toHaveLength(1);
      expect(inserted.rows[0]).toMatchObject({
        id: memory.id,
        text: memory.text,
        deleted_at: null,
      });
      expect(inserted.rows[0]?.embedding).toBe('[0.9,0.1,0.1,0.1]');

      expect(await store.getById(memory.id)).toMatchObject({
        id: memory.id,
        text: memory.text,
      });
      const searchResults = await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10);
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0]).toMatchObject({
        id: memory.id,
        text: memory.text,
      });

      await store.updateMemory(memory.id, {
        salience: 0.95,
        contactId: 'contact-123',
      });

      const updated = await pool.query<{
        salience: number;
        contact_id: string | null;
      }>('SELECT salience, contact_id FROM l2_memories WHERE id = $1', [memory.id]);
      expect(updated.rows).toHaveLength(1);
      expect(updated.rows[0]).toMatchObject({
        salience: 0.95,
        contact_id: 'contact-123',
      });

      const deleteVersion = await store.softDeleteMemory(memory.id, {
        deleteId: 'delete-version-123',
        deletedBy: 'integration-test',
        reason: 'cleanup',
      });
      expect(deleteVersion).toMatchObject({
        deleteId: 'delete-version-123',
        memoryId: memory.id,
        deletedBy: 'integration-test',
        deleteReason: 'cleanup',
      });

      const deleted = await pool.query<{
        deleted_at: number | null;
        deleted_by: string | null;
        delete_reason: string | null;
      }>('SELECT deleted_at, deleted_by, delete_reason FROM l2_memories WHERE id = $1', [memory.id]);
      expect(deleted.rows).toHaveLength(1);
      expect(deleted.rows[0]?.deleted_at).not.toBeNull();
      expect(Number(deleted.rows[0]?.deleted_at)).toBeGreaterThan(0);
      expect(deleted.rows[0]).toMatchObject({
        deleted_by: 'integration-test',
        delete_reason: 'cleanup',
      });

      const deleteVersionRows = await pool.query<{
        delete_id: string;
        memory_id: string;
        deleted_by: string | null;
        delete_reason: string | null;
      }>('SELECT delete_id, memory_id, deleted_by, delete_reason FROM l2_memory_delete_versions WHERE delete_id = $1', ['delete-version-123']);
      expect(deleteVersionRows.rows).toHaveLength(1);
      expect(deleteVersionRows.rows[0]).toMatchObject({
        delete_id: 'delete-version-123',
        memory_id: memory.id,
        deleted_by: 'integration-test',
        delete_reason: 'cleanup',
      });

      expect(await store.countActiveMemories()).toBe(0);
      expect(await store.getById(memory.id)).toMatchObject({
        id: memory.id,
        deletedBy: 'integration-test',
      });
      expect(await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10)).toHaveLength(0);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rejects legacy embedding tables before startup', async () => {
    await withMemoryDatabase(async (pool) => {
      await pool.query(`
        CREATE TABLE l2_memory_embeddings (
          memory_id TEXT PRIMARY KEY,
          embedding DOUBLE PRECISION[] NOT NULL
        )
      `);

      await expect(createPostgresMemoryStoreFromPool(pool, 4)).rejects.toThrow(
        'Unsupported PostgreSQL memory schema detected: l2_memory_embeddings is no longer used',
      );
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rejects schemas missing l2_memories.embedding before startup', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      await pool.query('ALTER TABLE l2_memories DROP COLUMN embedding');

      await expect(createPostgresMemoryStoreFromPool(pool, 4)).rejects.toThrow(
        'PostgreSQL memory schema is missing l2_memories.embedding',
      );
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('upgrades legacy array embedding schemas during migration', async () => {
    await withMemoryDatabase(async (pool) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      await pool.query('ALTER TABLE l2_memories ALTER COLUMN embedding TYPE DOUBLE PRECISION[] USING ARRAY[0.1, 0.2, 0.3, 0.4]');

      const legacyMemory = makeMemory({
        id: 'legacy-array-memory',
        text: 'Legacy array embedding memory',
        sourceRef: 'legacy:array',
        extractedAt: 1_700_000_300_000,
        lastAccessed: 1_700_000_300_000,
        tags: ['legacy', 'array'],
      });
      const legacyInsertSql = [
        'INSERT INTO l2_memories (',
        '  id, text, type, importance, confidence, emotional_valence, formation_vad, salience,',
        '  salience_decay_anchor_at, source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,',
        '  scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,',
        '  retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,',
        '  delete_reason, embedding',
        ') VALUES (',
        '  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28',
        ')',
      ].join('\n');
      await pool.query(legacyInsertSql, [
        legacyMemory.id,
        legacyMemory.text,
        legacyMemory.type,
        legacyMemory.importance,
        legacyMemory.confidence,
        legacyMemory.emotionalValence,
        encodeJsonValue(legacyMemory.formationVAD),
        legacyMemory.salience,
        legacyMemory.salienceDecayAnchorAt ?? legacyMemory.lastAccessed,
        legacyMemory.sourceRef,
        legacyMemory.extractedAt,
        legacyMemory.lastAccessed,
        legacyMemory.accessCount,
        legacyMemory.supersededBy ?? null,
        encodeJsonValue(legacyMemory.tags),
        legacyMemory.scopeRef?.kind ?? null,
        legacyMemory.scopeRef?.id ?? null,
        legacyMemory.scopeRef?.label ?? null,
        encodeJsonValue(legacyMemory.scopeTags ?? []),
        encodeJsonValue(legacyMemory.provenanceRefs ?? []),
        legacyMemory.retentionClass ?? null,
        legacyMemory.sensitivity,
        encodeJsonValue(legacyMemory.consentFlags ?? {}),
        legacyMemory.contactId ?? null,
        legacyMemory.deletedAt ?? null,
        legacyMemory.deletedBy ?? null,
        legacyMemory.deleteReason ?? null,
        [0.9, 0.1, 0.1, 0.1],
      ]);

      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const embeddingColumnSql = [
        'SELECT data_type, udt_name',
        'FROM information_schema.columns',
        'WHERE table_schema = current_schema()',
        "  AND table_name = 'l2_memories'",
        "  AND column_name = 'embedding'",
      ].join('\n');
      const embeddingColumn = await pool.query<{ data_type: string; udt_name: string }>(embeddingColumnSql);
      expect(embeddingColumn.rows).toHaveLength(1);
      expect(embeddingColumn.rows[0]).toMatchObject({
        data_type: 'USER-DEFINED',
        udt_name: 'vector',
      });

      const embeddingSearch = await store.searchByEmbedding(DEFAULT_EMBEDDING, 0.99, 10);
      expect(embeddingSearch).toHaveLength(1);
      expect(embeddingSearch[0]).toMatchObject({
        id: legacyMemory.id,
        text: legacyMemory.text,
      });
    });
  }, INTEGRATION_TIMEOUT_MS);
  it('fails closed when pgvector extension is unavailable', async () => {
    const plainHarness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
    try {
      const database = await plainHarness.createDatabase();
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-memory-integration-missing-vector',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        await expect(createPostgresMemoryStoreFromPool(pool, 4)).rejects.toThrow(/extension .*vector|could not open extension control file/i);
      } finally {
        await pool.end();
      }
    } finally {
      await plainHarness.stop();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
