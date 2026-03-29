import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import {
  hasColumn,
  runInTransaction as runSqliteTransaction,
} from '../../persistence/sqlite-utils.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { MemoryJournal } from './journal.js';
import type {
  ContactProfileArtifact,
  MemoryAbstractionLink,
  MemoryAbstractionLinkInput,
  MemoryBulkUpdatePatch,
  MemoryDeleteVersion,
  MemoryListOptions,
  MemoryLink,
  MemoryPatchEvent,
  MemorySoftDeleteOptions,
  MemoryStoreUpdatePatch,
  MemoryUndoSoftDeleteOptions,
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
  MemoryWriteCommit,
} from './memory-store-port.js';
import {
  normalizeMemoryScopeQuery,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  normalizeConsentFlags,
  normalizeFormationVAD,
  normalizeMemorySourceType,
  normalizeMemoryProvenance,
  inferMemorySourceTypeFromSourceRef,
  type MemoryScopeQuery,
  type MemoryScopeRef,
  type PurrMemory,
  type SensitivityLevel,
  type ConsentFlags,
  type MemoryFormationVAD,
  type MemoryProvenance,
} from './types.js';

const SCRATCHPAD_MAX_ENTRIES = 64;
const SCRATCHPAD_MAX_CONTENT_CHARS = 1_000;
const LEXICAL_QUERY_MAX_TOKENS = 10;
const LEXICAL_SCAN_MAX_ROWS = 500;
const LEXICAL_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'with',
  'you',
  'your',
]);
const log = createComponentLogger('MemoryStore');

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

interface MemoryRow {
  id: string;
  text: string;
  type: PurrMemory['type'];
  importance: number;
  confidence: number;
  emotional_valence: number;
  formation_vad: string | null;
  salience: number;
  source_ref: string;
  source_type: string | null;
  provenance_json: string | null;
  extracted_at: number;
  last_accessed: number;
  access_count: number;
  superseded_by: string | null;
  tags: string;
  scope_ref_kind: string | null;
  scope_ref_id: string | null;
  scope_ref_label: string | null;
  scope_tags: string | null;
  provenance_refs: string | null;
  sensitivity: string | null;
  consent_flags: string | null;
  contact_id: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
  delete_reason: string | null;
}

interface MemoryDeleteVersionRow {
  delete_id: string;
  memory_id: string;
  snapshot_json: string;
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

interface MemoryPatchEventRow {
  id: string;
  memory_id: string;
  source_ref: string;
  source_type: string;
  provenance_json: string | null;
  reason: string | null;
  patch_json: string;
  previous_json: string;
  next_json: string;
  created_at: number;
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
  source_memory_ids: string;
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

interface MemoryStoreOptions {
  notesDir?: string;
  scratchpadMirrorPath?: string;
  journal?: MemoryJournal;
}

function mapMemoryDeleteVersionRow(row: MemoryDeleteVersionRow): MemoryDeleteVersion {
  let snapshot: PurrMemory;
  try {
    snapshot = JSON.parse(row.snapshot_json) as PurrMemory;
  } catch {
    snapshot = {
      id: row.memory_id,
      text: '',
      type: 'semantic',
      importance: 0.5,
      confidence: 0.7,
      emotionalValence: 0,
      salience: 0.5,
      sourceRef: 'snapshot:corrupt',
      extractedAt: row.deleted_at,
      lastAccessed: row.deleted_at,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
    };
  }

  return {
    deleteId: row.delete_id,
    memoryId: row.memory_id,
    snapshot,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by ?? 'unknown',
    deleteReason: row.delete_reason ?? undefined,
    restoredAt: row.restored_at ?? undefined,
    restoredBy: row.restored_by ?? undefined,
  };
}

function mapMemoryLinkRow(row: MemoryLinkRow): MemoryLink {
  return {
    id1: row.id1,
    id2: row.id2,
    linkType: row.link_type,
    createdAt: row.created_at,
  };
}

function mapMemoryAbstractionLinkRow(row: MemoryAbstractionLinkRow): MemoryAbstractionLink {
  return {
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    abstractedMemoryId: row.abstracted_memory_id,
    externalRef: row.external_ref,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
    reason: row.reason ?? undefined,
  };
}

function parseJsonRecord(value: string | null, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch {
    return fallback;
  }
}

function mapMemoryPatchEventRow(row: MemoryPatchEventRow): MemoryPatchEvent {
  return {
    id: row.id,
    memoryId: row.memory_id,
    sourceRef: row.source_ref,
    sourceType: normalizeMemorySourceType(row.source_type),
    provenance: normalizeMemoryProvenance(parseJsonRecord(row.provenance_json, {})),
    reason: row.reason ?? undefined,
    patch: parseJsonRecord(row.patch_json),
    previousValues: parseJsonRecord(row.previous_json),
    nextValues: parseJsonRecord(row.next_json),
    createdAt: row.created_at,
  };
}

function mapMemoryRow(row: MemoryRow): PurrMemory {
  let tags: string[] = [];
  let scopeTags: string[] = [];
  let provenanceRefs: string[] = [];
  let consentFlags: ConsentFlags = {};
  let formationVAD: MemoryFormationVAD | undefined;
  let provenance: MemoryProvenance | undefined;
  let scopeRef: MemoryScopeRef | undefined;
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  try {
    const parsed = JSON.parse(row.scope_tags ?? '[]');
    scopeTags = Array.isArray(parsed)
      ? normalizeMemoryScopeTags(parsed.filter((entry): entry is string => typeof entry === 'string'))
      : [];
  } catch {
    scopeTags = [];
  }
  try {
    const parsed = JSON.parse(row.provenance_refs ?? '[]');
    provenanceRefs = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
  } catch {
    provenanceRefs = [];
  }
  try {
    consentFlags = normalizeConsentFlags(JSON.parse(row.consent_flags ?? '{}'));
  } catch {
    consentFlags = {};
  }
  try {
    const parsed = JSON.parse(row.formation_vad ?? 'null');
    formationVAD = normalizeFormationVAD(parsed as Partial<MemoryFormationVAD> | undefined);
  } catch {
    formationVAD = undefined;
  }
  try {
    provenance = normalizeMemoryProvenance(JSON.parse(row.provenance_json ?? '{}'));
  } catch {
    provenance = undefined;
  }
  scopeRef = normalizeMemoryScopeRef({
    kind: row.scope_ref_kind ?? '',
    id: row.scope_ref_id ?? '',
    ...(row.scope_ref_label ? { label: row.scope_ref_label } : {}),
  });

  return {
    id: row.id,
    text: row.text,
    type: row.type,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence,
    formationVAD,
    salience: row.salience,
    sourceRef: row.source_ref,
    sourceType: normalizeMemorySourceType(row.source_type, inferMemorySourceTypeFromSourceRef(row.source_ref)),
    ...(provenance ? { provenance } : {}),
    extractedAt: row.extracted_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    supersededBy: row.superseded_by ?? undefined,
    tags,
    ...(scopeRef ? { scopeRef } : {}),
    ...(scopeTags.length > 0 ? { scopeTags } : {}),
    provenanceRefs,
    sensitivity: (row.sensitivity ?? 'personal') as SensitivityLevel,
    consentFlags,
    contactId: row.contact_id ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
    deleteReason: row.delete_reason ?? undefined,
  };
}

function mapScratchpadRow(row: ScratchpadRow): ScratchpadEntry {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeLexicalQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeLexicalQuery(query: string): string[] {
  const normalized = normalizeLexicalQuery(query);
  if (!normalized) return [];

  const rawTokens = normalized.match(/[a-z0-9']+/g) ?? [];
  const unique: string[] = [];
  for (const token of rawTokens) {
    if (token.length < 3) continue;
    if (LEXICAL_STOPWORDS.has(token)) continue;
    if (unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= LEXICAL_QUERY_MAX_TOKENS) break;
  }

  if (unique.length > 0) return unique;

  // Fallback for short queries such as "AI" that may have no >=3-char terms.
  for (const token of rawTokens) {
    if (token.length < 2) continue;
    if (LEXICAL_STOPWORDS.has(token)) continue;
    if (unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= LEXICAL_QUERY_MAX_TOKENS) break;
  }
  return unique;
}

function scoreLexicalMatch(
  memory: PurrMemory,
  tokens: readonly string[],
  normalizedQuery: string,
): number {
  if (tokens.length === 0) return 0;
  const text = memory.text.toLowerCase();
  const tags = memory.tags.map(tag => tag.toLowerCase());

  let tokenHits = 0;
  for (const token of tokens) {
    if (text.includes(token)) {
      tokenHits += 1;
      continue;
    }
    if (tags.some(tag => tag.includes(token))) {
      tokenHits += 0.75;
    }
  }

  if (tokenHits <= 0) return 0;

  const coverage = Math.min(1, tokenHits / tokens.length);
  const phraseBonus = normalizedQuery.length >= 3 && text.includes(normalizedQuery) ? 0.3 : 0;
  const recencyDays = Math.max(0, (Date.now() - memory.extractedAt) / (1000 * 60 * 60 * 24));
  const recencyBoost = 1 / (1 + recencyDays / 90);
  const salienceBoost = Math.max(0, Math.min(0.2, memory.salience * 0.2));
  const importanceBoost = Math.max(0, Math.min(0.2, memory.importance * 0.2));

  return Math.min(1.5, coverage + phraseBonus + recencyBoost * 0.2 + salienceBoost + importanceBoost);
}

function lexicalScoreToSimilarity(score: number): number {
  const normalized = Math.max(0, Math.min(1, score));
  return Math.max(0.3, Math.min(0.98, 0.3 + normalized * 0.68));
}

function buildScopeQuerySql(
  scopeQuery: MemoryScopeQuery | undefined,
): { clause: string; params: unknown[] } {
  if (!scopeQuery || scopeQuery.mode !== 'only') {
    return { clause: '', params: [] };
  }

  const fragments: string[] = [];
  const params: unknown[] = [];

  for (const ref of scopeQuery.refs ?? []) {
    fragments.push('(scope_ref_kind = ? AND scope_ref_id = ?)');
    params.push(ref.kind, ref.id);
  }
  for (const tag of scopeQuery.tags ?? []) {
    fragments.push('LOWER(scope_tags) LIKE ?');
    params.push(`%\"${tag}\"%`);
  }

  if (fragments.length === 0) {
    return { clause: '', params: [] };
  }

  return {
    clause: `AND (${fragments.join(' OR ')})`,
    params,
  };
}

export class MemoryStore {
  private db: Database.Database;
  private embeddingDims: number;
  private scratchpadMirrorPath: string | null;
  private journal: MemoryJournal | null;

  constructor(
    db: Database.Database,
    embeddingDims: number = 1024,
    options: MemoryStoreOptions = {},
  ) {
    this.db = db;
    this.embeddingDims = embeddingDims;
    this.scratchpadMirrorPath = this.resolveScratchpadMirrorPath(options);
    this.journal = options.journal ?? null;
    this.loadExtensions();
    this.createTables();
    this.migrateSchema();
    this.syncScratchpadMirror();
  }

  private resolveScratchpadMirrorPath(options: MemoryStoreOptions): string | null {
    if (typeof options.scratchpadMirrorPath === 'string' && options.scratchpadMirrorPath.trim().length > 0) {
      return options.scratchpadMirrorPath.trim();
    }
    if (typeof options.notesDir === 'string' && options.notesDir.trim().length > 0) {
      return join(options.notesDir.trim(), 'scratchpad.json');
    }
    return null;
  }

  private loadExtensions(): void {
    sqliteVec.load(this.db);
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l2_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.7,
        emotional_valence REAL NOT NULL DEFAULT 0.0,
        formation_vad TEXT,
        salience REAL NOT NULL DEFAULT 0.5,
        source_ref TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'unknown',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        extracted_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        scope_ref_kind TEXT,
        scope_ref_id TEXT,
        scope_ref_label TEXT,
        scope_tags TEXT NOT NULL DEFAULT '[]',
        provenance_refs TEXT NOT NULL DEFAULT '[]',
        contact_id TEXT,
        deleted_at INTEGER,
        deleted_by TEXT,
        delete_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_l2_type ON l2_memories(type);
      CREATE INDEX IF NOT EXISTS idx_l2_salience ON l2_memories(salience);

      CREATE TABLE IF NOT EXISTS contact_profiles (
        contact_id TEXT PRIMARY KEY,
        summary_text TEXT NOT NULL,
        source_memory_ids TEXT NOT NULL DEFAULT '[]',
        confidence_score REAL NOT NULL DEFAULT 0,
        novelty_score REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contact_profiles_updated_at ON contact_profiles(updated_at);

      CREATE TABLE IF NOT EXISTS l2_memory_delete_versions (
        delete_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        deleted_by TEXT,
        delete_reason TEXT,
        restored_at INTEGER,
        restored_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_memory ON l2_memory_delete_versions(memory_id);
      CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_active ON l2_memory_delete_versions(restored_at, deleted_at);

      CREATE TABLE IF NOT EXISTS l2_memory_abstraction_links (
        id TEXT PRIMARY KEY,
        source_memory_id TEXT NOT NULL,
        abstracted_memory_id TEXT NOT NULL,
        external_ref TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_l2_abstraction_source ON l2_memory_abstraction_links(source_memory_id);
      CREATE INDEX IF NOT EXISTS idx_l2_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id);

      CREATE TABLE IF NOT EXISTS l2_memory_patch_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_type TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        reason TEXT,
        patch_json TEXT NOT NULL,
        previous_json TEXT NOT NULL,
        next_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_l2_patch_events_memory ON l2_memory_patch_events(memory_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_links (
        id1 TEXT NOT NULL,
        id2 TEXT NOT NULL,
        link_type TEXT NOT NULL DEFAULT 'related',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id1, id2)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1);
      CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2);

      CREATE VIRTUAL TABLE IF NOT EXISTS l2_memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${this.embeddingDims}]
      );

      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at ON scratchpad_entries(updated_at DESC, created_at DESC);
    `);
  }

  private migrateSchema(): void {
    // Add sensitivity column (default 'personal' — safe default for existing data)
    try {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'personal'`);
    } catch { /* column already exists */ }

    // Add consent_flags column (default '{}' — no restrictions)
    try {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN consent_flags TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }

    // Add contact_id column for canonical contact linking
    if (!hasColumn(this.db, 'l2_memories', 'contact_id')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN contact_id TEXT`);
    }

    if (hasColumn(this.db, 'l2_memories', 'contact_id')) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_contact ON l2_memories(contact_id)`);
    }

    if (!hasColumn(this.db, 'l2_memories', 'provenance_refs')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN provenance_refs TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn(this.db, 'l2_memories', 'scope_ref_kind')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_kind TEXT`);
    }
    if (!hasColumn(this.db, 'l2_memories', 'scope_ref_id')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_id TEXT`);
    }
    if (!hasColumn(this.db, 'l2_memories', 'scope_ref_label')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_label TEXT`);
    }
    if (!hasColumn(this.db, 'l2_memories', 'scope_tags')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_tags TEXT NOT NULL DEFAULT '[]'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_scope_ref ON l2_memories(scope_ref_kind, scope_ref_id)`);

    if (!hasColumn(this.db, 'l2_memories', 'formation_vad')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN formation_vad TEXT`);
    }
    if (!hasColumn(this.db, 'l2_memories', 'source_type')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unknown'`);
    }
    if (!hasColumn(this.db, 'l2_memories', 'provenance_json')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_source_type ON l2_memories(source_type)`);

    // Add soft-delete columns for reversible destructive operations
    try {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN deleted_at INTEGER`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN deleted_by TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN delete_reason TEXT`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_deleted_at ON l2_memories(deleted_at)`);

    // Create delete-version snapshots table if missing (idempotent).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l2_memory_delete_versions (
        delete_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        deleted_by TEXT,
        delete_reason TEXT,
        restored_at INTEGER,
        restored_by TEXT
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_memory ON l2_memory_delete_versions(memory_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_active ON l2_memory_delete_versions(restored_at, deleted_at)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l2_memory_patch_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_type TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        reason TEXT,
        patch_json TEXT NOT NULL,
        previous_json TEXT NOT NULL,
        next_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_patch_events_memory ON l2_memory_patch_events(memory_id, created_at DESC)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l2_memory_abstraction_links (
        id TEXT PRIMARY KEY,
        source_memory_id TEXT NOT NULL,
        abstracted_memory_id TEXT NOT NULL,
        external_ref TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        reason TEXT
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_abstraction_source ON l2_memory_abstraction_links(source_memory_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at ON scratchpad_entries(updated_at DESC, created_at DESC)`);

    // Create memory_links table for linking related memories
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id1 TEXT NOT NULL,
        id2 TEXT NOT NULL,
        link_type TEXT NOT NULL DEFAULT 'related',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id1, id2)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2)`);
  }

  // ── L2 Memories ──

  insertMemory(memory: PurrMemory, embedding: Float32Array): void {
    const insertMem = this.db.prepare(`
      INSERT INTO l2_memories (id, text, type, importance, confidence, emotional_valence, formation_vad,
        salience, source_ref, source_type, provenance_json, extracted_at, last_accessed, access_count, superseded_by, tags,
        scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs, sensitivity,
        consent_flags, contact_id, deleted_at, deleted_by, delete_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertVec = this.db.prepare(`
      INSERT INTO l2_memory_embeddings (memory_id, embedding)
      VALUES (?, ?)
    `);

    const transaction = this.db.transaction(() => {
      insertMem.run(
        memory.id,
        memory.text,
        memory.type,
        memory.importance,
        memory.confidence,
        memory.emotionalValence,
        memory.formationVAD ? JSON.stringify(memory.formationVAD) : null,
        memory.salience,
        memory.sourceRef,
        normalizeMemorySourceType(memory.sourceType, inferMemorySourceTypeFromSourceRef(memory.sourceRef)),
        JSON.stringify(normalizeMemoryProvenance(memory.provenance) ?? {}),
        memory.extractedAt,
        memory.lastAccessed,
        memory.accessCount,
        memory.supersededBy ?? null,
        JSON.stringify(memory.tags),
        memory.scopeRef?.kind ?? null,
        memory.scopeRef?.id ?? null,
        memory.scopeRef?.label ?? null,
        JSON.stringify(normalizeMemoryScopeTags(memory.scopeTags)),
        JSON.stringify(memory.provenanceRefs ?? []),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- default for callers without sensitivity
        memory.sensitivity ?? 'personal',
        JSON.stringify(memory.consentFlags ?? {}),
        memory.contactId ?? null,
        memory.deletedAt ?? null,
        memory.deletedBy ?? null,
        memory.deleteReason ?? null,
      );
      insertVec.run(memory.id, embeddingToBuffer(embedding));
    });

    transaction();
    this.journal?.onInsert(memory);
  }

  persistMemoryWrite(input: MemoryWriteCommit): void {
    const supersededMemoryIds = [...new Set(input.supersededMemoryIds ?? [])];

    runSqliteTransaction(this.db, () => {
      for (const memoryId of supersededMemoryIds) {
        this.updateMemory(memoryId, { supersededBy: input.memory.id });
      }
      this.insertMemory(input.memory, input.embedding);
    });
  }

  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Array<PurrMemory & { similarity: number }> {
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const scopeSql = buildScopeQuerySql(normalizedScopeQuery);
    const stmt = this.db.prepare(`
      SELECT
        m.*,
        v.distance
      FROM l2_memory_embeddings v
      JOIN l2_memories m ON m.id = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND m.superseded_by IS NULL
        AND m.deleted_at IS NULL
        ${scopeSql.clause}
      ORDER BY v.distance ASC
    `);

    const rows = stmt.all(
      embeddingToBuffer(embedding),
      limit * 2,
      ...scopeSql.params,
    ) as Array<MemoryRow & {
      distance: number;
    }>;

    return rows
      .map(row => {
        // vec0 returns L2 distance; for L2-normalized unit vectors,
        // cosine similarity = 1 - L2_dist² / 2
        const similarity = 1 - (row.distance * row.distance) / 2;
        if (similarity < threshold) return null;
        return { ...mapMemoryRow(row), similarity };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .slice(0, limit);
  }

  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Array<PurrMemory & { similarity: number }> {
    const normalizedQuery = normalizeLexicalQuery(query);
    if (!normalizedQuery) return [];
    const tokens = tokenizeLexicalQuery(normalizedQuery);
    if (tokens.length === 0) return [];
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const scopeSql = buildScopeQuerySql(normalizedScopeQuery);

    const clauses = tokens.map(() => '(LOWER(text) LIKE ? OR LOWER(tags) LIKE ?)');
    const params: unknown[] = [];
    for (const token of tokens) {
      const pattern = `%${token}%`;
      params.push(pattern, pattern);
    }

    const normalizedLimit = this.normalizeListLimit(limit, 10, 1, 500);
    const scanLimit = this.normalizeListLimit(
      Math.max(40, normalizedLimit * 8),
      80,
      20,
      LEXICAL_SCAN_MAX_ROWS,
    );
    const stmt = this.db.prepare(`
      SELECT *
      FROM l2_memories
      WHERE superseded_by IS NULL
        AND deleted_at IS NULL
        AND (${clauses.join(' OR ')})
        ${scopeSql.clause}
      ORDER BY extracted_at DESC, id DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, ...scopeSql.params, scanLimit) as MemoryRow[];
    return rows
      .map(mapMemoryRow)
      .map(memory => {
        const lexicalScore = scoreLexicalMatch(memory, tokens, normalizedQuery);
        if (lexicalScore <= 0) return null;
        return {
          ...memory,
          similarity: lexicalScoreToSimilarity(lexicalScore),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => {
        if (right.similarity !== left.similarity) {
          return right.similarity - left.similarity;
        }
        if (right.salience !== left.salience) {
          return right.salience - left.salience;
        }
        return right.extractedAt - left.extractedAt;
      })
      .slice(0, normalizedLimit);
  }

  updateMemory(id: string, updates: MemoryStoreUpdatePatch): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.text !== undefined) {
      setClauses.push('text = ?');
      values.push(updates.text);
    }
    if (updates.importance !== undefined) {
      setClauses.push('importance = ?');
      values.push(updates.importance);
    }
    if (updates.confidence !== undefined) {
      setClauses.push('confidence = ?');
      values.push(updates.confidence);
    }
    if (updates.emotionalValence !== undefined) {
      setClauses.push('emotional_valence = ?');
      values.push(updates.emotionalValence);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'formationVAD')) {
      setClauses.push('formation_vad = ?');
      values.push(updates.formationVAD ? JSON.stringify(normalizeFormationVAD(updates.formationVAD)) : null);
    }
    if (updates.salience !== undefined) {
      setClauses.push('salience = ?');
      values.push(updates.salience);
    }
    if (updates.lastAccessed !== undefined) {
      setClauses.push('last_accessed = ?');
      values.push(updates.lastAccessed);
    }
    if (updates.accessCount !== undefined) {
      setClauses.push('access_count = ?');
      values.push(updates.accessCount);
    }
    if (updates.supersededBy !== undefined) {
      setClauses.push('superseded_by = ?');
      values.push(updates.supersededBy);
    }
    if (updates.sensitivity !== undefined) {
      setClauses.push('sensitivity = ?');
      values.push(updates.sensitivity);
    }
    if (updates.consentFlags !== undefined) {
      setClauses.push('consent_flags = ?');
      values.push(JSON.stringify(updates.consentFlags));
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.scopeRef !== undefined) {
      const normalizedScopeRef = normalizeMemoryScopeRef(updates.scopeRef);
      setClauses.push('scope_ref_kind = ?');
      values.push(normalizedScopeRef?.kind ?? null);
      setClauses.push('scope_ref_id = ?');
      values.push(normalizedScopeRef?.id ?? null);
      setClauses.push('scope_ref_label = ?');
      values.push(normalizedScopeRef?.label ?? null);
    }
    if (updates.scopeTags !== undefined) {
      setClauses.push('scope_tags = ?');
      values.push(JSON.stringify(normalizeMemoryScopeTags(updates.scopeTags)));
    }
    if (updates.provenanceRefs !== undefined) {
      setClauses.push('provenance_refs = ?');
      values.push(JSON.stringify(updates.provenanceRefs));
    }
    if (updates.sourceType !== undefined) {
      setClauses.push('source_type = ?');
      values.push(normalizeMemorySourceType(updates.sourceType));
    }
    if (updates.provenance !== undefined) {
      setClauses.push('provenance_json = ?');
      values.push(JSON.stringify(normalizeMemoryProvenance(updates.provenance) ?? {}));
    }
    if (updates.contactId !== undefined) {
      setClauses.push('contact_id = ?');
      values.push(updates.contactId);
    }
    if (updates.deletedAt !== undefined) {
      setClauses.push('deleted_at = ?');
      values.push(updates.deletedAt);
    }
    if (updates.deletedBy !== undefined) {
      setClauses.push('deleted_by = ?');
      values.push(updates.deletedBy);
    }
    if (updates.deleteReason !== undefined) {
      setClauses.push('delete_reason = ?');
      values.push(updates.deleteReason);
    }

    if (setClauses.length === 0) return;
    if (updates.text !== undefined && !(updates.embedding instanceof Float32Array)) {
      throw new Error('updateMemory requires embedding when text is updated');
    }

    const updateMem = this.db.prepare(
      `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ?`,
    );
    const updateVec = this.db.prepare(`
      UPDATE l2_memory_embeddings
      SET embedding = ?
      WHERE memory_id = ?
    `);

    const transaction = this.db.transaction(() => {
      updateMem.run(...values, id);
      if (updates.embedding instanceof Float32Array) {
        updateVec.run(embeddingToBuffer(updates.embedding), id);
      }
    });
    transaction();
  }

  runInTransaction<T>(handler: () => T): T {
    return runSqliteTransaction(this.db, handler);
  }

  recordPatchEvent(event: MemoryPatchEvent): void {
    this.db.prepare(`
      INSERT INTO l2_memory_patch_events (
        id, memory_id, source_ref, source_type, provenance_json, reason, patch_json, previous_json, next_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.memoryId,
      event.sourceRef,
      normalizeMemorySourceType(event.sourceType),
      JSON.stringify(normalizeMemoryProvenance(event.provenance) ?? {}),
      event.reason ?? null,
      JSON.stringify(event.patch),
      JSON.stringify(event.previousValues),
      JSON.stringify(event.nextValues),
      event.createdAt,
    );
  }

  getPatchEvents(memoryId: string): MemoryPatchEvent[] {
    const normalized = memoryId.trim();
    if (!normalized) return [];
    const rows = this.db.prepare(`
      SELECT *
      FROM l2_memory_patch_events
      WHERE memory_id = ?
      ORDER BY created_at DESC
    `).all(normalized) as MemoryPatchEventRow[];
    return rows.map(mapMemoryPatchEventRow);
  }

  getAllActiveMemories(limit: number = 10_000): PurrMemory[] {
    const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
    const stmt = this.db.prepare(`
      SELECT * FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL
      LIMIT ?
    `);
    const rows = stmt.all(safeLimit) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  listActiveMemories(options: MemoryListOptions = {}): PurrMemory[] {
    const limit = this.normalizeListLimit(options.limit ?? 50, 50, 1, 500);
    const offset = this.normalizeListOffset(options.offset ?? 0);
    const rows = this.db.prepare(`
      SELECT *
      FROM l2_memories
      WHERE superseded_by IS NULL AND deleted_at IS NULL
      ORDER BY extracted_at DESC, id DESC
      LIMIT ?
      OFFSET ?
    `).all(limit, offset) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  countActiveMemories(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM l2_memories
      WHERE superseded_by IS NULL AND deleted_at IS NULL
    `).get() as { count: number };
    return row.count;
  }

  getById(id: string): PurrMemory | undefined {
    const stmt = this.db.prepare('SELECT * FROM l2_memories WHERE id = ?');
    const row = stmt.get(id) as MemoryRow | undefined;
    return row ? mapMemoryRow(row) : undefined;
  }

  softDeleteMemory(
    id: string,
    options: MemorySoftDeleteOptions = {},
  ): MemoryDeleteVersion | null {
    const deleteId = options.deleteId ?? randomUUID();
    const deletedAt = options.deletedAt ?? Date.now();
    const deletedBy = options.deletedBy?.trim() || 'agent';
    const reason = options.reason?.trim();

    const selectStmt = this.db.prepare(`
      SELECT * FROM l2_memories
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1
    `);
    const insertVersion = this.db.prepare(`
      INSERT INTO l2_memory_delete_versions (
        delete_id,
        memory_id,
        snapshot_json,
        deleted_at,
        deleted_by,
        delete_reason
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = this.db.prepare(`
      UPDATE l2_memories
      SET deleted_at = ?, deleted_by = ?, delete_reason = ?
      WHERE id = ? AND deleted_at IS NULL
    `);

    const transaction = this.db.transaction(() => {
      const row = selectStmt.get(id) as MemoryRow | undefined;
      if (!row) return null;

      const snapshot = mapMemoryRow(row);
      insertVersion.run(
        deleteId,
        id,
        JSON.stringify(snapshot),
        deletedAt,
        deletedBy,
        reason ?? null,
      );
      const result = updateStmt.run(
        deletedAt,
        deletedBy,
        reason ?? null,
        id,
      );
      if (result.changes === 0) return null;

      return {
        deleteId,
        memoryId: id,
        snapshot,
        deletedAt,
        deletedBy,
        deleteReason: reason,
      } satisfies MemoryDeleteVersion;
    });

    const deleteVersion = transaction();
    if (deleteVersion) {
      this.journal?.onSoftDelete(deleteVersion);
    }
    return deleteVersion;
  }

  undoSoftDelete(
    deleteId: string,
    options: MemoryUndoSoftDeleteOptions = {},
  ): MemoryDeleteVersion | null {
    const restoredAt = options.restoredAt ?? Date.now();
    const restoredBy = options.restoredBy?.trim() || 'agent';

    const selectStmt = this.db.prepare(`
      SELECT * FROM l2_memory_delete_versions
      WHERE delete_id = ? AND restored_at IS NULL
      LIMIT 1
    `);
    const restoreMemoryStmt = this.db.prepare(`
      UPDATE l2_memories
      SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
      WHERE id = ?
    `);
    const restoreVersionStmt = this.db.prepare(`
      UPDATE l2_memory_delete_versions
      SET restored_at = ?, restored_by = ?
      WHERE delete_id = ? AND restored_at IS NULL
    `);

    const transaction = this.db.transaction(() => {
      const versionRow = selectStmt.get(deleteId) as MemoryDeleteVersionRow | undefined;
      if (!versionRow) return null;

      restoreMemoryStmt.run(versionRow.memory_id);
      const versionResult = restoreVersionStmt.run(restoredAt, restoredBy, deleteId);
      if (versionResult.changes === 0) return null;

      return {
        ...mapMemoryDeleteVersionRow(versionRow),
        restoredAt,
        restoredBy,
      } satisfies MemoryDeleteVersion;
    });

    const restoreVersion = transaction();
    if (restoreVersion) {
      this.journal?.onRestore(restoreVersion);
    }
    return restoreVersion;
  }

  getDeleteVersion(deleteId: string): MemoryDeleteVersion | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM l2_memory_delete_versions
      WHERE delete_id = ?
      LIMIT 1
    `).get(deleteId) as MemoryDeleteVersionRow | undefined;
    if (!row) return undefined;
    return mapMemoryDeleteVersionRow(row);
  }

  recordAbstractionLink(input: MemoryAbstractionLinkInput): MemoryAbstractionLink {
    const sourceMemoryId = input.sourceMemoryId.trim();
    const abstractedMemoryId = input.abstractedMemoryId.trim();
    const externalRef = input.externalRef.trim();
    if (!sourceMemoryId || !abstractedMemoryId || !externalRef) {
      throw new Error('sourceMemoryId, abstractedMemoryId, and externalRef are required');
    }

    const id = input.linkId?.trim() || randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    const createdBy = input.createdBy?.trim() || undefined;
    const reason = input.reason?.trim() || undefined;

    this.db.prepare(`
      INSERT INTO l2_memory_abstraction_links (
        id,
        source_memory_id,
        abstracted_memory_id,
        external_ref,
        created_at,
        created_by,
        reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sourceMemoryId,
      abstractedMemoryId,
      externalRef,
      createdAt,
      createdBy ?? null,
      reason ?? null,
    );

    return {
      id,
      sourceMemoryId,
      abstractedMemoryId,
      externalRef,
      createdAt,
      createdBy,
      reason,
    };
  }

  getAbstractionLinksForSourceMemory(sourceMemoryId: string): MemoryAbstractionLink[] {
    const normalized = sourceMemoryId.trim();
    if (!normalized) return [];
    const rows = this.db.prepare(`
      SELECT *
      FROM l2_memory_abstraction_links
      WHERE source_memory_id = ?
      ORDER BY created_at DESC
    `).all(normalized) as MemoryAbstractionLinkRow[];
    return rows.map(mapMemoryAbstractionLinkRow);
  }

  getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): MemoryAbstractionLink[] {
    const normalized = abstractedMemoryId.trim();
    if (!normalized) return [];
    const rows = this.db.prepare(`
      SELECT *
      FROM l2_memory_abstraction_links
      WHERE abstracted_memory_id = ?
      ORDER BY created_at DESC
    `).all(normalized) as MemoryAbstractionLinkRow[];
    return rows.map(mapMemoryAbstractionLinkRow);
  }

  getStats(): { total: number; byType: Record<string, number>; avgSalience: number } {
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) as count, AVG(salience) as avg_sal
      FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL GROUP BY type
    `).all() as Array<{ type: string; count: number; avg_sal: number }>;

    const byType: Record<string, number> = {};
    let total = 0;
    let salSum = 0;
    for (const row of rows) {
      byType[row.type] = row.count;
      total += row.count;
      salSum += row.avg_sal * row.count;
    }
    return { total, byType, avgSalience: total > 0 ? salSum / total : 0 };
  }

  getMemoriesByChannel(channelId: string, limit: number): PurrMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM l2_memories
      WHERE source_ref LIKE ? AND superseded_by IS NULL AND deleted_at IS NULL
      ORDER BY extracted_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(`${channelId}:%`, limit) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  getMemoriesByContact(contactId: string, limit: number): PurrMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM l2_memories
      WHERE contact_id = ? AND superseded_by IS NULL AND deleted_at IS NULL
      ORDER BY salience DESC, extracted_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(contactId, limit) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  // ── Memory Links ──

  linkMemories(id1: string, id2: string, linkType: string = 'related'): MemoryLink | null {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    const normalizedType = linkType.trim() || 'related';
    if (!normalizedId1 || !normalizedId2) return null;
    if (normalizedId1 === normalizedId2) return null;

    // Canonical ordering: alphabetically smaller id first
    const [first, second] = normalizedId1 < normalizedId2
      ? [normalizedId1, normalizedId2]
      : [normalizedId2, normalizedId1];

    const now = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO memory_links (id1, id2, link_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(first, second, normalizedType, now);

    if (result.changes === 0) return null;
    return { id1: first, id2: second, linkType: normalizedType, createdAt: now };
  }

  unlinkMemories(id1: string, id2: string): boolean {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) return false;

    // Try both orderings in case caller doesn't know canonical order
    const [first, second] = normalizedId1 < normalizedId2
      ? [normalizedId1, normalizedId2]
      : [normalizedId2, normalizedId1];

    const result = this.db.prepare(`
      DELETE FROM memory_links WHERE id1 = ? AND id2 = ?
    `).run(first, second);
    return result.changes > 0;
  }

  getLinkedMemories(id: string): MemoryLink[] {
    const normalizedId = id.trim();
    if (!normalizedId) return [];

    const rows = this.db.prepare(`
      SELECT id1, id2, link_type, created_at
      FROM memory_links
      WHERE id1 = ? OR id2 = ?
      ORDER BY created_at DESC
    `).all(normalizedId, normalizedId) as MemoryLinkRow[];

    return rows.map(mapMemoryLinkRow);
  }

  // ── Bulk Operations ──

  bulkDelete(ids: string[]): number {
    if (!ids.length) return 0;
    const now = Date.now();
    const deletedBy = 'admin:bulk';

    const selectStmt = this.db.prepare(`
      SELECT * FROM l2_memories
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1
    `);
    const insertVersion = this.db.prepare(`
      INSERT INTO l2_memory_delete_versions (
        delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = this.db.prepare(`
      UPDATE l2_memories
      SET deleted_at = ?, deleted_by = ?, delete_reason = ?
      WHERE id = ? AND deleted_at IS NULL
    `);

    let count = 0;
    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        const normalizedId = id.trim();
        if (!normalizedId) continue;

        const row = selectStmt.get(normalizedId) as MemoryRow | undefined;
        if (!row) continue;

        const snapshot = mapMemoryRow(row);
        const deleteId = randomUUID();
        insertVersion.run(
          deleteId,
          normalizedId,
          JSON.stringify(snapshot),
          now,
          deletedBy,
          'bulk delete',
        );
        const result = updateStmt.run(now, deletedBy, 'bulk delete', normalizedId);
        if (result.changes > 0) count++;
      }
    });

    transaction();
    return count;
  }

  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): number {
    if (!ids.length) return 0;

    const setClauses: string[] = [];
    const setValues: unknown[] = [];

    if (fields.type !== undefined) {
      setClauses.push('type = ?');
      setValues.push(fields.type);
    }
    if (fields.sensitivity !== undefined) {
      setClauses.push('sensitivity = ?');
      setValues.push(fields.sensitivity);
    }

    if (setClauses.length === 0) return 0;

    const stmt = this.db.prepare(
      `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    );

    let count = 0;
    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        const normalizedId = id.trim();
        if (!normalizedId) continue;
        const result = stmt.run(...setValues, normalizedId);
        if (result.changes > 0) count++;
      }
    });

    transaction();
    return count;
  }

  upsertContactProfile(profile: ContactProfileArtifact): void {
    this.db.prepare(`
      INSERT INTO contact_profiles (
        contact_id,
        summary_text,
        source_memory_ids,
        confidence_score,
        novelty_score,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        source_memory_ids = excluded.source_memory_ids,
        confidence_score = excluded.confidence_score,
        novelty_score = excluded.novelty_score,
        updated_at = excluded.updated_at
    `).run(
      profile.contactId,
      profile.summary,
      JSON.stringify(profile.sourceMemoryIds),
      profile.confidenceScore,
      profile.noveltyScore,
      profile.updatedAt,
    );
  }

  getContactProfile(contactId: string): ContactProfileArtifact | undefined {
    const row = this.db.prepare(`
      SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      FROM contact_profiles
      WHERE contact_id = ?
      LIMIT 1
    `).get(contactId) as ContactProfileRow | undefined;
    if (!row) return undefined;

    let sourceMemoryIds: string[] = [];
    try {
      sourceMemoryIds = JSON.parse(row.source_memory_ids) as string[];
    } catch {
      sourceMemoryIds = [];
    }

    return {
      contactId: row.contact_id,
      summary: row.summary_text,
      sourceMemoryIds,
      confidenceScore: row.confidence_score,
      noveltyScore: row.novelty_score,
      updatedAt: row.updated_at,
    };
  }

  listContactProfiles(): ContactProfileArtifact[] {
    const rows = this.db.prepare(`
      SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      FROM contact_profiles
      ORDER BY updated_at DESC
    `).all() as ContactProfileRow[];

    return rows.map(row => {
      let sourceMemoryIds: string[] = [];
      try {
        sourceMemoryIds = JSON.parse(row.source_memory_ids) as string[];
      } catch {
        sourceMemoryIds = [];
      }

      return {
        contactId: row.contact_id,
        summary: row.summary_text,
        sourceMemoryIds,
        confidenceScore: row.confidence_score,
        noveltyScore: row.novelty_score,
        updatedAt: row.updated_at,
      };
    });
  }

  addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): ScratchpadAddResult {
    const normalizedContent = this.normalizeScratchpadContent(content);
    const id = options.id?.trim() || randomUUID();
    const now = options.now ?? Date.now();

    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM scratchpad_entries`);
    const oldestStmt = this.db.prepare(`
      SELECT id
      FROM scratchpad_entries
      ORDER BY updated_at ASC, created_at ASC
      LIMIT ?
    `);
    const deleteStmt = this.db.prepare(`DELETE FROM scratchpad_entries WHERE id = ?`);
    const insertStmt = this.db.prepare(`
      INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    const evictedIds = this.db.transaction(() => {
      const row = countStmt.get() as { count: number };
      const overflow = Math.max(0, row.count - SCRATCHPAD_MAX_ENTRIES + 1);
      let evicted: string[] = [];

      if (overflow > 0) {
        const rows = oldestStmt.all(overflow) as Array<{ id: string }>;
        evicted = rows.map(entry => entry.id);
        for (const evictedId of evicted) {
          deleteStmt.run(evictedId);
        }
      }

      insertStmt.run(id, normalizedContent, now, now);
      return evicted;
    })();

    const entry = this.getScratchpadEntry(id);
    if (!entry) {
      throw new Error(`Failed to load scratchpad entry after insert: ${id}`);
    }
    this.syncScratchpadMirror();

    return { entry, evictedIds };
  }

  replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): ScratchpadEntry | null {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const normalizedContent = this.normalizeScratchpadContent(content);
    const now = options.now ?? Date.now();

    const result = this.db.prepare(`
      UPDATE scratchpad_entries
      SET content = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizedContent, now, normalizedId);

    if (result.changes === 0) return null;
    this.syncScratchpadMirror();
    return this.getScratchpadEntry(normalizedId) ?? null;
  }

  removeScratchpadEntry(id: string): boolean {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    const result = this.db.prepare(`DELETE FROM scratchpad_entries WHERE id = ?`).run(normalizedId);
    if (result.changes > 0) {
      this.syncScratchpadMirror();
    }
    return result.changes > 0;
  }

  getScratchpadEntry(id: string): ScratchpadEntry | undefined {
    const normalizedId = id.trim();
    if (!normalizedId) return undefined;
    const row = this.db.prepare(`
      SELECT id, content, created_at, updated_at
      FROM scratchpad_entries
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as ScratchpadRow | undefined;
    return row ? mapScratchpadRow(row) : undefined;
  }

  listScratchpadEntries(limit: number = SCRATCHPAD_MAX_ENTRIES): ScratchpadEntry[] {
    const normalizedLimit = this.normalizeScratchpadLimit(limit);
    const rows = this.db.prepare(`
      SELECT id, content, created_at, updated_at
      FROM scratchpad_entries
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(normalizedLimit) as ScratchpadRow[];
    return rows.map(mapScratchpadRow);
  }

  private normalizeScratchpadContent(content: string): string {
    const normalized = content.trim();
    if (!normalized) {
      throw new Error('Scratchpad content is required');
    }
    if (normalized.length > SCRATCHPAD_MAX_CONTENT_CHARS) {
      throw new Error(
        `Scratchpad content exceeds ${SCRATCHPAD_MAX_CONTENT_CHARS} characters`,
      );
    }
    return normalized;
  }

  private normalizeScratchpadLimit(limit: number): number {
    if (!Number.isFinite(limit)) return SCRATCHPAD_MAX_ENTRIES;
    return Math.max(1, Math.min(SCRATCHPAD_MAX_ENTRIES, Math.floor(limit)));
  }

  private normalizeListLimit(
    limit: number,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(limit)));
  }

  private normalizeListOffset(offset: number): number {
    if (!Number.isFinite(offset)) return 0;
    return Math.max(0, Math.floor(offset));
  }

  private syncScratchpadMirror(): void {
    if (!this.scratchpadMirrorPath) return;
    try {
      const entries = this.listScratchpadEntries(SCRATCHPAD_MAX_ENTRIES);
      writeJsonAtomic(this.scratchpadMirrorPath, {
        updatedAt: new Date().toISOString(),
        count: entries.length,
        entries,
      });
    } catch (error) {
      log.warn('Failed to sync scratchpad mirror', {
        path: this.scratchpadMirrorPath,
        error: String(error),
      });
    }
  }
}
