import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryRows,
} from '../../persistence/postgres.js';
import {
  POSTGRES_MEMORY_MIGRATIONS,
} from '../../persistence/postgres/migrations.js';
import type { MemoryJournal } from './journal.js';
import type {
  ContactProfileArtifact,
  MemoryAbstractionLink,
  MemoryAbstractionLinkInput,
  MemoryBulkUpdatePatch,
  MemoryDeleteVersion,
  MemoryListOptions,
  MemoryLink,
  MemorySoftDeleteOptions,
  MemoryStorePort,
  MemoryStoreStats,
  MemoryStoreUpdatePatch,
  MemoryUndoSoftDeleteOptions,
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
  MemoryWriteCommit,
} from './memory-store-port.js';
import {
  normalizeConsentFlags,
  normalizeFormationVAD,
  normalizeMemoryScopeQuery,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  type MemoryScopeQuery,
  type PurrMemory,
} from './types.js';

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

interface MemorySchemaTableRow {
  table_name: string;
}

interface MemorySchemaColumnRow {
  column_name: string;
  data_type: string;
}

interface MemoryDeleteVersionRow {
  delete_id: string;
  memory_id: string;
  snapshot_json: unknown;
  deleted_at: number;
  deleted_by: string | null;
  delete_reason: string | null;
  restored_at: number | null;
  restored_by: string | null;
}

interface MemoryAbstractionLinkRow {
  id: string;
  source_memory_id: string;
  abstracted_memory_id: string;
  external_ref: string;
  created_at: number;
  created_by: string | null;
  reason: string | null;
}

interface MemoryLinkRow {
  id1: string;
  id2: string;
  link_type: string;
  created_at: number;
}

interface ContactProfileRow {
  contact_id: string;
  summary_text: string;
  source_memory_ids: unknown;
  confidence_score: number;
  novelty_score: number;
  updated_at: number;
}

interface ScratchpadRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface PostgresMemoryStoreOptions {
  notesDir?: string;
  scratchpadMirrorPath?: string;
  journal?: MemoryJournal;
}

function decodeJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
}

function decodeJsonObject(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

function decodeStringArray(value: unknown): string[] {
  return decodeJsonArray(value).map(item => item.trim()).filter(Boolean);
}

function decodeFormationVAD(value: unknown): PurrMemory['formationVAD'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<NonNullable<PurrMemory['formationVAD']>>;
  if (
    typeof candidate.valence !== 'number'
    || typeof candidate.arousal !== 'number'
    || typeof candidate.dominance !== 'number'
  ) {
    return undefined;
  }
  return normalizeFormationVAD({
    valence: candidate.valence,
    arousal: candidate.arousal,
    dominance: candidate.dominance,
  });
}

function encodeEmbedding(embedding: Float32Array): number[] {
  return Array.from(embedding, value => Number(value));
}

function decodeEmbedding(value: unknown): Float32Array | undefined {
  if (!Array.isArray(value)) return undefined;
  return new Float32Array(value.flatMap((entry) => (typeof entry === 'number' ? [entry] : [])));
}

function memoryKey(id1: string, id2: string): string {
  return [id1, id2].sort().join('::');
}

function clampLimit(limit: number | undefined, fallback: number, min: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

function toMemoryRow(memory: PurrMemory, embedding?: Float32Array): MemoryRow {
  return {
    id: memory.id,
    text: memory.text,
    type: memory.type,
    importance: memory.importance,
    confidence: memory.confidence,
    emotional_valence: memory.emotionalValence,
    formation_vad: memory.formationVAD ?? null,
    salience: memory.salience,
    source_ref: memory.sourceRef,
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
    embedding: embedding ? encodeEmbedding(embedding) : null,
  };
}

function fromMemoryRow(row: MemoryRow): PurrMemory {
  const scopeRef = row.scope_ref_kind && row.scope_ref_id
    ? normalizeMemoryScopeRef({
      kind: row.scope_ref_kind as any,
      id: row.scope_ref_id,
      ...(row.scope_ref_label ? { label: row.scope_ref_label } : {}),
    })
    : undefined;
  return {
    id: row.id,
    text: row.text,
    type: row.type,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence,
    formationVAD: decodeFormationVAD(row.formation_vad),
    salience: row.salience,
    sourceRef: row.source_ref,
    extractedAt: row.extracted_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    tags: decodeStringArray(row.tags),
    ...(scopeRef ? { scopeRef } : {}),
    ...(Array.isArray(row.scope_tags) ? { scopeTags: decodeStringArray(row.scope_tags) } : {}),
    ...(Array.isArray(row.provenance_refs) ? { provenanceRefs: decodeStringArray(row.provenance_refs) } : {}),
    ...(row.retention_class ? { retentionClass: row.retention_class } : {}),
    sensitivity: row.sensitivity,
    consentFlags: normalizeConsentFlags(decodeJsonObject(row.consent_flags)),
    ...(row.contact_id ? { contactId: row.contact_id } : {}),
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
    ...(row.deleted_by ? { deletedBy: row.deleted_by } : {}),
    ...(row.delete_reason ? { deleteReason: row.delete_reason } : {}),
  };
}

function lexicalScore(memory: PurrMemory, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(token => token.trim())
    .filter(token => token.length > 0);
  if (tokens.length === 0) return 0;
  const haystack = `${memory.text} ${memory.tags.join(' ')} ${memory.sourceRef}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score / tokens.length;
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
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

export async function createPostgresMemoryStore(
  databaseUrl: string,
  embeddingDims: number,
  options: PostgresMemoryStoreOptions = {},
): Promise<MemoryStorePort> {
  const pool = createPostgresPool(databaseUrl, { applicationName: 'psfn-memory', allowExitOnIdle: true });
  await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
  await validatePostgresMemorySchema(pool);
  return new PostgresMemoryStore(pool, embeddingDims, options);
}

async function validatePostgresMemorySchema(pool: Pool): Promise<void> {
  const legacyEmbeddingTables = await queryRows<MemorySchemaTableRow>(pool, `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memory_embeddings'
  `);
  if (legacyEmbeddingTables.length > 0) {
    throw new Error(
      'Unsupported PostgreSQL memory schema detected: l2_memory_embeddings is no longer used; recreate the memory schema so embeddings live on l2_memories.embedding',
    );
  }

  const memoryColumns = await queryRows<MemorySchemaColumnRow>(pool, `
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memories'
  `);
  const embeddingColumn = memoryColumns.find(column => column.column_name === 'embedding');
  if (!embeddingColumn) {
    throw new Error(
      'PostgreSQL memory schema is missing l2_memories.embedding; recreate the memory schema before starting the memory store',
    );
  }
  if (embeddingColumn.data_type !== 'ARRAY') {
    throw new Error(
      `PostgreSQL memory schema column l2_memories.embedding must be an array type, got ${embeddingColumn.data_type}`,
    );
  }
}

class PostgresMemoryStore implements MemoryStorePort {
  private readonly pool: Pool;
  private readonly embeddingDims: number;
  private readonly journal: MemoryJournal | null;
  private readonly scratchpadMirrorPath: string | null;
  private persistChain: Promise<void> = Promise.resolve();

  private memories = new Map<string, PurrMemory>();
  private embeddings = new Map<string, Float32Array>();
  private deleteVersions = new Map<string, MemoryDeleteVersion>();
  private abstractionLinks = new Map<string, MemoryAbstractionLink>();
  private memoryLinks = new Map<string, MemoryLink>();
  private contactProfiles = new Map<string, ContactProfileArtifact>();
  private scratchpadEntries = new Map<string, ScratchpadEntry>();

  constructor(pool: Pool, embeddingDims: number, options: PostgresMemoryStoreOptions = {}) {
    this.pool = pool;
    this.embeddingDims = embeddingDims;
    this.journal = options.journal ?? null;
    this.scratchpadMirrorPath = options.scratchpadMirrorPath?.trim() ? options.scratchpadMirrorPath.trim() : null;
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const memoryRows = await queryRows<MemoryRow>(this.pool, `
      SELECT
        id, text, type, importance, confidence, emotional_valence, formation_vad,
        salience, source_ref, extracted_at, last_accessed, access_count, superseded_by,
        tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding
      FROM l2_memories
      ORDER BY extracted_at DESC, id DESC
    `);
    for (const row of memoryRows) {
      this.memories.set(row.id, fromMemoryRow(row));
      if (row.embedding) {
        const embedding = decodeEmbedding(row.embedding);
        if (embedding) {
          this.embeddings.set(row.id, embedding);
        }
      }
    }

    const deleteRows = await queryRows<MemoryDeleteVersionRow>(this.pool, `
      SELECT delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
      FROM l2_memory_delete_versions
    `);
    for (const row of deleteRows) {
      this.deleteVersions.set(row.delete_id, {
        deleteId: row.delete_id,
        memoryId: row.memory_id,
        snapshot: typeof row.snapshot_json === 'object' && row.snapshot_json !== null
          ? (row.snapshot_json as PurrMemory)
          : JSON.parse(String(row.snapshot_json)) as PurrMemory,
        deletedAt: row.deleted_at,
        deletedBy: row.deleted_by ?? 'unknown',
        deleteReason: row.delete_reason ?? undefined,
        restoredAt: row.restored_at ?? undefined,
        restoredBy: row.restored_by ?? undefined,
      });
    }

    const linkRows = await queryRows<MemoryAbstractionLinkRow>(this.pool, `
      SELECT id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
      FROM l2_memory_abstraction_links
    `);
    for (const row of linkRows) {
      const link = {
        id: row.id,
        sourceMemoryId: row.source_memory_id,
        abstractedMemoryId: row.abstracted_memory_id,
        externalRef: row.external_ref,
        createdAt: row.created_at,
        ...(row.created_by ? { createdBy: row.created_by } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      };
      this.abstractionLinks.set(link.id, link);
    }

    const memoryLinkRows = await queryRows<MemoryLinkRow>(this.pool, `
      SELECT id1, id2, link_type, created_at FROM memory_links
    `);
    for (const row of memoryLinkRows) {
      this.memoryLinks.set(memoryKey(row.id1, row.id2), {
        id1: row.id1,
        id2: row.id2,
        linkType: row.link_type,
        createdAt: row.created_at,
      });
    }

    const contactProfiles = await queryRows<ContactProfileRow>(this.pool, `
      SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      FROM contact_profiles
    `);
    for (const row of contactProfiles) {
      this.contactProfiles.set(row.contact_id, {
        contactId: row.contact_id,
        summary: row.summary_text,
        sourceMemoryIds: decodeStringArray(row.source_memory_ids),
        confidenceScore: row.confidence_score,
        noveltyScore: row.novelty_score,
        updatedAt: row.updated_at,
      });
    }

    const scratchpadEntries = await queryRows<ScratchpadRow>(this.pool, `
      SELECT id, content, created_at, updated_at
      FROM scratchpad_entries
      ORDER BY updated_at DESC, created_at DESC
    `);
    for (const row of scratchpadEntries) {
      this.scratchpadEntries.set(row.id, {
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }

  private enqueuePersist(task: () => Promise<void>): void {
    this.persistChain = this.persistChain.then(task);
  }

  private async upsertMemoryRow(memory: PurrMemory, embedding?: Float32Array): Promise<void> {
    const row = toMemoryRow(memory, embedding);
    await executeQuery(this.pool, `
      INSERT INTO l2_memories (
        id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
        source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,
        scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
        retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
        delete_reason, embedding
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
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
    `, [
      row.id,
      row.text,
      row.type,
      row.importance,
      row.confidence,
      row.emotional_valence,
      row.formation_vad,
      row.salience,
      row.source_ref,
      row.extracted_at,
      row.last_accessed,
      row.access_count,
      row.superseded_by,
      row.tags,
      row.scope_ref_kind,
      row.scope_ref_id,
      row.scope_ref_label,
      row.scope_tags,
      row.provenance_refs,
      row.retention_class,
      row.sensitivity,
      row.consent_flags,
      row.contact_id,
      row.deleted_at,
      row.deleted_by,
      row.delete_reason,
      row.embedding,
    ]);
  }

  private async upsertDeleteVersion(deleteVersion: MemoryDeleteVersion): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO l2_memory_delete_versions (
        delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (delete_id) DO UPDATE SET
        snapshot_json = EXCLUDED.snapshot_json,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by,
        delete_reason = EXCLUDED.delete_reason,
        restored_at = EXCLUDED.restored_at,
        restored_by = EXCLUDED.restored_by
    `, [
      deleteVersion.deleteId,
      deleteVersion.memoryId,
      deleteVersion.snapshot,
      deleteVersion.deletedAt,
      deleteVersion.deletedBy,
      deleteVersion.deleteReason ?? null,
      deleteVersion.restoredAt ?? null,
      deleteVersion.restoredBy ?? null,
    ]);
  }

  private async upsertScratchpadEntry(entry: ScratchpadEntry): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `, [entry.id, entry.content, entry.createdAt, entry.updatedAt]);
    this.syncScratchpadMirror();
  }

  private async persistContactProfile(profile: ContactProfileArtifact): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO contact_profiles (
        contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (contact_id) DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        source_memory_ids = EXCLUDED.source_memory_ids,
        confidence_score = EXCLUDED.confidence_score,
        novelty_score = EXCLUDED.novelty_score,
        updated_at = EXCLUDED.updated_at
    `, [
      profile.contactId,
      profile.summary,
      profile.sourceMemoryIds,
      profile.confidenceScore,
      profile.noveltyScore,
      profile.updatedAt,
    ]);
  }

  private syncScratchpadMirror(): void {
    if (!this.scratchpadMirrorPath) return;
    const payload = {
      entries: this.listScratchpadEntries(),
    };
    writeJsonAtomic(this.scratchpadMirrorPath, payload);
  }

  async insertMemory(memory: PurrMemory, embedding: Float32Array): Promise<void> {
    this.memories.set(memory.id, memory);
    this.embeddings.set(memory.id, embedding);
    this.enqueuePersist(() => this.upsertMemoryRow(memory, embedding));
    this.journal?.onInsert(memory);
  }

  async persistMemoryWrite(input: MemoryWriteCommit): Promise<void> {
    for (const id of new Set(input.supersededMemoryIds ?? [])) {
      await this.updateMemory(id, { supersededBy: input.memory.id });
    }
    await this.insertMemory(input.memory, input.embedding);
  }

  async searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const selected = Array.from(this.memories.values()).filter((memory) => {
      if (memory.supersededBy || memory.deletedAt) return false;
      if (
        normalizedScopeQuery
        && (
          normalizedScopeQuery.mode === 'only'
          || normalizedScopeQuery.refs?.length
          || normalizedScopeQuery.tags?.length
        )
      ) {
        const refs = normalizedScopeQuery.refs ?? [];
        const tags = normalizedScopeQuery.tags ?? [];
        const scopeMatch = refs.length === 0 || refs.some(ref => {
          const scope = memory.scopeRef;
          return scope?.kind === ref.kind && scope.id === ref.id;
        });
        const tagMatch = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
        if (normalizedScopeQuery.mode === 'only') {
          return scopeMatch && tagMatch;
        }
        return scopeMatch || tagMatch;
      }
      return true;
    });

    return selected
      .map(memory => {
        const memoryEmbedding = this.embeddings.get(memory.id);
        if (!memoryEmbedding) return null;
        const similarity = cosineSimilarity(embedding, memoryEmbedding);
        if (similarity < threshold) return null;
        return { ...memory, similarity };
      })
      .filter((value): value is PurrMemory & { similarity: number } => value !== null)
      .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    return Array.from(this.memories.values())
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
  }

  async updateMemory(id: string, updates: MemoryStoreUpdatePatch): Promise<void> {
    const existing = this.memories.get(id);
    if (!existing) return;
    const next = { ...existing };
    if (updates.salience !== undefined) next.salience = updates.salience;
    if (updates.lastAccessed !== undefined) next.lastAccessed = updates.lastAccessed;
    if (updates.accessCount !== undefined) next.accessCount = updates.accessCount;
    if (updates.supersededBy !== undefined) next.supersededBy = updates.supersededBy;
    if (updates.sensitivity !== undefined) next.sensitivity = updates.sensitivity;
    if (updates.consentFlags !== undefined) next.consentFlags = updates.consentFlags;
    if (updates.tags !== undefined) next.tags = [...updates.tags];
    if (updates.scopeRef !== undefined) next.scopeRef = normalizeMemoryScopeRef(updates.scopeRef);
    if (updates.scopeTags !== undefined) next.scopeTags = normalizeMemoryScopeTags(updates.scopeTags);
    if (updates.provenanceRefs !== undefined) next.provenanceRefs = [...updates.provenanceRefs];
    if (updates.contactId !== undefined) next.contactId = updates.contactId;
    if (updates.deletedAt !== undefined) next.deletedAt = updates.deletedAt;
    if (updates.deletedBy !== undefined) next.deletedBy = updates.deletedBy;
    if (updates.deleteReason !== undefined) next.deleteReason = updates.deleteReason;
    this.memories.set(id, next);
    const embedding = this.embeddings.get(id);
    this.enqueuePersist(() => this.upsertMemoryRow(next, embedding));
  }

  async getAllActiveMemories(limit: number = 10_000): Promise<PurrMemory[]> {
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .sort((left, right) => right.extractedAt - left.extractedAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async listActiveMemories(options: MemoryListOptions = {}): Promise<PurrMemory[]> {
    const limit = clampLimit(options.limit, 50, 1, 500);
    const offset = clampLimit(options.offset, 0, 0, 100_000);
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .sort((left, right) => right.extractedAt - left.extractedAt || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async countActiveMemories(): Promise<number> {
    return Array.from(this.memories.values()).filter(memory => !memory.supersededBy && !memory.deletedAt).length;
  }

  async getById(id: string): Promise<PurrMemory | undefined> {
    return this.memories.get(id);
  }

  async softDeleteMemory(id: string, options: MemorySoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    const memory = this.memories.get(id);
    if (!memory || memory.deletedAt) return null;
    const deleteId = options.deleteId ?? randomUUID();
    const deletedAt = options.deletedAt ?? Date.now();
    const deletedBy = options.deletedBy?.trim() || 'agent';
    const deleteReason = options.reason?.trim();
    const version: MemoryDeleteVersion = {
      deleteId,
      memoryId: id,
      snapshot: memory,
      deletedAt,
      deletedBy,
      ...(deleteReason ? { deleteReason } : {}),
    };
    this.memories.set(id, { ...memory, deletedAt, deletedBy, deleteReason });
    this.deleteVersions.set(deleteId, version);
    this.enqueuePersist(async () => {
      await this.upsertDeleteVersion(version);
      await this.upsertMemoryRow(this.memories.get(id)!, this.embeddings.get(id));
    });
    this.journal?.onSoftDelete(version);
    return version;
  }

  async undoSoftDelete(deleteId: string, options: MemoryUndoSoftDeleteOptions = {}): Promise<MemoryDeleteVersion | null> {
    const version = this.deleteVersions.get(deleteId);
    if (!version) return null;
    const current = this.memories.get(version.memoryId);
    if (!current) return null;
    const restoredAt = options.restoredAt ?? Date.now();
    const restoredBy = options.restoredBy?.trim() || 'agent';
    const restored = { ...current, deletedAt: undefined, deletedBy: undefined, deleteReason: undefined };
    this.memories.set(version.memoryId, restored);
    const nextVersion = { ...version, restoredAt, restoredBy };
    this.deleteVersions.set(deleteId, nextVersion);
    this.enqueuePersist(async () => {
      await this.upsertDeleteVersion(nextVersion);
      await this.upsertMemoryRow(restored, this.embeddings.get(version.memoryId));
    });
    this.journal?.onRestore(nextVersion);
    return nextVersion;
  }

  async getDeleteVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined> {
    return this.deleteVersions.get(deleteId);
  }

  async recordAbstractionLink(input: MemoryAbstractionLinkInput): Promise<MemoryAbstractionLink> {
    const id = input.linkId?.trim() || randomUUID();
    const link: MemoryAbstractionLink = {
      id,
      sourceMemoryId: input.sourceMemoryId.trim(),
      abstractedMemoryId: input.abstractedMemoryId.trim(),
      externalRef: input.externalRef.trim(),
      createdAt: input.createdAt ?? Date.now(),
      ...(input.createdBy ? { createdBy: input.createdBy.trim() } : {}),
      ...(input.reason ? { reason: input.reason.trim() } : {}),
    };
    this.abstractionLinks.set(link.id, link);
    this.enqueuePersist(async () => {
      await executeQuery(this.pool, `
        INSERT INTO l2_memory_abstraction_links (
          id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          source_memory_id = EXCLUDED.source_memory_id,
          abstracted_memory_id = EXCLUDED.abstracted_memory_id,
          external_ref = EXCLUDED.external_ref,
          created_at = EXCLUDED.created_at,
          created_by = EXCLUDED.created_by,
          reason = EXCLUDED.reason
      `, [link.id, link.sourceMemoryId, link.abstractedMemoryId, link.externalRef, link.createdAt, link.createdBy ?? null, link.reason ?? null]);
    });
    return link;
  }

  async getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return Array.from(this.abstractionLinks.values()).filter(link => link.sourceMemoryId === sourceMemoryId);
  }

  async getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return Array.from(this.abstractionLinks.values()).filter(link => link.abstractedMemoryId === abstractedMemoryId);
  }

  async getStats(): Promise<MemoryStoreStats> {
    const active = Array.from(this.memories.values()).filter(memory => !memory.supersededBy && !memory.deletedAt);
    const byType: Record<string, number> = {};
    let salience = 0;
    for (const memory of active) {
      byType[memory.type] = (byType[memory.type] ?? 0) + 1;
      salience += memory.salience;
    }
    return {
      total: active.length,
      byType,
      avgSalience: active.length > 0 ? salience / active.length : 0,
    };
  }

  async getMemoriesByChannel(channelId: string, limit: number): Promise<PurrMemory[]> {
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt && memory.sourceRef.startsWith(`${channelId}:`))
      .sort((left, right) => right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async getMemoriesByContact(contactId: string, limit: number): Promise<PurrMemory[]> {
    return Array.from(this.memories.values())
      .filter(memory => !memory.supersededBy && !memory.deletedAt && memory.contactId === contactId)
      .sort((left, right) => right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }

  async linkMemories(id1: string, id2: string, linkType: string = 'related'): Promise<MemoryLink | null> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2 || normalizedId1 === normalizedId2) return null;
    const [first, second] = normalizedId1 < normalizedId2 ? [normalizedId1, normalizedId2] : [normalizedId2, normalizedId1];
    const key = memoryKey(first, second);
    if (this.memoryLinks.has(key)) return null;
    const link: MemoryLink = { id1: first, id2: second, linkType: linkType.trim() || 'related', createdAt: Date.now() };
    this.memoryLinks.set(key, link);
    this.enqueuePersist(async () => {
      await executeQuery(this.pool, `
        INSERT INTO memory_links (id1, id2, link_type, created_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id1, id2) DO UPDATE SET
          link_type = EXCLUDED.link_type,
          created_at = EXCLUDED.created_at
      `, [link.id1, link.id2, link.linkType, link.createdAt]);
    });
    return link;
  }

  async unlinkMemories(id1: string, id2: string): Promise<boolean> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) return false;
    const [first, second] = normalizedId1 < normalizedId2 ? [normalizedId1, normalizedId2] : [normalizedId2, normalizedId1];
    const key = memoryKey(first, second);
    const removed = this.memoryLinks.delete(key);
    if (removed) {
      this.enqueuePersist(async () => {
        await executeQuery(this.pool, 'DELETE FROM memory_links WHERE id1 = $1 AND id2 = $2', [first, second]);
      });
    }
    return removed;
  }

  async getLinkedMemories(id: string): Promise<MemoryLink[]> {
    const normalizedId = id.trim();
    if (!normalizedId) return [];
    return Array.from(this.memoryLinks.values())
      .filter(link => link.id1 === normalizedId || link.id2 === normalizedId)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async bulkDelete(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const deleted = await this.softDeleteMemory(id, { deletedBy: 'admin:bulk', reason: 'bulk delete' });
      if (deleted) count += 1;
    }
    return count;
  }

  async bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const existing = this.memories.get(id);
      if (!existing || existing.deletedAt) continue;
      const next = { ...existing };
      if (fields.type !== undefined) next.type = fields.type;
      if (fields.sensitivity !== undefined) next.sensitivity = fields.sensitivity;
      this.memories.set(id, next);
      this.enqueuePersist(() => this.upsertMemoryRow(next, this.embeddings.get(id)));
      count += 1;
    }
    return count;
  }

  async upsertContactProfile(profile: ContactProfileArtifact): Promise<void> {
    this.contactProfiles.set(profile.contactId, profile);
    this.enqueuePersist(() => this.persistContactProfile(profile));
  }

  async getContactProfile(contactId: string): Promise<ContactProfileArtifact | undefined> {
    return this.contactProfiles.get(contactId);
  }

  async listContactProfiles(): Promise<ContactProfileArtifact[]> {
    return Array.from(this.contactProfiles.values()).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): Promise<ScratchpadAddResult> {
    const normalized = content.trim();
    if (!normalized) throw new Error('Scratchpad content is required');
    const now = options.now ?? Date.now();
    const id = options.id?.trim() || randomUUID();
    const entry: ScratchpadEntry = { id, content: normalized, createdAt: now, updatedAt: now };
    this.scratchpadEntries.set(id, entry);
    this.enqueuePersist(() => this.upsertScratchpadEntry(entry));
    const evictedIds = this.pruneScratchpadEntries();
    const current = this.scratchpadEntries.get(id);
    if (!current) throw new Error(`Failed to load scratchpad entry after insert: ${id}`);
    return { entry: current, evictedIds };
  }

  async replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const existing = this.scratchpadEntries.get(normalizedId);
    if (!existing) return null;
    const updated = {
      ...existing,
      content: content.trim(),
      updatedAt: options.now ?? Date.now(),
    };
    this.scratchpadEntries.set(normalizedId, updated);
    this.enqueuePersist(() => this.upsertScratchpadEntry(updated));
    return updated;
  }

  async removeScratchpadEntry(id: string): Promise<boolean> {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    const removed = this.scratchpadEntries.delete(normalizedId);
    if (removed) {
      this.enqueuePersist(async () => {
        await executeQuery(this.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [normalizedId]);
        this.syncScratchpadMirror();
      });
    }
    return removed;
  }

  async getScratchpadEntry(id: string): Promise<ScratchpadEntry | undefined> {
    return this.scratchpadEntries.get(id.trim());
  }

  listScratchpadEntries(limit: number = 64): ScratchpadEntry[] {
    return Array.from(this.scratchpadEntries.values())
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, clampLimit(limit, 64, 1, 64));
  }

  private pruneScratchpadEntries(): string[] {
    const maxEntries = 64;
    const ordered = Array.from(this.scratchpadEntries.values())
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt);
    const overflow = Math.max(0, ordered.length - maxEntries);
    const evicted = ordered.slice(0, overflow).map(entry => entry.id);
    for (const id of evicted) {
      this.scratchpadEntries.delete(id);
    }
    if (evicted.length > 0) {
      this.enqueuePersist(async () => {
        for (const id of evicted) {
          await executeQuery(this.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [id]);
        }
        this.syncScratchpadMirror();
      });
    } else {
      this.syncScratchpadMirror();
    }
    return evicted;
  }
}
