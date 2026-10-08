import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../persistence/postgres.js';
import { createPostgresMemoryStoreFromPool } from '../../faculties/memory/postgres-store.js';
import { MemoryRetriever } from '../../faculties/memory/retrieval.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { runRLMLoop } from '../../core/tools/analysis-workbench/loop.js';
import { DEFAULT_REPL_CONFIG } from '../../core/tools/analysis-workbench/types.js';
import { PGVECTOR_POSTGRES_TEST_IMAGE, startPostgresTestHarness, type PostgresTestHarness } from '../../test-support/postgres-test-harness.js';
import { createScriptedE2ELLMProvider } from './test-llm-provider.js';

let postgres: PostgresTestHarness | undefined;
beforeAll(async () => { postgres = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE }); });
afterAll(async () => { await postgres?.stop(); });

const reflection = {
  channelId: 'internal:reflection:e2e-memory',
  requesterProvenance: 'self_directed' as const,
  requestAudience: 'self' as const,
};
const question = "What is the Partner's favorite dessert?";
const embeddings = {
  dims: 4,
  embed: async () => new Float32Array([1, 0, 0, 0]),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0, 0])),
};

describe('scripted model with durable memory and real sandbox', () => {
  it('recalls only an authorized persisted fact after reconnect and records actual search evidence', async () => {
    const { databaseUrl } = await postgres!.createDatabase();
    let pool = createPostgresPool(databaseUrl, { max: 1 });
    try {
      const marker = `plum crumble ${randomUUID()}`;
      const fact: PurrMemory = {
        id: randomUUID(), text: `The Partner's favorite dessert is ${marker}.`, type: 'semantic',
        importance: 0.9, confidence: 1, emotionalValence: 0, salience: 1,
        sourceRef: 'internal:reflection:e2e-memory', extractedAt: Date.now(), lastAccessed: Date.now(),
        accessCount: 0, tags: ['dessert'], sensitivity: 'personal', consentFlags: {},
        provenance: { subjectScope: 'companion_internal' },
      };
      const writer = await createPostgresMemoryStoreFromPool(pool, embeddings.dims);
      await writer.insertMemory(fact, await embeddings.embed());
      await pool.end();
      pool = createPostgresPool(databaseUrl, { max: 1 });
      const memoryStore = await createPostgresMemoryStoreFromPool(pool, embeddings.dims);
      const model = createScriptedE2ELLMProvider();
      const retriever = new MemoryRetriever(memoryStore, embeddings,
        { retrievalThreshold: 0.99, telemetryEnabled: false, contextWindow: 32_000 },
        undefined, null, null, null, null, true);
      const context = await runWithRequestContext(reflection, () => retriever.retrieve(
        question, reflection.channelId, 'primary', undefined, undefined, undefined,
        undefined, undefined, undefined, { accessScope: 'companion_self_reflection' },
      ));
      expect(context).toContain(marker);
      const recalled = await model.stream({ systemPrompt: context, messages: [{ role: 'user', content: question }] });
      expect(recalled.content).toContain(marker);
      const absent = await model.stream({ systemPrompt: '', messages: [{ role: 'user', content: question }] });
      expect(absent.content).not.toContain(marker);
      const deps = {
        llmProvider: model, memoryStore, embeddingService: embeddings,
        sessionManager: null, config: DEFAULT_REPL_CONFIG,
      };
      // A contact-bound request uses production subject authorization without
      // the self-reflection audience; it cannot access companion-private rows.
      const denied = await runWithRequestContext({ viewerMemorySubjectContactId: 'unrelated-contact' },
        () => runRLMLoop('How many memories mention the Partner?', deps));
      expect(denied.answer).toBe('[]');
      expect(denied.evidence).toContainEqual(expect.objectContaining({ source: 'memory_search', resultCount: 0 }));
      const found = await runWithRequestContext({ requesterProvenance: 'system' },
        () => runRLMLoop('How many memories mention the Partner?', deps));
      expect(JSON.parse(found.answer)).toEqual([fact.text]);
      expect(found.evidence).toContainEqual(expect.objectContaining({ source: 'memory_search', resultCount: 1, snippet: fact.text }));
      expect(found.steps).toContainEqual(expect.objectContaining({ code: expect.stringContaining('memory_search('), error: null }));
      await memoryStore.softDeleteMemory(fact.id, { deletedBy: 'e2e:negative-control' });
      const removed = await runWithRequestContext({ requesterProvenance: 'system' },
        () => runRLMLoop('How many memories mention the Partner?', deps));
      expect(removed.answer).toBe('[]');
      expect(removed.evidence).toContainEqual(expect.objectContaining({ source: 'memory_search', resultCount: 0 }));
    } finally {
      await pool.end();
    }
  });
});
