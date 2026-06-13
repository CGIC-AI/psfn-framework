import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult } from 'pg';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { MemoryRetriever } from './retrieval.js';
import { createPostgresMemoryStore } from './postgres-store.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import type { PurrMemory } from './types.js';
import { MemoryWriter } from './writer.js';
import { buildHighImpactLowConfidenceReviewInput } from './maintenance-review.js';

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

interface MemoryEvolutionLinkRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation: string;
  confidence: number;
  reason: string | null;
  source_ref: string | null;
  source_type: string | null;
  provenance_refs: unknown;
  provenance_json: unknown;
  created_at: number;
}

interface ScratchpadTestRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

function postgresMemoryMigrationSql(): string {
  return POSTGRES_MEMORY_MIGRATIONS.join('\n').replace(/\s+/g, ' ').trim();
}

function expectMemoryMigrationSqlToContain(fragments: readonly string[]): void {
  const migrationSql = postgresMemoryMigrationSql();
  for (const fragment of fragments) {
    expect(migrationSql).toContain(fragment.replace(/\s+/g, ' ').trim());
  }
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
  readonly evolutionLinks = new Map<string, MemoryEvolutionLinkRow>();
  readonly maintenanceReviews = new Map<string, Record<string, unknown>>();
  readonly scratchpadEntries = new Map<string, ScratchpadTestRow>();
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

    if (normalized.includes('from memory_evolution_links')) {
      const rows = [...this.evolutionLinks.values()];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from memory_links')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memory_maintenance_reviews')) {
      const rows = [...this.maintenanceReviews.values()];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from contact_profiles')) {
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into scratchpad_entries')) {
      const row: ScratchpadTestRow = {
        id: String(values[0] ?? ''),
        content: String(values[1] ?? ''),
        created_at: Number(values[2] ?? 0),
        updated_at: Number(values[3] ?? 0),
      };
      this.scratchpadEntries.set(row.id, row);
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('delete from scratchpad_entries')) {
      const id = String(values[0] ?? '');
      const deleted = this.scratchpadEntries.delete(id);
      return { rows: [], rowCount: deleted ? 1 : 0, command: 'DELETE', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from scratchpad_entries')) {
      const rows = [...this.scratchpadEntries.values()]
        .sort((left, right) => right.updated_at - left.updated_at || right.created_at - left.created_at);
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
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

    if (normalized.startsWith('insert into memory_evolution_links')) {
      const row: MemoryEvolutionLinkRow = {
        id: String(values[0] ?? ''),
        source_memory_id: String(values[1] ?? ''),
        target_memory_id: String(values[2] ?? ''),
        relation: String(values[3] ?? ''),
        confidence: Number(values[4] ?? 1),
        reason: values[5] == null ? null : String(values[5]),
        source_ref: values[6] == null ? null : String(values[6]),
        source_type: values[7] == null ? null : String(values[7]),
        provenance_refs: values[8] ? JSON.parse(String(values[8])) : [],
        provenance_json: values[9] ? JSON.parse(String(values[9])) : {},
        created_at: Number(values[10] ?? 0),
      };
      this.evolutionLinks.set(
        `${row.source_memory_id}::${row.target_memory_id}::${row.relation}`,
        row,
      );
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into l2_memory_maintenance_reviews')) {
      const row = {
        id: String(values[0] ?? ''),
        kind: String(values[1] ?? ''),
        status: String(values[2] ?? ''),
        subject_memory_id: String(values[3] ?? ''),
        candidate_memory_ids: values[4] ? JSON.parse(String(values[4])) : [],
        state_json: values[5] ? JSON.parse(String(values[5])) : {},
        quarantine_reason: values[6] == null ? null : String(values[6]),
        created_at: Number(values[7] ?? 0),
        updated_at: Number(values[8] ?? 0),
      };
      this.maintenanceReviews.set(row.id, row);
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

function makeMemory(id: string, text: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.8,
    sourceRef: `api:test:${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 1,
    tags: ['test'],
    sensitivity: 'personal',
    ...overrides,
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
    const migrationSql = postgresMemoryMigrationSql();
    expect(migrationSql).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(migrationSql).toContain('embedding VECTOR');
    expect(migrationSql).toContain("source_type TEXT NOT NULL DEFAULT 'unknown'");
    expect(migrationSql).toContain("provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(migrationSql).toContain(
      "ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown';",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;",
    );
    expect(migrationSql).not.toContain('CREATE TABLE IF NOT EXISTS l2_memory_embeddings');
    expect(migrationSql).not.toContain('l2_memory_embeddings USING');
  });

  it('adds Sprint 9 L2 patch provenance and memory evolution schema', () => {
    expectMemoryMigrationSqlToContain([
      'CREATE TABLE IF NOT EXISTS l2_memory_patch_events',
      'memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE',
      'source_ref TEXT NOT NULL',
      'source_type TEXT NOT NULL',
      "provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb",
      'patch_json JSONB NOT NULL',
      'previous_json JSONB NOT NULL',
      'next_json JSONB NOT NULL',
      'created_at BIGINT NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_l2_memory_patch_events_memory ON l2_memory_patch_events(memory_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_l2_memory_patch_events_provenance_gin ON l2_memory_patch_events USING GIN (provenance_json);',
      'CREATE TABLE IF NOT EXISTS memory_evolution_links',
      'source_memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE',
      'target_memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE',
      "CHECK (relation IN ('supersedes', 'updates', 'negates', 'conflicts_with'))",
      'CHECK (confidence >= 0 AND confidence <= 1)',
      'UNIQUE (source_memory_id, target_memory_id, relation)',
      'CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source ON memory_evolution_links(source_memory_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_target ON memory_evolution_links(target_memory_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_relation ON memory_evolution_links(relation, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_provenance_refs_gin ON memory_evolution_links USING GIN (provenance_refs);',
    ]);
  });

  it('adds Sprint 9 L0.1 episodic tables with status, canonicalization, lineage, and overlap indexes', () => {
    expectMemoryMigrationSqlToContain([
      'CREATE TABLE IF NOT EXISTS l01_episodes',
      "status TEXT NOT NULL DEFAULT 'canonical'",
      'canonical_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      'merged_into_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      'superseded_by_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      'artifact_refs JSONB NOT NULL DEFAULT \'[]\'::jsonb',
      'provenance_refs JSONB NOT NULL DEFAULT \'[]\'::jsonb',
      'scope_json JSONB NOT NULL DEFAULT \'{}\'::jsonb',
      'consent_flags JSONB NOT NULL DEFAULT \'{}\'::jsonb',
      'embedding VECTOR',
      'episode_json JSONB NOT NULL',
      "CHECK (status IN ('candidate', 'canonical', 'merged', 'superseded'))",
      'CREATE INDEX IF NOT EXISTS idx_l01_episodes_scope_time ON l01_episodes(channel_id, thread_id, started_at, ended_at);',
      'CREATE INDEX IF NOT EXISTS idx_l01_episodes_embedding_present ON l01_episodes(id) WHERE embedding IS NOT NULL;',
      'CREATE INDEX IF NOT EXISTS idx_l01_episodes_artifact_refs_gin ON l01_episodes USING GIN (artifact_refs);',
      'CREATE TABLE IF NOT EXISTS l01_episode_spans',
      'span_range TSTZRANGE',
      'span_json JSONB NOT NULL',
      'PRIMARY KEY (episode_id, span_id)',
      'CREATE INDEX IF NOT EXISTS idx_l01_episode_spans_range_gist ON l01_episode_spans USING GIST (span_range);',
      'CREATE TABLE IF NOT EXISTS l01_episode_arcs',
      'canonical_arc_id TEXT REFERENCES l01_episode_arcs(id) ON DELETE SET NULL',
      'merged_into_arc_id TEXT REFERENCES l01_episode_arcs(id) ON DELETE SET NULL',
      'superseded_by_arc_id TEXT REFERENCES l01_episode_arcs(id) ON DELETE SET NULL',
      'CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_artifact_refs_gin ON l01_episode_arcs USING GIN (artifact_refs);',
      'CREATE TABLE IF NOT EXISTS l01_episode_lineage',
      "CHECK (relation IN ('canonicalizes', 'merges', 'supersedes', 'splits_from', 'derived_from', 'conflicts_with', 'updates'))",
      'CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_source ON l01_episode_lineage(source_episode_id, created_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_target ON l01_episode_lineage(target_episode_id, created_at DESC);',
    ]);
  });

  it('adds Sprint 9 processing watermarks, episode review workflow, and memory diagnostics schema', () => {
    expectMemoryMigrationSqlToContain([
      'CREATE TABLE IF NOT EXISTS l01_processing_watermarks',
      'previous_watermark_json JSONB NOT NULL DEFAULT \'{}\'::jsonb',
      'next_watermark_json JSONB NOT NULL DEFAULT \'{}\'::jsonb',
      "CHECK (status IN ('active', 'reconciling', 'blocked', 'complete'))",
      "CHECK (reconciliation_status IN ('pending', 'clean', 'needs_review', 'blocked'))",
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_processing_watermarks_unique_scope',
      'CREATE TABLE IF NOT EXISTS l01_episode_candidates',
      'candidate_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      'canonical_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      'merged_into_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      'superseded_by_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL',
      "CHECK (status IN ('pending', 'accepted', 'canonical', 'merged', 'superseded', 'rejected', 'needs_review'))",
      'CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_watermark ON l01_episode_candidates(source_watermark_id, created_at DESC);',
      'CREATE TABLE IF NOT EXISTS l01_episode_reviews',
      "CHECK (recommended_action IN ('canonize', 'merge', 'supersede', 'reject', 'needs_human_review'))",
      'CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_provenance_refs_gin ON l01_episode_reviews USING GIN (provenance_refs);',
      'CREATE TABLE IF NOT EXISTS memory_processing_watermarks',
      "CHECK (status IN ('active', 'blocked', 'complete'))",
      'CREATE INDEX IF NOT EXISTS idx_memory_processing_watermarks_scope ON memory_processing_watermarks(scope_ref_kind, scope_ref_id);',
      'CREATE TABLE IF NOT EXISTS memory_eval_runs',
      "CHECK (status IN ('pending', 'running', 'passed', 'failed', 'blocked'))",
      'CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_artifacts_gin ON memory_eval_runs USING GIN (artifacts_json);',
    ]);
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

  it('expires Postgres scratchpad entries older than 24 hours during hydration', async () => {
    const pool = new FakeMemoryPool();
    const now = Date.now();
    pool.scratchpadEntries.set('fresh-note', {
      id: 'fresh-note',
      content: 'Keep the current working note.',
      created_at: now - 1_000,
      updated_at: now - 1_000,
    });
    pool.scratchpadEntries.set('expired-note', {
      id: 'expired-note',
      content: 'Old scratchpad content should not enter chat context.',
      created_at: now - (25 * 60 * 60 * 1000),
      updated_at: now - (25 * 60 * 60 * 1000),
    });
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);

    expect(store.listScratchpadEntries()).toEqual([
      {
        id: 'fresh-note',
        content: 'Keep the current working note.',
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      },
    ]);
    expect(await store.getScratchpadEntry('expired-note')).toBeUndefined();
    await vi.waitFor(() => {
      expect(pool.scratchpadEntries.has('expired-note')).toBe(false);
    });
  });

  it('persists and hydrates first-class memory evolution links', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    await store.insertMemory(makeMemory('m-source', 'Source memory'), new Float32Array([0.1, 0.2, 0.3, 0.4]));
    await store.insertMemory(makeMemory('m-target', 'Target memory'), new Float32Array([0.2, 0.3, 0.4, 0.5]));
    await store.insertMemory(makeMemory('m-other', 'Other target memory'), new Float32Array([0.3, 0.4, 0.5, 0.6]));

    const relations = ['supersedes', 'updates', 'negates', 'conflicts_with'] as const;
    const links: Awaited<ReturnType<typeof store.recordEvolutionLink>>[] = [];
    for (const [index, relation] of relations.entries()) {
      links.push(await store.recordEvolutionLink({
        linkId: `pg-evolution-${relation}`,
        sourceMemoryId: 'm-source',
        targetMemoryId: index === 3 ? 'm-other' : 'm-target',
        relation,
        confidence: 0.2 + (index * 0.2),
        reason: `${relation} reason`,
        sourceRef: `source:tool:memory_write|invocation:pg-call-${index}`,
        sourceType: 'tool_write',
        provenanceRefs: [`l0:pg-turn-${index}`, 'memory:m-source', ' '],
        provenance: {
          toolName: 'memory_write',
          toolCallId: `pg-call-${index}`,
        },
        createdAt: 10_000 + index,
      }));
    }

    expect(pool.evolutionLinks.size).toBe(4);
    expect([...pool.evolutionLinks.values()][0]).toMatchObject({
      source_memory_id: 'm-source',
      target_memory_id: 'm-target',
      relation: 'supersedes',
      confidence: 0.2,
      source_type: 'tool_write',
      provenance_refs: ['l0:pg-turn-0', 'memory:m-source'],
      provenance_json: {
        toolName: 'memory_write',
        toolCallId: 'pg-call-0',
      },
    });

    const bySource = await store.getEvolutionLinksForSourceMemory('m-source');
    expect(bySource.map(link => link.relation)).toEqual([
      'conflicts_with',
      'negates',
      'updates',
      'supersedes',
    ]);
    expect(await store.getEvolutionLinksForSourceMemory('m-source', 'updates')).toEqual([links[1]]);
    expect((await store.getEvolutionLinksForTargetMemory('m-target')).map(link => link.relation)).toEqual([
      'negates',
      'updates',
      'supersedes',
    ]);
    expect(await store.getEvolutionLinksForTargetMemory('m-other', 'conflicts_with')).toEqual([links[3]]);

    const hydrated = await createPostgresMemoryStore('postgres://unused', 4);
    await expect(hydrated.getEvolutionLinksForTargetMemory('m-target', 'supersedes')).resolves.toEqual([links[0]]);
  });

  it('reports Postgres memory maintenance review and evolution diagnostics', async () => {
    postgresMocks.activePool = new FakeMemoryPool();
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    await store.insertMemory(makeMemory('m-source', 'Source memory'), new Float32Array([0.1, 0.2, 0.3, 0.4]));
    await store.insertMemory(makeMemory('m-target', 'Target memory'), new Float32Array([0.2, 0.3, 0.4, 0.5]));
    await store.recordEvolutionLink({
      linkId: 'pg-evolution-supersedes',
      sourceMemoryId: 'm-source',
      targetMemoryId: 'm-target',
      relation: 'supersedes',
      createdAt: 1_100,
    });
    await store.recordEvolutionLink({
      linkId: 'pg-evolution-conflict',
      sourceMemoryId: 'm-target',
      targetMemoryId: 'm-source',
      relation: 'conflicts_with',
      createdAt: 1_300,
    });
    const review = buildHighImpactLowConfidenceReviewInput({
      memoryId: 'candidate-boundary-1',
      text: 'Potential high-impact boundary with weak evidence.',
      sourceRef: 'source:sleeptime|session:pg',
      confidence: 0.33,
      type: 'boundary',
      tags: ['boundary'],
      sensitivity: 'confidential',
    }, 1_000);
    expect(review).toBeDefined();
    await store.upsertMemoryMaintenanceReview(review!);

    await expect(store.getMemoryMaintenanceDiagnostics({ now: 4_000 })).resolves.toMatchObject({
      reviewCount: 1,
      pendingReviewCount: 1,
      reviewCountsByKind: { high_impact_low_confidence: 1 },
      reviewCountsByStatus: { pending: 1 },
      oldestPendingReviewAgeMs: 3_000,
      averagePendingReviewAgeMs: 3_000,
      evolutionDecisionCount: 2,
      evolutionDecisionCountsByRelation: {
        supersedes: 1,
        updates: 0,
        negates: 0,
        conflicts_with: 1,
      },
      supersessionDecisionCount: 1,
      conflictDecisionCount: 1,
      latestEvolutionDecisionAt: 1_300,
    });
  });

  it('rejects invalid postgres memory evolution link confidence and endpoints', async () => {
    postgresMocks.activePool = new FakeMemoryPool();
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    await expect(store.recordEvolutionLink({
      sourceMemoryId: 'm-source',
      targetMemoryId: 'm-target',
      relation: 'updates',
      confidence: -0.1,
    })).rejects.toThrow('confidence must be between 0 and 1');

    await expect(store.recordEvolutionLink({
      sourceMemoryId: 'm-source',
      targetMemoryId: 'm-target',
      relation: 'updates',
      confidence: 1.1,
    })).rejects.toThrow('confidence must be between 0 and 1');

    await expect(store.recordEvolutionLink({
      sourceMemoryId: 'same',
      targetMemoryId: 'same',
      relation: 'conflicts_with',
    })).rejects.toThrow('distinct source and target');
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
