import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { QueryResult } from 'pg';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { MemoryRetriever } from './retrieval.js';
import { createPostgresMemoryStore } from './postgres-store.js';
import { ANN_MAX_CANDIDATES } from './postgres-store/embedding-index.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import {
  DURABLE_PREFERENCE_MEMORY_TAG,
  DURABLE_RETENTION_TAG,
  type PurrMemory,
} from './types.js';
import { MemoryWriter } from './writer.js';
import { buildHighImpactLowConfidenceReviewInput } from './maintenance-review.js';
import { SalienceDecay } from './decay.js';
import { collectRecentLexicalMemoryCandidates } from './retrieval/candidates.js';
import { createDefaultMemoryRetrievalPolicy } from '../../system/config/memory-retrieval-policy.js';

const postgresMocks = vi.hoisted(() => {
  const activePool: FakeMemoryPool | null = null;
  return {
    activePool,
    createPostgresPool: vi.fn(() => postgresMocks.activePool as never),
    ensurePostgresSchema: vi.fn(async () => undefined),
    executeQuery: vi.fn(async (_pool: unknown, text: string, values: readonly unknown[] = []) => {
      return await postgresMocks.activePool.query(text, values);
    }),
    queryRows: vi.fn(async (_pool: unknown, text: string, values: readonly unknown[] = []) => {
      const result = await postgresMocks.activePool.query(text, values);
      return result.rows;
    }),
  };
});

interface MemoryRow {
  id: string;
  text: string;
  type: PurrMemory['type'];
  importance: number;
  confidence: number;
  emotional_valence: number;
  formation_vad: unknown;
  salience: number;
  salience_decay_anchor_at: number;
  source_ref: string;
  source_type: string | null;
  provenance_json: unknown;
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
  created_at: number | string;
  updated_at: number | string;
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

function decodeJsonInput(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

class FakeTransactionClient {
  readonly statements: string[] = [];
  released = false;
  private snapshot: {
    memories: Map<string, MemoryRow>;
    patchEvents: Array<Record<string, unknown>>;
    subjectBackfillCheckpoint: FakeMemoryPool['subjectBackfillCheckpoint'];
  } | null = null;

  constructor(private readonly pool: FakeMemoryPool) {}

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    this.statements.push(normalized);
    if (normalized === 'begin') {
      this.snapshot = {
        memories: new Map(this.pool.memories),
        patchEvents: [...this.pool.patchEvents],
        subjectBackfillCheckpoint: this.pool.subjectBackfillCheckpoint
          ? { ...this.pool.subjectBackfillCheckpoint }
          : null,
      };
      return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] } as QueryResult;
    }
    if (normalized === 'commit') {
      this.snapshot = null;
      return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] } as QueryResult;
    }
    if (normalized === 'rollback') {
      if (this.snapshot) {
        this.pool.memories.clear();
        for (const [id, row] of this.snapshot.memories) this.pool.memories.set(id, row);
        this.pool.patchEvents.splice(0, this.pool.patchEvents.length, ...this.snapshot.patchEvents);
        this.pool.subjectBackfillCheckpoint = this.snapshot.subjectBackfillCheckpoint
          ? { ...this.snapshot.subjectBackfillCheckpoint }
          : null;
        this.snapshot = null;
      }
      return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] } as QueryResult;
    }
    return this.pool.query(text, values);
  }

  release(): void {
    this.released = true;
  }
}

class FakeMemoryPool {
  readonly memories = new Map<string, MemoryRow>();
  readonly evolutionLinks = new Map<string, MemoryEvolutionLinkRow>();
  readonly maintenanceReviews = new Map<string, Record<string, unknown>>();
  readonly scratchpadEntries = new Map<string, ScratchpadTestRow>();
  readonly patchEvents: Array<Record<string, unknown>> = [];
  readonly clients: FakeTransactionClient[] = [];
  /** LIMIT parameter sent to Postgres by each raw embedding search (a27w.3 bound). */
  readonly embeddingSearchLimits: number[] = [];
  subjectBackfillCheckpoint: {
    cursor_memory_id: string | null;
    completed: boolean;
    processed_count: string;
  } | null = null;
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

  async connect(): Promise<FakeTransactionClient> {
    const client = new FakeTransactionClient(this);
    this.clients.push(client);
    return client;
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

    if (normalized.startsWith('select set_config')) {
      return {
        rows: [{ set_config: String(values[0] ?? '') }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.includes('from pg_extension') && normalized.includes('extversion')) {
      return {
        rows: [{ extversion: '0.8.2' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
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

    if (normalized.startsWith("select to_regclass('contacts')::text as table_name")) {
      return {
        rows: [{ table_name: null }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.includes('as current_classification_count')
      && normalized.includes('from l2_memories memory')) {
      return {
        rows: [{
          total_memory_count: String(this.memories.size),
          current_classification_count: String(this.memories.size),
        }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('select pg_try_advisory_xact_lock')) {
      return {
        rows: [{ locked: true }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('delete from l2_memory_subject_backfill_checkpoints')) {
      const deleted = this.subjectBackfillCheckpoint !== null;
      this.subjectBackfillCheckpoint = null;
      return { rows: [], rowCount: deleted ? 1 : 0, command: 'DELETE', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into l2_memory_subject_backfill_checkpoints')) {
      this.subjectBackfillCheckpoint ??= {
        cursor_memory_id: null,
        completed: false,
        processed_count: '0',
      };
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memory_subject_backfill_checkpoints')) {
      return {
        rows: this.subjectBackfillCheckpoint ? [{ ...this.subjectBackfillCheckpoint }] : [],
        rowCount: this.subjectBackfillCheckpoint ? 1 : 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('update l2_memory_subject_backfill_checkpoints')) {
      this.subjectBackfillCheckpoint = {
        cursor_memory_id: values[1] == null ? null : String(values[1]),
        completed: values[2] === true,
        processed_count: String(values[3] ?? 0),
      };
      return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memories')
      && normalized.includes('authorization_revision')
      && normalized.includes('for update')) {
      const cursor = values[0] == null ? null : String(values[0]);
      const limit = Number(values[1] ?? 100);
      const rows = [...this.memories.values()]
        .filter(row => cursor === null || row.id > cursor)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(row => ({ ...row, authorization_revision: '1' }));
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('1 - (embedding <=> $1::vector) as similarity')) {
      const queryEmbedding = decodeEmbeddingLiteral(typeof values[0] === 'string' ? values[0] : null);
      const threshold = Number(values[1] ?? 0);
      // The raw path appends its bounded LIMIT after optional scope parameters.
      this.embeddingSearchLimits.push(Number(values.at(-1)));
      let rows = [...this.memories.values()]
        .filter((row) => !row.superseded_by && row.deleted_at === null && row.embedding)
        .map((row) => ({
          ...row,
          similarity: cosineSimilarity(queryEmbedding, decodeEmbeddingLiteral(row.embedding)),
        }))
        .filter((row) => row.similarity >= threshold)
        .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extracted_at - left.extracted_at);
      if (normalized.includes('scope_ref_kind = $3') && normalized.includes('scope_ref_id = $4')) {
        rows = rows.filter(row => row.scope_ref_kind === values[2] && row.scope_ref_id === values[3]);
      }
      if (normalized.includes('scope_tags ?| $3::text[]')) {
        const scopeTags = new Set(values[2] as string[]);
        rows = rows.filter(row => Array.isArray(row.scope_tags)
          && row.scope_tags.some(tag => scopeTags.has(String(tag))));
      }
      return {
        rows,
        rowCount: rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('select id, embedding::text as embedding from l2_memories')) {
      const target = this.memories.get(String(values[0] ?? ''));
      const rows = target ? [{ id: target.id, embedding: target.embedding }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memories')
      && normalized.includes('embedding is not null')
      && normalized.includes('extracted_at >=')) {
      const since = Number(values[0] ?? 0);
      const limit = Number(values[1] ?? 4096);
      const rows = [...this.memories.values()]
        .filter(row => !row.superseded_by && row.deleted_at === null && row.embedding && Number(row.extracted_at) >= since)
        .sort((left, right) => Number(left.extracted_at) - Number(right.extracted_at) || left.id.localeCompare(right.id))
        .slice(0, limit);
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.includes('from l2_memories')
      && normalized.includes('extracted_at >=')
      && normalized.includes('extracted_at <=')
      && normalized.includes('order by extracted_at desc, id desc')) {
      const fromMs = Number(values[0] ?? 0);
      const toMs = Number(values[1] ?? 0);
      const limit = Number(values.at(-1) ?? 0);
      const conversationId = normalized.includes("provenance_json ->> 'channelid'")
        ? String(values[2] ?? '')
        : null;
      const contactId = normalized.includes('contact_id =')
        ? String(values[3] ?? '')
        : null;
      const rows = [...this.memories.values()]
        .filter(row => !row.superseded_by && row.deleted_at === null)
        .filter(row => Number(row.extracted_at) >= fromMs && Number(row.extracted_at) <= toMs)
        .filter((row) => {
          if (conversationId === null) return true;
          const provenance = row.provenance_json as { channelId?: unknown };
          const conversationMatches = provenance.channelId === conversationId
            || (row.scope_ref_kind === 'conversation' && row.scope_ref_id === conversationId);
          return conversationMatches || (contactId !== null && row.contact_id === contactId);
        })
        .sort((left, right) => Number(right.extracted_at) - Number(left.extracted_at)
          || right.id.localeCompare(left.id))
        .slice(0, limit);
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
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
        formation_vad: decodeJsonInput(values[6], null),
        salience: Number(values[7] ?? 0),
        salience_decay_anchor_at: Number(values[8] ?? 0),
        source_ref: String(values[9] ?? ''),
        source_type: values[10] == null ? null : String(values[10]),
        provenance_json: decodeJsonInput(values[11], {}),
        extracted_at: Number(values[12] ?? 0),
        last_accessed: Number(values[13] ?? 0),
        access_count: Number(values[14] ?? 0),
        superseded_by: values[15] == null ? null : String(values[15]),
        tags: decodeJsonInput(values[16], []),
        scope_ref_kind: values[17] == null ? null : String(values[17]),
        scope_ref_id: values[18] == null ? null : String(values[18]),
        scope_ref_label: values[19] == null ? null : String(values[19]),
        scope_tags: decodeJsonInput(values[20], []),
        provenance_refs: decodeJsonInput(values[21], []),
        retention_class: values[22] == null ? null : (values[22] as PurrMemory['retentionClass']),
        sensitivity: values[23] as PurrMemory['sensitivity'],
        consent_flags: decodeJsonInput(values[24], {}),
        contact_id: values[25] == null ? null : String(values[25]),
        deleted_at: values[26] == null ? null : Number(values[26]),
        deleted_by: values[27] == null ? null : String(values[27]),
        delete_reason: values[28] == null ? null : String(values[28]),
        embedding: typeof values[29] === 'string' ? values[29] : null,
      };
      this.memories.set(row.id, row);
      return {
        rows: [{ authorization_revision: '1' }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('insert into l2_memory_subject_classifications')) {
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('delete from l2_memory_subject_contacts')) {
      return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into l2_memory_subject_contacts')) {
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }

    if (
      normalized.startsWith('update l2_memories set subject_evidence_digest = $2')
      && normalized.includes('returning id')
    ) {
      const id = String(values[0] ?? '');
      const exists = this.memories.has(id);
      return {
        rows: exists ? [{ id }] : [],
        rowCount: exists ? 1 : 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (
      normalized.startsWith('update l2_memories as memory')
      && normalized.includes('set salience = updates.salience')
    ) {
      let rowCount = 0;
      const rows: Array<{ id: string }> = [];
      for (let index = 0; index < values.length; index += 3) {
        const id = String(values[index] ?? '');
        const salience = Number(values[index + 1] ?? Number.NaN);
        const salienceDecayAnchorAt = Number(values[index + 2] ?? Number.NaN);
        const row = this.memories.get(id);
        if (!row || row.deleted_at !== null || row.superseded_by !== null) continue;
        row.salience = salience;
        row.salience_decay_anchor_at = salienceDecayAnchorAt;
        rowCount += 1;
        rows.push({ id });
      }
      return { rows, rowCount, command: 'UPDATE', oid: 0, fields: [] } as QueryResult;
    }

    if (
      normalized.startsWith('update l2_memories as memory')
      && normalized.includes('from (values')
      && normalized.includes('returning memory.id')
    ) {
      const columnsMatch = /as updates\(([^)]+)\)/.exec(normalized);
      const columns = columnsMatch
        ? columnsMatch[1].split(',').map(column => column.trim())
        : [];
      if (columns.length === 0) {
        throw new Error(`Unhandled bulk update columns in FakeMemoryPool: ${text}`);
      }
      let rowCount = 0;
      const rows: Array<{ id: string }> = [];
      for (let index = 0; index < values.length; index += columns.length) {
        const rowValues = new Map<string, unknown>();
        for (const [columnIndex, column] of columns.entries()) {
          rowValues.set(column, values[index + columnIndex]);
        }
        const id = String(rowValues.get('id') ?? '');
        const row = this.memories.get(id);
        if (!row || row.deleted_at !== null) continue;
        if (rowValues.has('type')) row.type = rowValues.get('type') as PurrMemory['type'];
        if (rowValues.has('sensitivity')) {
          row.sensitivity = rowValues.get('sensitivity') as PurrMemory['sensitivity'];
        }
        if (rowValues.has('retention_class')) {
          row.retention_class = rowValues.get('retention_class') as PurrMemory['retentionClass'];
        }
        if (rowValues.has('tags')) {
          row.tags = decodeJsonInput(rowValues.get('tags'), []);
        }
        rowCount += 1;
        rows.push({ id });
      }
      return { rows, rowCount, command: 'UPDATE', oid: 0, fields: [] } as QueryResult;
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

    if (normalized.startsWith('insert into l2_memory_patch_events')) {
      this.patchEvents.push({
        id: String(values[0] ?? ''),
        memory_id: String(values[1] ?? ''),
        source_ref: String(values[2] ?? ''),
      });
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

function makeMemoryRow(memory: PurrMemory, embedding: string | null = null): MemoryRow {
  return {
    id: memory.id,
    text: memory.text,
    type: memory.type,
    importance: memory.importance,
    confidence: memory.confidence,
    emotional_valence: memory.emotionalValence,
    formation_vad: memory.formationVAD ?? null,
    salience: memory.salience,
    salience_decay_anchor_at: memory.salienceDecayAnchorAt ?? memory.lastAccessed,
    source_ref: memory.sourceRef,
    source_type: memory.sourceType ?? null,
    provenance_json: memory.provenance ?? {},
    extracted_at: memory.extractedAt,
    last_accessed: memory.lastAccessed,
    access_count: memory.accessCount,
    superseded_by: memory.supersededBy ?? null,
    tags: memory.tags,
    scope_ref_kind: memory.scopeRef?.kind ?? null,
    scope_ref_id: memory.scopeRef?.id ?? null,
    scope_ref_label: memory.scopeRef?.label ?? null,
    scope_tags: memory.scopeTags ?? [],
    provenance_refs: memory.provenanceRefs ?? [],
    retention_class: memory.retentionClass ?? null,
    sensitivity: memory.sensitivity,
    consent_flags: memory.consentFlags ?? {},
    contact_id: memory.contactId ?? null,
    deleted_at: memory.deletedAt ?? null,
    deleted_by: memory.deletedBy ?? null,
    delete_reason: memory.deleteReason ?? null,
    embedding,
  };
}

afterEach(() => {
  postgresMocks.createPostgresPool.mockClear();
  postgresMocks.ensurePostgresSchema.mockClear();
  postgresMocks.executeQuery.mockClear();
  postgresMocks.queryRows.mockClear();
});

describe('postgres memory store unit coverage', () => {
  it('rejects text mutations that would retain the previous embedding', async () => {
    const pool = new FakeMemoryPool();
    const originalEmbedding = new Float32Array([1, 0, 0, 0]);
    const memory = makeMemory('patch-requires-embedding', 'Original memory text');
    pool.memories.set(memory.id, makeMemoryRow(memory, '[1,0,0,0]'));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    await expect(store.updateMemory(memory.id, {
      text: 'Patched memory text',
    })).rejects.toThrow('Memory text updates require a replacement embedding');

    expect((await store.getById(memory.id))?.text).toBe(memory.text);
    await expect(store.searchByEmbedding(originalEmbedding, 0.99, 10, undefined, {
      authorization: 'bypass-system-internal',
    }))
      .resolves.toEqual([expect.objectContaining({ id: memory.id, text: memory.text })]);
  });

  it('rejects the raw embedding search when the caller demands subject enforcement (fail closed)', async () => {
    const pool = new FakeMemoryPool();
    const embedding = new Float32Array([1, 0, 0, 0]);
    const memory = makeMemory('bypass-required', 'Subject scoped memory');
    pool.memories.set(memory.id, makeMemoryRow(memory, '[1,0,0,0]'));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    // A product-recall caller that reaches the raw store must fail closed rather
    // than return unscoped rows: the raw store cannot enforce subject authorization.
    await expect(store.searchByEmbedding(embedding, 0.5, 10, undefined, {
      authorization: 'subject-enforced',
    })).rejects.toThrow('cannot enforce subject authorization');
    expect(pool.embeddingSearchLimits).toEqual([]);
  });

  it('rejects the raw embedding search when no explicit authorization stance is given', async () => {
    const pool = new FakeMemoryPool();
    const embedding = new Float32Array([1, 0, 0, 0]);
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    // The authorization stance is a required parameter, so omitting it is a
    // compile error for typed callers. A caller that casts past the type still
    // fails closed at runtime: the raw path throws and never queries Postgres.
    await expect(
      (store.searchByEmbedding as unknown as (
        embedding: Float32Array,
        threshold: number,
        limit: number,
      ) => Promise<unknown>)(embedding, 0.5, 10),
    ).rejects.toThrow();
    expect(pool.embeddingSearchLimits).toEqual([]);
  });

  it('bounds the raw embedding search LIMIT sent to Postgres regardless of the requested limit', async () => {
    const pool = new FakeMemoryPool();
    const embedding = new Float32Array([1, 0, 0, 0]);
    const memory = makeMemory('bounded-search', 'Bounded search memory');
    pool.memories.set(memory.id, makeMemoryRow(memory, '[1,0,0,0]'));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    // An enormous requested limit must not translate into an unbounded LIMIT.
    await store.searchByEmbedding(embedding, 0.5, Number.MAX_SAFE_INTEGER, undefined, {
      authorization: 'bypass-system-internal',
    });
    const [hugeLimit] = pool.embeddingSearchLimits;
    expect(hugeLimit).toBeLessThanOrEqual(ANN_MAX_CANDIDATES);
    expect(hugeLimit).toBe(ANN_MAX_CANDIDATES);

    // A modest limit still oversamples for post-filter recall but stays capped.
    await store.searchByEmbedding(embedding, 0.5, 10, undefined, {
      authorization: 'bypass-system-internal',
    });
    const modestLimit = pool.embeddingSearchLimits[1];
    expect(modestLimit).toBeGreaterThanOrEqual(10);
    expect(modestLimit).toBeLessThanOrEqual(ANN_MAX_CANDIDATES);
  });

  it('rejects a non-finite or non-positive raw embedding search limit', async () => {
    const pool = new FakeMemoryPool();
    const embedding = new Float32Array([1, 0, 0, 0]);
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    for (const badLimit of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.searchByEmbedding(embedding, 0.5, badLimit, undefined, {
        authorization: 'bypass-system-internal',
      })).rejects.toThrow('positive finite limit');
    }
    expect(pool.embeddingSearchLimits).toEqual([]);
  });

  it('pushes raw embedding scope filters into SQL before the candidate limit', async () => {
    const pool = new FakeMemoryPool();
    const inScope = makeMemory('scope-hit', 'Scoped hit', {
      scopeRef: { kind: 'project', id: 'alpha' },
    });
    const outOfScope = makeMemory('scope-miss', 'Closer but outside scope', {
      scopeRef: { kind: 'project', id: 'beta' },
    });
    pool.memories.set(inScope.id, makeMemoryRow(inScope, '[0.8,0.2,0,0]'));
    pool.memories.set(outOfScope.id, makeMemoryRow(outOfScope, '[1,0,0,0]'));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    const results = await store.searchByEmbedding(
      new Float32Array([1, 0, 0, 0]),
      -1,
      1,
      { refs: [{ kind: 'project', id: 'alpha' }], mode: 'only' },
      { authorization: 'bypass-system-internal' },
    );

    expect(results.map(memory => memory.id)).toEqual(['scope-hit']);
    const searchSql = pool.clients.flatMap(client => client.statements)
      .find(sql => sql.includes('1 - (embedding <=> $1::vector) as similarity'));
    expect(searchSql).toMatch(/scope_ref_kind = \$3.*scope_ref_id = \$4.*order by.*limit \$5/);
  });

  it('paginates lexical augmentation across deterministic Postgres extracted-at ordering', async () => {
    const pool = new FakeMemoryPool();
    const baseExtractedAt = 1_800_000_000_000;
    for (let index = 129; index >= 0; index -= 1) {
      const memory = makeMemory(`lexical-order-${index}`, index === 110
        ? 'Greenhouse irrigation schedule needs careful recalibrating'
        : `Unrelated archived record number ${index}`, {
        extractedAt: baseExtractedAt - index,
        lastAccessed: baseExtractedAt - index,
      });
      pool.memories.set(memory.id, makeMemoryRow(memory));
    }
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const listSpy = vi.spyOn(store, 'listActiveMemories');
    const policy = createDefaultMemoryRetrievalPolicy();
    policy.lexicalAugment = {
      pageSize: 50,
      maxScan: 120,
      selectedLimit: 12,
      minOverlap: 2,
      baseSimilarity: 0.62,
    };

    const candidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: store,
      contextText: 'greenhouse irrigation schedule recalibrating',
      existingIds: new Set(),
      scopeQuery: undefined,
      memoryRetrievalPolicy: policy,
    });

    expect(candidates.map(candidate => candidate.id)).toContain('lexical-order-110');
    expect(listSpy.mock.calls.map(([options]) => options)).toEqual([
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 },
      { limit: 20, offset: 100 },
    ]);
  });

  it('filters active memory windows by scope before the bounded result limit', async () => {
    const pool = new FakeMemoryPool();
    const nowMs = 1_800_000_000_000;
    const relevant = makeMemory('daily-relevant', 'Relevant daily memory', {
      extractedAt: nowMs - 100,
      lastAccessed: nowMs - 100,
      contactId: 'contact-a',
      provenance: { channelId: 'discord:primary' },
    });
    pool.memories.set(relevant.id, makeMemoryRow(relevant));
    for (let index = 0; index < 50; index += 1) {
      const foreign = makeMemory(`daily-foreign-${index}`, `Foreign ${index}`, {
        extractedAt: nowMs - index,
        lastAccessed: nowMs - index,
        contactId: 'contact-b',
        provenance: { channelId: 'discord:foreign' },
      });
      pool.memories.set(foreign.id, makeMemoryRow(foreign));
    }
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    const result = await store.listActiveMemoriesInWindow!({
      fromMs: nowMs - 1_000,
      toMs: nowMs,
      limit: 50,
      scope: {
        kind: 'contact',
        contactId: 'contact-a',
        conversationId: 'discord:primary',
      },
    });

    expect(result.memories.map(memory => memory.id)).toEqual(['daily-relevant']);
    expect(result.saturated).toBe(false);

    const secondRelevant = makeMemory('daily-relevant-newer', 'Another relevant daily memory', {
      extractedAt: nowMs - 50,
      lastAccessed: nowMs - 50,
      contactId: 'contact-a',
    });
    pool.memories.set(secondRelevant.id, makeMemoryRow(secondRelevant));
    const saturated = await store.listActiveMemoriesInWindow!({
      fromMs: nowMs - 1_000,
      toMs: nowMs,
      limit: 1,
      scope: {
        kind: 'contact',
        contactId: 'contact-a',
        conversationId: 'discord:primary',
      },
    });
    expect(saturated.memories.map(memory => memory.id)).toEqual(['daily-relevant-newer']);
    expect(saturated.saturated).toBe(true);
  });

  it('does no Postgres or store scan work on idle decay cycles before the next exp-curve threshold', async () => {
    const now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const pool = new FakeMemoryPool();
      postgresMocks.activePool = pool;
      const store = await createPostgresMemoryStore('postgres://unused', 4);
      const decay = new SalienceDecay(store);
      await decay.run();

      await store.insertMemory(makeMemory('pg-idle-decay', 'Idle decay memory', {
        type: 'episodic',
        salience: 1,
        extractedAt: now - 30 * 24 * 60 * 60_000,
        lastAccessed: now - 30 * 24 * 60 * 60_000,
      }), new Float32Array([0.1, 0.2, 0.3, 0.4]));

      await decay.run();
      const firstObserved = await store.getById('pg-idle-decay');
      expect(firstObserved?.salience).toBeCloseTo(0.5, 10);

      const listSpy = vi.spyOn(store, 'listActiveMemories');
      const querySpy = vi.spyOn(pool, 'query');
      nowSpy.mockReturnValue(now + 60_000);
      await decay.run();

      expect(listSpy).not.toHaveBeenCalled();
      expect(querySpy).not.toHaveBeenCalled();
      const idleObserved = await store.getById('pg-idle-decay');
      const expectedIdleSalience = Math.exp(
        (-Math.LN2 * (30 * 24 * 60 * 60_000 + 60_000)) / (30 * 24 * 60 * 60_000),
      );
      expect(idleObserved?.salience).toBeCloseTo(expectedIdleSalience, 2);

      await store.insertMemory(makeMemory('pg-decay-invalidation', 'Mutation invalidates idle decay', {
        type: 'episodic',
        salience: 1,
        extractedAt: now - 30 * 24 * 60 * 60_000,
        lastAccessed: now - 30 * 24 * 60 * 60_000,
      }), new Float32Array([0.4, 0.3, 0.2, 0.1]));
      listSpy.mockClear();
      querySpy.mockClear();
      await decay.run();

      expect(listSpy).toHaveBeenCalled();
      expect(querySpy).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('continues the exponential decay curve without double-decaying after restart', async () => {
    const dayMs = 24 * 60 * 60_000;
    const halflifeMs = 30 * dayMs;
    const now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const pool = new FakeMemoryPool();
      postgresMocks.activePool = pool;
      const store = await createPostgresMemoryStore('postgres://unused', 4);
      const decay = new SalienceDecay(store);
      await decay.run();

      await store.insertMemory(makeMemory('pg-restart-decay', 'Restart decay memory', {
        type: 'episodic',
        salience: 1,
        extractedAt: now - halflifeMs,
        lastAccessed: now - halflifeMs,
      }), new Float32Array([0.1, 0.2, 0.3, 0.4]));
      await decay.run();
      expect((await store.getById('pg-restart-decay'))?.salience).toBeCloseTo(0.5, 10);

      const restartedStore = await createPostgresMemoryStore('postgres://unused', 4);
      const restartedDecay = new SalienceDecay(restartedStore);
      const bulkUpdateSpy = vi.spyOn(restartedStore, 'bulkUpdateSalience');

      await restartedDecay.run();
      expect(bulkUpdateSpy).not.toHaveBeenCalled();
      expect((await restartedStore.getById('pg-restart-decay'))?.salience).toBeCloseTo(0.5, 10);

      nowSpy.mockReturnValue(now + dayMs);
      await restartedDecay.run();

      const expectedAfterOneDay = 0.5 * Math.exp((-Math.LN2 * dayMs) / halflifeMs);
      expect((await restartedStore.getById('pg-restart-decay'))?.salience)
        .toBeCloseTo(expectedAfterOneDay, 10);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps the supported postgres migration on l2_memories.embedding and omits the dead embeddings table', () => {
    const migrationSql = postgresMemoryMigrationSql();
    expect(migrationSql).toContain("current_schema() <> 'public'");
    expect(migrationSql).toContain("CREATE EXTENSION vector WITH SCHEMA %I");
    expect(migrationSql).toContain('expected public or extensions');
    expect(migrationSql).toContain('embedding VECTOR');
    expect(migrationSql).toContain(
      "search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED",
    );
    expect(migrationSql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_l2_memories_search_vector ON l2_memories USING GIN (search_vector)',
    );
    expect(migrationSql).toContain("source_type TEXT NOT NULL DEFAULT 'unknown'");
    expect(migrationSql).toContain("provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(migrationSql).toContain(
      "ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown';",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;",
    );
    expectMemoryMigrationSqlToContain([
      'salience_decay_anchor_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)',
      'ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS salience_decay_anchor_at BIGINT;',
      'UPDATE l2_memories SET salience_decay_anchor_at = last_accessed WHERE salience_decay_anchor_at IS NULL;',
      'ALTER TABLE l2_memories ALTER COLUMN salience_decay_anchor_at SET DEFAULT ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint);',
      'ALTER TABLE l2_memories ALTER COLUMN salience_decay_anchor_at SET NOT NULL;',
    ]);
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

  it('wraps transactional writes in BEGIN/COMMIT on one checked-out client', async () => {
    const pool = new FakeMemoryPool();
    const memory = makeMemory('txn-commit-source', 'Original transactional body');
    pool.memories.set(memory.id, makeMemoryRow(memory));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    pool.clients.splice(0);

    await store.runInTransaction(async () => {
      await store.updateMemory('txn-commit-source', { supersededBy: 'txn-commit-replacement' });
      await store.recordPatchEvent({
        id: 'patch-commit-1',
        memoryId: 'txn-commit-source',
        sourceRef: 'tool:memory_patch',
        sourceType: 'turn',
        patch: { text: 'next' },
        previousValues: { text: 'Original transactional body' },
        nextValues: { text: 'next' },
        createdAt: Date.now(),
      });
    });

    expect(pool.clients).toHaveLength(1);
    const client = pool.clients[0];
    expect(client.statements[0]).toBe('begin');
    expect(client.statements.at(-1)).toBe('commit');
    expect(client.statements.some(statement => statement.startsWith('insert into l2_memories'))).toBe(true);
    expect(client.statements.some(statement => statement.startsWith('insert into l2_memory_patch_events'))).toBe(true);
    expect(client.released).toBe(true);
    expect(pool.memories.get('txn-commit-source')?.superseded_by).toBe('txn-commit-replacement');
    expect(pool.patchEvents).toHaveLength(1);
    expect((await store.getById('txn-commit-source'))?.supersededBy).toBe('txn-commit-replacement');
  });

  it('awaits fire-and-forget transactional writes before COMMIT', async () => {
    const pool = new FakeMemoryPool();
    const memory = makeMemory('txn-untracked-source', 'Fire and forget body');
    pool.memories.set(memory.id, makeMemoryRow(memory));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    pool.clients.splice(0);

    // Legacy handler style (memory writer patch flows): operations are not
    // awaited inside the handler but must still land before COMMIT.
    await store.runInTransaction(() => {
      void store.updateMemory('txn-untracked-source', { supersededBy: 'txn-untracked-replacement' });
      void store.recordPatchEvent({
        id: 'patch-untracked-1',
        memoryId: 'txn-untracked-source',
        sourceRef: 'tool:memory_patch',
        sourceType: 'turn',
        patch: {},
        previousValues: {},
        nextValues: {},
        createdAt: Date.now(),
      });
    });

    const client = pool.clients[0];
    const commitIndex = client.statements.indexOf('commit');
    expect(commitIndex).toBeGreaterThan(0);
    const memoryInsertIndex = client.statements.findIndex(statement => statement.startsWith('insert into l2_memories'));
    const patchInsertIndex = client.statements.findIndex(statement => statement.startsWith('insert into l2_memory_patch_events'));
    expect(memoryInsertIndex).toBeGreaterThan(-1);
    expect(patchInsertIndex).toBeGreaterThan(-1);
    expect(memoryInsertIndex).toBeLessThan(commitIndex);
    expect(patchInsertIndex).toBeLessThan(commitIndex);
    expect(pool.patchEvents).toHaveLength(1);
  });

  it('rolls back the first write and the cache when a later transactional write fails', async () => {
    const pool = new FakeMemoryPool();
    const memory = makeMemory('txn-rollback-source', 'Body that must survive rollback');
    pool.memories.set(memory.id, makeMemoryRow(memory));
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    pool.clients.splice(0);

    pool.failNextQuery('insert into l2_memory_patch_events', 'simulated patch-event failure');

    await expect(store.runInTransaction(async () => {
      await store.updateMemory('txn-rollback-source', { supersededBy: 'txn-rollback-replacement' });
      await store.recordPatchEvent({
        id: 'patch-rollback-1',
        memoryId: 'txn-rollback-source',
        sourceRef: 'tool:memory_patch',
        sourceType: 'turn',
        patch: {},
        previousValues: {},
        nextValues: {},
        createdAt: Date.now(),
      });
    })).rejects.toThrow('simulated patch-event failure');

    const client = pool.clients[0];
    expect(client.statements).toContain('rollback');
    expect(client.statements).not.toContain('commit');
    expect(client.released).toBe(true);
    // The first write is not committed and the in-memory cache is restored.
    expect(pool.memories.get('txn-rollback-source')?.superseded_by).toBeNull();
    expect(pool.patchEvents).toHaveLength(0);
    expect((await store.getById('txn-rollback-source'))?.supersededBy).toBeUndefined();
    // Post-rollback writes work normally again.
    await store.updateMemory('txn-rollback-source', { salience: 0.42 });
    expect((await store.getById('txn-rollback-source'))?.salience).toBe(0.42);
  });

  it('never exposes a rolled-back transaction as a reusable active-memory snapshot', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const embeddings = makeEmbeddingProvider();
    const embedSpy = vi.spyOn(embeddings, 'embed');
    const retriever = new MemoryRetriever(store, embeddings, {
      telemetryEnabled: false,
      contextWindow: 32_000,
    });
    const uncommitted = makeMemory('txn-rolled-back-memory', 'Uncommitted launch phrase blue heron');
    let signalInserted!: () => void;
    const inserted = new Promise<void>(resolve => {
      signalInserted = resolve;
    });
    let releaseTransaction!: () => void;
    const transactionGate = new Promise<void>(resolve => {
      releaseTransaction = resolve;
    });
    const versionBefore = await store.getRetrievalCorpusVersion!();
    const transaction = store.runInTransaction(async () => {
      await store.insertMemory(uncommitted, new Float32Array([1, 0, 0, 0]));
      signalInserted();
      await transactionGate;
      throw new Error('deliberate rollback');
    });
    await inserted;

    const refresh = retriever.refreshActiveMemoryContext({
      contextText: 'launch phrase',
      channelId: 'api:test',
      trustLevel: 'primary',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const embeddedBeforeRollback = embedSpy.mock.calls.length > 0;
    releaseTransaction();
    await expect(transaction).rejects.toThrow('deliberate rollback');
    const first = await refresh;
    const second = await retriever.refreshActiveMemoryContext({
      contextText: 'launch phrase',
      channelId: 'api:test',
      trustLevel: 'primary',
    });
    const versionAfter = await store.getRetrievalCorpusVersion!();

    expect(embeddedBeforeRollback).toBe(false);
    expect(first?.contextBlock ?? '').not.toContain(uncommitted.text);
    expect(second?.contextBlock ?? '').not.toContain(uncommitted.text);
    expect(versionAfter).toBeGreaterThan(versionBefore);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects nested memory-store transactions', async () => {
    postgresMocks.activePool = new FakeMemoryPool();
    const store = await createPostgresMemoryStore('postgres://unused', 4);

    await expect(store.runInTransaction(() => store.runInTransaction(() => undefined)))
      .rejects.toThrow('Nested memory-store transactions are not supported');
  });

  it('hydrates pg BIGINT memory fields as numbers and excludes soft-deleted rows', async () => {
    const pool = new FakeMemoryPool();
    const active = makeMemory('pg-string-active', 'Active memory from pg strings', {
      extractedAt: 1_782_655_869_792,
      lastAccessed: 1_782_655_870_111,
      accessCount: 7,
    });
    const deleted = makeMemory('pg-string-deleted', 'Deleted memory from pg strings', {
      extractedAt: 1_782_655_860_000,
      lastAccessed: 1_782_655_860_100,
      deletedAt: 1_782_655_871_000,
      deletedBy: 'operator:test',
      deleteReason: 'contaminated attribution',
    });
    const activeRow = makeMemoryRow(active);
    const deletedRow = makeMemoryRow(deleted);
    (fromAny(activeRow)).extracted_at = String(active.extractedAt);
    (fromAny(activeRow)).last_accessed = String(active.lastAccessed);
    (fromAny(activeRow)).access_count = String(active.accessCount);
    (fromAny(deletedRow)).extracted_at = String(deleted.extractedAt);
    (fromAny(deletedRow)).last_accessed = String(deleted.lastAccessed);
    (fromAny(deletedRow)).access_count = String(deleted.accessCount);
    (fromAny(deletedRow)).deleted_at = String(deleted.deletedAt);
    pool.memories.set(active.id, activeRow);
    pool.memories.set(deleted.id, deletedRow);
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const activeMemories = await store.getAllActiveMemories();
    const hydratedActive = await store.getById(active.id);
    const hydratedDeleted = await store.getById(deleted.id);

    expect(activeMemories.map(memory => memory.id)).toEqual([active.id]);
    expect(hydratedActive?.extractedAt).toBe(active.extractedAt);
    expect(hydratedActive?.lastAccessed).toBe(active.lastAccessed);
    expect(hydratedActive?.accessCount).toBe(active.accessCount);
    expect(typeof hydratedActive?.extractedAt).toBe('number');
    expect(hydratedDeleted?.deletedAt).toBe(deleted.deletedAt);
    expect(typeof hydratedDeleted?.deletedAt).toBe('number');
    expect(await store.countActiveMemories()).toBe(1);
  });

  it('persists memory provenance and source type and re-hydrates them across restarts', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;
    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const provenance = {
      channelId: 'room-channel-1',
      sessionId: 'room-channel-1:session:20260707T000000Z-test',
      sourceContactId: 'contact-source',
      subjectContactId: 'contact-subject',
      sourceSpeakerName: 'RoomMember',
      addressMode: 'overheard_room_context' as const,
      routingReason: 'speaker_name_prefix',
    };
    const memory = makeMemory('pg-provenance', 'Room member fact', {
      sourceRef: 'room-channel-1:extract',
      sourceType: 'turn',
      provenance,
    });
    await store.insertMemory(memory, new Float32Array([0.1, 0.2, 0.3, 0.4]));

    // The durable row must carry both fields (regression: the INSERT used to
    // omit provenance_json/source_type, leaving the schema defaults forever).
    const storedRow = pool.memories.get('pg-provenance');
    expect(storedRow?.source_type).toBe('turn');
    expect(storedRow?.provenance_json).toEqual(provenance);

    // Simulate an agent restart: a fresh store hydrating from the same pool.
    const rehydrated = await createPostgresMemoryStore('postgres://unused', 4);
    const hydrated = await rehydrated.getById('pg-provenance');
    expect(hydrated?.sourceType).toBe('turn');
    expect(hydrated?.provenance).toEqual(provenance);

    // Legacy rows (written before provenance persistence) hydrate without
    // provenance and with an inferred source type instead of failing.
    const legacyRow = makeMemoryRow(makeMemory('pg-legacy', 'Legacy memory'));
    legacyRow.source_type = null;
    legacyRow.provenance_json = {};
    pool.memories.set('pg-legacy', legacyRow);
    const legacyStore = await createPostgresMemoryStore('postgres://unused', 4);
    const legacy = await legacyStore.getById('pg-legacy');
    expect(legacy?.provenance).toBeUndefined();
    expect(legacy?.sourceType).toBe('unknown');
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

  it('coerces string BIGINT scratchpad timestamps during hydration', async () => {
    const pool = new FakeMemoryPool();
    const now = Date.now();
    pool.scratchpadEntries.set('string-time-note', {
      id: 'string-time-note',
      content: 'Hydrated from pg bigint strings.',
      created_at: String(now - 2_000),
      updated_at: String(now - 1_000),
    });
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    const entries = store.listScratchpadEntries();

    expect(entries).toEqual([
      {
        id: 'string-time-note',
        content: 'Hydrated from pg bigint strings.',
        createdAt: now - 2_000,
        updatedAt: now - 1_000,
      },
    ]);
    expect(typeof entries[0]?.createdAt).toBe('number');
    expect(typeof entries[0]?.updatedAt).toBe('number');
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
    expect(await store.getById(memory.id)).toEqual({
      ...memory,
      salienceDecayAnchorAt: memory.lastAccessed,
    });
    expect(await store.getDeleteVersion('delete-version')).toBeUndefined();
    expect(await store.countActiveMemories()).toBe(1);
  });

  it('bulk-updates distinct Postgres salience values and skips deleted memories', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    await store.insertMemory(makeMemory('pg-salience-1', 'First salience memory'), new Float32Array([0.1, 0.2, 0.3, 0.4]));
    await store.insertMemory(makeMemory('pg-salience-2', 'Second salience memory'), new Float32Array([0.2, 0.3, 0.4, 0.5]));
    await store.insertMemory(makeMemory('pg-salience-deleted', 'Deleted salience memory', {
      deletedAt: 1_700_000_000_100,
      deletedBy: 'tester',
    }), new Float32Array([0.3, 0.4, 0.5, 0.6]));

    const count = await store.bulkUpdateSalience([
      { id: 'pg-salience-1', salience: 0.22, salienceDecayAnchorAt: 1_700_000_000_100 },
      { id: 'pg-salience-2', salience: 0.44, salienceDecayAnchorAt: 1_700_000_000_200 },
      { id: 'pg-salience-deleted', salience: 0.66, salienceDecayAnchorAt: 1_700_000_000_300 },
    ]);

    expect(count).toBe(2);
    await expect(store.getById('pg-salience-1')).resolves.toMatchObject({
      salience: 0.22,
      salienceDecayAnchorAt: 1_700_000_000_100,
    });
    await expect(store.getById('pg-salience-2')).resolves.toMatchObject({
      salience: 0.44,
      salienceDecayAnchorAt: 1_700_000_000_200,
    });
    await expect(store.getById('pg-salience-deleted')).resolves.toMatchObject({ salience: 0.8 });
    expect(pool.memories.get('pg-salience-1')?.salience).toBe(0.22);
    expect(pool.memories.get('pg-salience-1')?.salience_decay_anchor_at).toBe(1_700_000_000_100);
    expect(pool.memories.get('pg-salience-2')?.salience).toBe(0.44);
    expect(pool.memories.get('pg-salience-2')?.salience_decay_anchor_at).toBe(1_700_000_000_200);
    expect(pool.memories.get('pg-salience-deleted')?.salience).toBe(0.8);
  });

  it('bulk-updates Postgres retention class tags and skips deleted or missing memories', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    await store.insertMemory(makeMemory('pg-retention-pref', 'V prefers oolong tea', {
      tags: ['preference:tea'],
    }), new Float32Array([0.1, 0.2, 0.3, 0.4]));
    await store.insertMemory(makeMemory('pg-retention-standard', 'Standard memory', {
      tags: [DURABLE_RETENTION_TAG, DURABLE_PREFERENCE_MEMORY_TAG, 'preference'],
      retentionClass: 'durable',
    }), new Float32Array([0.2, 0.3, 0.4, 0.5]));
    await store.insertMemory(makeMemory('pg-retention-deleted', 'Deleted retention memory', {
      tags: ['preference:music'],
      deletedAt: 1_700_000_000_100,
      deletedBy: 'tester',
    }), new Float32Array([0.3, 0.4, 0.5, 0.6]));

    const durableCount = await store.bulkUpdate(
      ['pg-retention-pref', 'missing', 'pg-retention-deleted'],
      { retentionClass: 'durable', sensitivity: 'confidential' },
    );
    expect(durableCount).toBe(1);
    await expect(store.getById('pg-retention-pref')).resolves.toMatchObject({
      retentionClass: 'durable',
      sensitivity: 'confidential',
      tags: ['preference:tea', DURABLE_RETENTION_TAG, DURABLE_PREFERENCE_MEMORY_TAG],
    });
    expect(pool.memories.get('pg-retention-pref')).toMatchObject({
      retention_class: 'durable',
      sensitivity: 'confidential',
      tags: ['preference:tea', DURABLE_RETENTION_TAG, DURABLE_PREFERENCE_MEMORY_TAG],
    });
    await expect(store.getById('pg-retention-deleted')).resolves.toMatchObject({
      tags: ['preference:music'],
      sensitivity: 'personal',
    });

    const standardCount = await store.bulkUpdate(
      ['pg-retention-pref', 'pg-retention-standard'],
      { retentionClass: 'standard' },
    );
    expect(standardCount).toBe(2);
    await expect(store.getById('pg-retention-pref')).resolves.toMatchObject({
      retentionClass: 'standard',
      tags: ['preference:tea'],
    });
    await expect(store.getById('pg-retention-standard')).resolves.toMatchObject({
      retentionClass: 'standard',
      tags: ['preference'],
    });
  });

  it('keeps Postgres salience cache unchanged when the batch write fails', async () => {
    const pool = new FakeMemoryPool();
    postgresMocks.activePool = pool;

    const store = await createPostgresMemoryStore('postgres://unused', 4);
    await store.insertMemory(makeMemory('pg-salience-failure', 'Failure salience memory'), new Float32Array([0.1, 0.2, 0.3, 0.4]));
    pool.failNextQuery('update l2_memories as memory', 'simulated salience update failure');

    await expect(store.bulkUpdateSalience([
      { id: 'pg-salience-failure', salience: 0.11, salienceDecayAnchorAt: 1_700_000_000_100 },
    ])).rejects.toThrow('simulated salience update failure');
    await expect(store.getById('pg-salience-failure')).resolves.toMatchObject({ salience: 0.8 });
    expect(pool.memories.get('pg-salience-failure')?.salience).toBe(0.8);
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

  it('does not select or hydrate L2 embeddings at startup (a27w.1 bounded boot)', async () => {
    const pool = new FakeMemoryPool();
    // Seed many rows that each carry an embedding. Startup cost must not scale
    // with them: the hydration SELECT must not request the embedding column,
    // so no Float32Array is ever decoded or retained at boot.
    for (let index = 0; index < 50; index += 1) {
      const memory = makeMemory(`boot-embed-${index}`, `boot memory ${index}`);
      pool.memories.set(memory.id, makeMemoryRow(memory, '[0.1,0.2,0.3,0.4]'));
    }
    postgresMocks.activePool = pool;
    postgresMocks.queryRows.mockClear();

    const store = await createPostgresMemoryStore('postgres://unused', 4);

    const hydrationSelects = postgresMocks.queryRows.mock.calls
      .map(call => String(call[1]))
      .filter(sql => /FROM\s+l2_memories/i.test(sql) && /ORDER BY extracted_at DESC, id DESC/i.test(sql));
    expect(hydrationSelects.length).toBeGreaterThan(0);
    for (const sql of hydrationSelects) {
      expect(sql).not.toMatch(/embedding/i);
    }
    // Metadata still hydrates so getById / lexical search / counts are intact.
    expect(await store.getById('boot-embed-0')).toBeDefined();
    expect(await store.countActiveMemories()).toBe(50);
  });

  it('fails closed at startup when the embedding schema probe is unreachable (a27w.1)', async () => {
    const pool = new FakeMemoryPool();
    // Simulate the embedding table/column reachability probe erroring (e.g. the
    // database becoming unreachable). Startup must reject, never boot silently
    // with an empty in-memory index.
    pool.failNextQuery('information_schema.columns', 'connection terminated unexpectedly');
    postgresMocks.activePool = pool;

    await expect(createPostgresMemoryStore('postgres://unused', 4)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });
});
