import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult } from 'pg';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { MemoryRetriever } from './retrieval.js';
import { createPostgresMemoryStore } from './postgres-store.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
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
  embedding: string | null;
}

function decodeEmbeddingLiteral(value: string | null): number[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(entry => Number(entry.trim())).filter(entry => Number.isFinite(entry));
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const lv = left[index] ?? 0;
    const rv = right[index] ?? 0;
    dot += lv * rv;
    leftNorm += lv * lv;
    rightNorm += rv * rv;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

class FakeMemoryPool {
  readonly memories = new Map<string, MemoryRow>();
  readonly queryFailures: Array<{ fragment: string; error: Error }>;
  readonly schemaHasEmbeddingColumn: boolean;
  readonly schemaHasLegacyEmbeddingTable: boolean;
  readonly schemaUsesPgvector: boolean;

  constructor(options: {
    schemaHasEmbeddingColumn?: boolean;
    schemaHasLegacyEmbeddingTable?: boolean;
    schemaUsesPgvector?: boolean;
    queryFailures?: Array<{ fragment: string; errorMessage: string }>;
  } = {}) {
    this.schemaHasEmbeddingColumn = options.schemaHasEmbeddingColumn ?? true;
    this.schemaHasLegacyEmbeddingTable = options.schemaHasLegacyEmbeddingTable ?? false;
    this.schemaUsesPgvector = options.schemaUsesPgvector ?? true;
    this.queryFailures = (options.queryFailures ?? []).map(failure => ({
      fragment: failure.fragment,
      error: new Error(failure.errorMessage),
    }));
  }

  failNextQuery(fragment: string, errorMessage: string): void {
    this.queryFailures.push({ fragment, error: new Error(errorMessage) });
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const failureIndex = this.queryFailures.findIndex(failure => normalized.includes(failure.fragment));
    if (failureIndex >= 0) {
      const [failure] = this.queryFailures.splice(failureIndex, 1);
      throw failure.error;
    }
    if (
      normalized === 'begin'
      || normalized === 'commit'
      || normalized === 'rollback'
      || normalized.startsWith('create extension')
      || normalized.startsWith('create table')
      || normalized.startsWith('create index')
      || normalized.startsWith('do $')
      ) {
        return { rows: [], rowCount: 0, command: 'OK', oid: 0, fields: [] } as QueryResult;
      }

    if (normalized.includes('information_schema.tables')) {
      return {
        rows: this.schemaHasLegacyEmbeddingTable
          ? [{ table_name: 'l2_memory_embeddings' }]
          : [],
        rowCount: this.schemaHasLegacyEmbeddingTable ? 1 : 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.includes('information_schema.columns') && normalized.includes("table_name = 'l2_memories'")) {
      return {
        rows: this.schemaHasEmbeddingColumn
          ? [{
            table_name: 'l2_memories',
            column_name: 'embedding',
            data_type: this.schemaUsesPgvector ? 'USER-DEFINED' : 'ARRAY',
            udt_name: this.schemaUsesPgvector ? 'vector' : '_float8',
          }]
          : [],
        rowCount: this.schemaHasEmbeddingColumn ? 1 : 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.includes('1 - (embedding <=> $1::vector) as similarity')) {
      const queryEmbedding = decodeEmbeddingLiteral(typeof values[0] === 'string' ? values[0] : null);
      const threshold = Number(values[1] ?? 0);
      const rows = [...this.memories.values()]
        .filter((row) => !row.superseded_by && row.deleted_at === null && row.embedding)
        .map((row) => ({
          ...row,
          similarity: cosineSimilarity(queryEmbedding, decodeEmbeddingLiteral(row.embedding)),
        }))
        .filter((row) => row.similarity >= threshold)
        .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extracted_at - left.extracted_at);
      return {
        rows,
        rowCount: rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
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
        embedding: typeof values[26] === 'string' ? values[26] : null,
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

describe('postgres memory store unit coverage', () => {
  it('keeps the supported postgres migration on l2_memories.embedding and omits the dead embeddings table', () => {
    const migrationSql = POSTGRES_MEMORY_MIGRATIONS.join('\n');
    expect(migrationSql).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(migrationSql).toContain('embedding VECTOR');
    expect(migrationSql).not.toContain('CREATE TABLE IF NOT EXISTS l2_memory_embeddings');
  });

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

  it('rejects inserts when persistence fails and leaves the in-memory cache untouched', async () => {
    const pool = new FakeMemoryPool();
    pool.failNextQuery('insert into l2_memories', 'simulated insert failure');
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const memory: PurrMemory = {
      id: 'mem-failure',
      text: 'failure path memory',
      type: 'semantic',
      importance: 0.4,
      confidence: 0.8,
      emotionalValence: 0.1,
      salience: 0.2,
      sourceRef: 'api:test:failure',
      extractedAt: 1_700_000_000_000,
      lastAccessed: 1_700_000_000_000,
      accessCount: 0,
      tags: ['failure'],
      sensitivity: 'low',
      consentFlags: {},
    };

    await expect(store.insertMemory(memory, new Float32Array([0.1, 0.2, 0.3, 0.4]))).rejects.toThrow(
      'simulated insert failure',
    );
    expect(await store.getById(memory.id)).toBeUndefined();
    expect(await store.countActiveMemories()).toBe(0);
    expect(pool.memories.has(memory.id)).toBe(false);
  });

  it('rejects soft deletes when persistence fails and keeps the active memory visible', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const memory: PurrMemory = {
      id: 'mem-soft-delete',
      text: 'soft delete memory',
      type: 'semantic',
      importance: 0.4,
      confidence: 0.8,
      emotionalValence: 0.1,
      salience: 0.2,
      sourceRef: 'api:test:delete',
      extractedAt: 1_700_000_000_100,
      lastAccessed: 1_700_000_000_100,
      accessCount: 0,
      tags: ['delete'],
      sensitivity: 'low',
      consentFlags: {},
    };

    await store.insertMemory(memory, new Float32Array([0.2, 0.3, 0.4, 0.5]));
    pool.failNextQuery('insert into l2_memory_delete_versions', 'simulated delete-version failure');

    await expect(store.softDeleteMemory(memory.id, {
      deleteId: 'delete-version',
      deletedBy: 'tester',
      reason: 'cleanup',
    })).rejects.toThrow(
      'simulated delete-version failure',
    );
    expect(await store.getById(memory.id)).toEqual(memory);
    expect(await store.getDeleteVersion('delete-version')).toBeUndefined();
    expect(await store.countActiveMemories()).toBe(1);
  });

  it('rejects postgres memory schemas that still use the legacy embeddings table', async () => {
    postgresMocks.activePool = new FakeMemoryPool({ schemaHasLegacyEmbeddingTable: true });

    await expect(createPostgresMemoryStore('postgres://unused', 4)).rejects.toThrow(
      'Unsupported PostgreSQL memory schema detected: l2_memory_embeddings is no longer used',
    );
  });

  it('rejects postgres memory schemas missing the embedding column on l2_memories', async () => {
    postgresMocks.activePool = new FakeMemoryPool({ schemaHasEmbeddingColumn: false });

    await expect(createPostgresMemoryStore('postgres://unused', 4)).rejects.toThrow(
      'PostgreSQL memory schema is missing l2_memories.embedding',
    );
  });

  it('rejects postgres memory schemas that still expose array embeddings', async () => {
    postgresMocks.activePool = new FakeMemoryPool({ schemaUsesPgvector: false });

    await expect(createPostgresMemoryStore('postgres://unused', 4)).rejects.toThrow(
      'PostgreSQL memory schema column l2_memories.embedding must use pgvector',
    );
  });
});
