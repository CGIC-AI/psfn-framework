import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPool } from '../../../persistence/postgres.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import { MemoryRetriever } from '../retrieval.js';
import { createSubjectAuthorizedMemoryStore } from '../subject-authorized-store.js';
import type { PurrMemory } from '../types.js';

// psfn-framework-s889d: the snapshot a turn reads for its prompt is the
// record of what that prompt rendered. A refresh that lands afterwards must
// not rewrite it, and the snapshot must carry the provenance of the retrieval
// that produced it so the turn can report exactly that.

const INTEGRATION_TIMEOUT_MS = 120_000;
const QUERY_TEXT = 'harbor lighthouse restoration';
const NEXT_QUERY_TEXT = 'lighthouse restoration crew schedule';
const QUERY_EMBEDDING = new Float32Array([1, 0, 0, 0]);
const NEXT_QUERY_EMBEDDING = new Float32Array([0, 1, 0, 0]);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withMemoryDatabase<T>(handler: (pool: Pool) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-active-context-snapshot-integration',
    allowExitOnIdle: true,
    max: 4,
  });
  try {
    return await handler(pool);
  } finally {
    await pool.end();
  }
}

function memory(id: string, text: string, provenanceRef: string): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0.1,
    salience: 0.5,
    sourceRef: 'api:active-context-snapshot',
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: ['lighthouse'],
    sensitivity: 'public',
    consentFlags: {},
    provenance: { subjectContactId: 'contact-a' },
    provenanceRefs: [provenanceRef],
  };
}

describe('active memory snapshot isolation (real Postgres retriever)', () => {
  it('keeps a consumed snapshot and its provenance unchanged when a later refresh lands', async () => {
    await withMemoryDatabase(async (pool) => {
      const store = await createPostgresMemoryStoreFromPool(pool, 4);
      const embeddings: EmbeddingProviderPort = {
        dims: 4,
        embed: async text => (text === NEXT_QUERY_TEXT ? NEXT_QUERY_EMBEDDING : QUERY_EMBEDDING),
        embedBatch: async texts => texts.map(text => (text === NEXT_QUERY_TEXT ? NEXT_QUERY_EMBEDDING : QUERY_EMBEDDING)),
      };
      const authorizedStore = createSubjectAuthorizedMemoryStore(store, { viewerContactId: 'contact-a' });
      const retriever = new MemoryRetriever(authorizedStore, embeddings, {
        retrievalThreshold: 0.5,
        telemetryEnabled: false,
        contextWindow: 32_000,
      });
      const request = {
        contextText: QUERY_TEXT,
        channelId: 'api:active-context-snapshot',
        trustLevel: 'primary' as const,
      };

      await store.insertMemory(
        memory('mem-consumed', 'The harbor lighthouse restoration needs new lens glass.', 'session:snapshot:entry-1'),
        QUERY_EMBEDDING,
      );
      await retriever.refreshActiveMemoryContext(request);
      const consumed = retriever.getActiveMemoryContext(request);
      expect(consumed?.selectedMemoryIds).toEqual(['mem-consumed']);
      // The same refs the refresh's retrieval telemetry reports: the memory,
      // its source, and its stored provenance.
      expect(consumed?.manifestSeed?.provenanceRefs).toEqual([
        'memory:mem-consumed',
        'api:active-context-snapshot',
        'session:snapshot:entry-1',
      ]);
      const consumedCopy = structuredClone(consumed);

      await store.insertMemory(
        memory('mem-landed', 'The harbor lighthouse restoration crew starts on Monday.', 'session:snapshot:entry-2'),
        NEXT_QUERY_EMBEDDING,
      );
      // The next message's refresh: new text, same active-context identity.
      // The consumed memory is retired first, so the refreshed snapshot
      // necessarily differs from the one the turn rendered.
      await authorizedStore.softDeleteMemory('mem-consumed', {
        deletedBy: 'integration:test',
        reason: 'snapshot isolation',
      });
      retriever.invalidateActiveMemoryContexts({ memoryIds: ['mem-consumed'], reason: 'snapshot isolation' });
      const nextRequest = { ...request, contextText: NEXT_QUERY_TEXT };
      await retriever.refreshActiveMemoryContext(nextRequest);
      const landed = retriever.getActiveMemoryContext(nextRequest);
      expect(landed?.selectedMemoryIds).toEqual(['mem-landed']);
      expect(landed?.manifestSeed?.provenanceRefs).toContain('session:snapshot:entry-2');

      // The turn's copy is a value, not a live view of the retriever state.
      expect(consumed).toEqual(consumedCopy);
      expect(consumed?.contextBlock).not.toContain('crew starts on Monday');
      expect(consumed?.disclosureMemorySources?.map(source => source.ref)).toEqual(['memory:mem-consumed']);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
