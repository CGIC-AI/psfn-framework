import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult } from 'pg';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { MemoryRetriever } from './retrieval.js';
import { createPostgresMemoryStore } from './postgres-store.js';
import type { PurrMemory } from './types.js';
import { MemoryWriter } from './writer.js';

const postgresMocks = vi.hoisted(() => ({
  activePool: null as any,
  createPostgresPool: vi.fn(() => postgresMocks.activePool as never),
  ensurePostgresSchema: vi.fn(async () => undefined),
  executeQuery: vi.fn(async (_pool: unknown, text: string, values: readonly unknown[] = []) => {
    await postgresMocks.activePool.query(text, values);
  }),
  queryRows: vi.fn(async (_pool: unknown, text: string, values: readonly unknown[] = []) => {
    const result = await postgresMocks.activePool.query(text, values);
    return result.rows;
  }),
}));

interface MemoryRow {
  id: string;
  text: string;
  type: PurrMemory['type'];
  importance: number;
  confidence: number;
  emotional_valence: number;
  formation_vad: unknown;
  salience: number;
  source_ref: string;
  extracted_at: number;
  last_accessed: number;
  access_count: number;
  superseded_by: string | null;
  tags: unknown;
  scope_ref_kind: string | null;
  scope_ref_id: string | null;
  scope_ref_label: string | null;
  scope_tags: unknown;
  provenance_refs: unknown;
  retention_class: PurrMemory['retentionClass'] | null;
  sensitivity: PurrMemory['sensitivity'];
  consent_flags: unknown;
  contact_id: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
  delete_reason: string | null;
  embedding: number[] | null;
}

class FakeMemoryPool {
  readonly memories = new Map<string, MemoryRow>();

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (
      normalized === 'begin'
      || normalized === 'commit'
      || normalized === 'rollback'
      || normalized.startsWith('create table')
      || normalized.startsWith('create index')
    ) {
      return { rows: [], rowCount: 0, command: 'OK', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memories')) {
      return {
        rows: [...this.memories.values()],
        rowCount: this.memories.size,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.includes('from l2_memory_delete_versions')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memory_abstraction_links')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from memory_links')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from contact_profiles')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from scratchpad_entries')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into l2_memories')) {
      const row: MemoryRow = {
        id: String(values[0] ?? ''),
        text: String(values[1] ?? ''),
        type: values[2] as PurrMemory['type'],
        importance: Number(values[3] ?? 0),
        confidence: Number(values[4] ?? 0),
        emotional_valence: Number(values[5] ?? 0),
        formation_vad: values[6] ?? null,
        salience: Number(values[7] ?? 0),
        source_ref: String(values[8] ?? ''),
        extracted_at: Number(values[9] ?? 0),
        last_accessed: Number(values[10] ?? 0),
        access_count: Number(values[11] ?? 0),
        superseded_by: values[12] == null ? null : String(values[12]),
        tags: values[13] ?? [],
        scope_ref_kind: values[14] == null ? null : String(values[14]),
        scope_ref_id: values[15] == null ? null : String(values[15]),
        scope_ref_label: values[16] == null ? null : String(values[16]),
        scope_tags: values[17] ?? [],
        provenance_refs: values[18] ?? [],
        retention_class: values[19] == null ? null : (values[19] as PurrMemory['retentionClass']),
        sensitivity: values[20] as PurrMemory['sensitivity'],
        consent_flags: values[21] ?? {},
        contact_id: values[22] == null ? null : String(values[22]),
        deleted_at: values[23] == null ? null : Number(values[23]),
        deleted_by: values[24] == null ? null : String(values[24]),
        delete_reason: values[25] == null ? null : String(values[25]),
        embedding: Array.isArray(values[26]) ? (values[26] as number[]) : null,
      };
      this.memories.set(row.id, row);
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }

    throw new Error(`Unhandled SQL in FakeMemoryPool: ${text}`);
  }
}

vi.mock('../../persistence/postgres.js', () => ({
  createPostgresPool: postgresMocks.createPostgresPool,
  ensurePostgresSchema: postgresMocks.ensurePostgresSchema,
  executeQuery: postgresMocks.executeQuery,
  queryRows: postgresMocks.queryRows,
}));

function makeEmbeddingProvider(): EmbeddingProviderPort {
  return {
    embed: async () => new Float32Array([0.9, 0.1, 0.1, 0.1]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([0.9, 0.1, 0.1, 0.1])),
    dims: 4,
  };
}

afterEach(() => {
  postgresMocks.createPostgresPool.mockClear();
  postgresMocks.ensurePostgresSchema.mockClear();
  postgresMocks.executeQuery.mockClear();
  postgresMocks.queryRows.mockClear();
});

describe('postgres memory store', () => {
  it('supports writer and retriever flow behind MemoryStorePort', async () => {
    postgresMocks.activePool = new FakeMemoryPool();
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const embeddings = makeEmbeddingProvider();
    const writer = new MemoryWriter(store, embeddings);
    const retriever = new MemoryRetriever(store, embeddings, {
      telemetryEnabled: false,
      contextWindow: 32_000,
    });

    const write = await writer.write({
      text: 'V prefers oolong tea in the morning',
      type: 'semantic',
      sourceRef: 'api:test:conversation',
    });
    const retrieved = await retriever.retrieve('oolong tea', 'api:test', 'primary');

    expect(write.action).toBe('created');
    expect(await store.countActiveMemories()).toBe(1);
    expect(retrieved).toContain('V prefers oolong tea in the morning');
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith('postgres://unused', {
      applicationName: 'psfn-memory',
      allowExitOnIdle: true,
    });
    expect(postgresMocks.ensurePostgresSchema).toHaveBeenCalled();
  });
});
