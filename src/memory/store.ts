import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeJsonAtomic } from '../utils/fs.js';
import { createComponentLogger } from '../logger.js';
import type { DatabaseAdapter } from '../persistence/db-adapter.js';
import type { MemoryJournal } from './journal.js';
import {
  normalizeMemoryScopeQuery,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  normalizeConsentFlags,
  normalizeFormationVAD,
  type MemoryScopeQuery,
  type MemoryScopeRef,
  type PurrMemory,
  type SensitivityLevel,
  type ConsentFlags,
  type MemoryFormationVAD,
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

export interface ContactProfileArtifact {
  contactId: string;
  summary: string;
  sourceMemoryIds: string[];
  confidenceScore: number;
  noveltyScore: number;
  updatedAt: number;
}

export interface MemoryDeleteVersion {
  deleteId: string;
  memoryId: string;
  snapshot: PurrMemory;
  deletedAt: number;
  deletedBy: string;
  deleteReason?: string;
  restoredAt?: number;
  restoredBy?: string;
}

export interface MemoryLink {
  id1: string;
  id2: string;
  linkType: string;
  createdAt: number;
}

export interface MemoryAbstractionLink {
  id: string;
  sourceMemoryId: string;
  abstractedMemoryId: string;
  externalRef: string;
  createdAt: number;
  createdBy?: string;
  reason?: string;
}

export interface ScratchpadEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadAddResult {
  entry: ScratchpadEntry;
  evictedIds: string[];
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

function mapMemoryRow(row: MemoryRow): PurrMemory {
  let tags: string[] = [];
  let scopeTags: string[] = [];
  let provenanceRefs: string[] = [];
  let consentFlags: ConsentFlags = {};
  let formationVAD: MemoryFormationVAD | undefined;
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
    params.push(`%"${tag}"%`);
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
  private adapter: DatabaseAdapter;
  private embeddingDims: number;
  private scratchpadMirrorPath: string | null;
  private journal: MemoryJournal | null;
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    adapter: DatabaseAdapter,
    embeddingDims: number = 1024,
    options: MemoryStoreOptions = {},
  ) {
    this.adapter = adapter;
    this.embeddingDims = embeddingDims;
    this.scratchpadMirrorPath = this.resolveScratchpadMirrorPath(options);
    this.journal = options.journal ?? null;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = (async () => {
      await this.adapter.initialize();
      await this.createTables();
      await this.migrateSchema();
      this.initialized = true;
      await this.syncScratchpadMirror();
    })();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
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

  private async createTables(): Promise<void> {
    await this.adapter.exec(`
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

  private async migrateSchema(): Promise<void> {
    // Add sensitivity column (default 'personal' — safe default for existing data)
    try {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'personal'`);
    } catch { /* column already exists */ }

    // Add consent_flags column (default '{}' — no restrictions)
    try {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN consent_flags TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }

    // Add contact_id column for canonical contact linking
    if (!await this.adapter.hasColumn('l2_memories', 'contact_id')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN contact_id TEXT`);
    }

    if (await this.adapter.hasColumn('l2_memories', 'contact_id')) {
      await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_contact ON l2_memories(contact_id)`);
    }

    if (!await this.adapter.hasColumn('l2_memories', 'provenance_refs')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN provenance_refs TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!await this.adapter.hasColumn('l2_memories', 'scope_ref_kind')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_kind TEXT`);
    }
    if (!await this.adapter.hasColumn('l2_memories', 'scope_ref_id')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_id TEXT`);
    }
    if (!await this.adapter.hasColumn('l2_memories', 'scope_ref_label')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_label TEXT`);
    }
    if (!await this.adapter.hasColumn('l2_memories', 'scope_tags')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN scope_tags TEXT NOT NULL DEFAULT '[]'`);
    }
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_scope_ref ON l2_memories(scope_ref_kind, scope_ref_id)`);

    if (!await this.adapter.hasColumn('l2_memories', 'formation_vad')) {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN formation_vad TEXT`);
    }

    // Add soft-delete columns for reversible destructive operations
    try {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN deleted_at INTEGER`);
    } catch { /* column already exists */ }
    try {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN deleted_by TEXT`);
    } catch { /* column already exists */ }
    try {
      await this.adapter.exec(`ALTER TABLE l2_memories ADD COLUMN delete_reason TEXT`);
    } catch { /* column already exists */ }
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_deleted_at ON l2_memories(deleted_at)`);

    // Create delete-version snapshots table if missing (idempotent).
    await this.adapter.exec(`
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
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_memory ON l2_memory_delete_versions(memory_id)`);
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_active ON l2_memory_delete_versions(restored_at, deleted_at)`);

    await this.adapter.exec(`
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
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_abstraction_source ON l2_memory_abstraction_links(source_memory_id)`);
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_l2_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id)`);

    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at ON scratchpad_entries(updated_at DESC, created_at DESC)`);

    // Create memory_links table for linking related memories
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id1 TEXT NOT NULL,
        id2 TEXT NOT NULL,
        link_type TEXT NOT NULL DEFAULT 'related',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id1, id2)
      );
    `);
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1)`);
    await this.adapter.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2)`);
  }

  // ── L2 Memories ──

  async insertMemory(memory: PurrMemory, embedding: Float32Array): Promise<void> {
    await this.ensureInitialized();
    await this.adapter.run(
      `INSERT INTO l2_memories (id, text, type, importance, confidence, emotional_valence, formation_vad,
        salience, source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,
        scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs, sensitivity,
        consent_flags, contact_id, deleted_at, deleted_by, delete_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.text,
        memory.type,
        memory.importance,
        memory.confidence,
        memory.emotionalValence,
        memory.formationVAD ? JSON.stringify(memory.formationVAD) : null,
        memory.salience,
        memory.sourceRef,
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
      ],
    );

    await this.adapter.vectorUpsert(
      'l2_memories',
      'memory_id',
      memory.id,
      'embedding',
      embedding,
    );

    this.journal?.onInsert(memory);
  }

  async runInTransaction<T>(handler: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    return this.adapter.transaction(async (_tx) => {
      return handler();
    });
  }

  async searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    await this.ensureInitialized();
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const scopeSql = buildScopeQuerySql(normalizedScopeQuery);

    const filterClauses: string[] = [
      '$MAIN_TABLE.superseded_by IS NULL',
      '$MAIN_TABLE.deleted_at IS NULL',
    ];
    if (scopeSql.clause) {
      filterClauses.push(
        scopeSql.clause
          .replace(/^AND\s+/i, '')
          .replace(/\bscope_ref_kind\b/g, '$MAIN_TABLE.scope_ref_kind')
          .replace(/\bscope_ref_id\b/g, '$MAIN_TABLE.scope_ref_id')
          .replace(/\bscope_tags\b/g, '$MAIN_TABLE.scope_tags'),
      );
    }
    const filterParams: unknown[] = [...scopeSql.params];

    const results = await this.adapter.vectorSearch({
      table: 'l2_memories',
      column: 'embedding',
      queryVector: embedding,
      limit: limit * 2,
      joinClause: 'JOIN l2_memories m ON m.id = v.memory_id',
      filterClauses,
      filterParams,
      selectColumns: 'm.*',
    });

    return results
      .map(({ row, distance }) => {
        // vec0 returns L2 distance; for L2-normalized unit vectors,
        // cosine similarity = 1 - L2_dist² / 2
        const similarity = 1 - (distance * distance) / 2;
        if (similarity < threshold) return null;
        return { ...mapMemoryRow(row as MemoryRow), similarity };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .slice(0, limit);
  }

  async searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    await this.ensureInitialized();
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

    const rows = await this.adapter.query<MemoryRow>(
      `SELECT *
      FROM l2_memories
      WHERE superseded_by IS NULL
        AND deleted_at IS NULL
        AND (${clauses.join(' OR ')})
        ${scopeSql.clause}
      ORDER BY extracted_at DESC, id DESC
      LIMIT ?`,
      [...params, ...scopeSql.params, scanLimit],
    );

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

  async updateMemory(id: string, updates: Partial<Pick<PurrMemory, 'salience' | 'lastAccessed' | 'accessCount' | 'supersededBy' | 'sensitivity' | 'consentFlags' | 'tags' | 'scopeRef' | 'scopeTags' | 'provenanceRefs' | 'contactId' | 'deletedAt' | 'deletedBy' | 'deleteReason'>>): Promise<void> {
    await this.ensureInitialized();
    const setClauses: string[] = [];
    const values: unknown[] = [];

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

    values.push(id);
    await this.adapter.run(
      `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ?`,
      values,
    );
  }

  async getAllActiveMemories(limit: number = 10_000): Promise<PurrMemory[]> {
    await this.ensureInitialized();
    const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
    const rows = await this.adapter.query<MemoryRow>(
      `SELECT * FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL
      LIMIT ?`,
      [safeLimit],
    );
    return rows.map(mapMemoryRow);
  }

  async listActiveMemories(
    options: {
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PurrMemory[]> {
    await this.ensureInitialized();
    const limit = this.normalizeListLimit(options.limit ?? 50, 50, 1, 500);
    const offset = this.normalizeListOffset(options.offset ?? 0);
    const rows = await this.adapter.query<MemoryRow>(
      `SELECT *
      FROM l2_memories
      WHERE superseded_by IS NULL AND deleted_at IS NULL
      ORDER BY extracted_at DESC, id DESC
      LIMIT ?
      OFFSET ?`,
      [limit, offset],
    );
    return rows.map(mapMemoryRow);
  }

  async countActiveMemories(): Promise<number> {
    await this.ensureInitialized();
    const row = await this.adapter.queryOne<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM l2_memories
      WHERE superseded_by IS NULL AND deleted_at IS NULL
    `);
    return row?.count ?? 0;
  }

  async getById(id: string): Promise<PurrMemory | undefined> {
    await this.ensureInitialized();
    const row = await this.adapter.queryOne<MemoryRow>(
      'SELECT * FROM l2_memories WHERE id = ?',
      [id],
    );
    return row ? mapMemoryRow(row) : undefined;
  }

  async softDeleteMemory(
    id: string,
    options: {
      deletedBy?: string;
      reason?: string;
      deletedAt?: number;
      deleteId?: string;
    } = {},
  ): Promise<MemoryDeleteVersion | null> {
    await this.ensureInitialized();
    const deleteId = options.deleteId ?? randomUUID();
    const deletedAt = options.deletedAt ?? Date.now();
    const deletedBy = options.deletedBy?.trim() || 'agent';
    const reason = options.reason?.trim();

    return this.adapter.transaction(async (tx) => {
      const row = await tx.queryOne<MemoryRow>(`
        SELECT * FROM l2_memories
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1
      `, [id]);

      if (!row) return null;

      const snapshot = mapMemoryRow(row);
      await tx.run(
        `INSERT INTO l2_memory_delete_versions (
          delete_id,
          memory_id,
          snapshot_json,
          deleted_at,
          deleted_by,
          delete_reason
        )
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          deleteId,
          id,
          JSON.stringify(snapshot),
          deletedAt,
          deletedBy,
          reason ?? null,
        ],
      );
      const result = await tx.run(
        `UPDATE l2_memories
        SET deleted_at = ?, deleted_by = ?, delete_reason = ?
        WHERE id = ? AND deleted_at IS NULL`,
        [
          deletedAt,
          deletedBy,
          reason ?? null,
          id,
        ],
      );
      if (result.changes === 0) return null;

      const deleteVersion = {
        deleteId,
        memoryId: id,
        snapshot,
        deletedAt,
        deletedBy,
        deleteReason: reason,
      } satisfies MemoryDeleteVersion;

      this.journal?.onSoftDelete(deleteVersion);
      return deleteVersion;
    });
  }

  async undoSoftDelete(
    deleteId: string,
    options: {
      restoredBy?: string;
      restoredAt?: number;
    } = {},
  ): Promise<MemoryDeleteVersion | null> {
    await this.ensureInitialized();
    const restoredAt = options.restoredAt ?? Date.now();
    const restoredBy = options.restoredBy?.trim() || 'agent';

    return this.adapter.transaction(async (tx) => {
      const versionRow = await tx.queryOne<MemoryDeleteVersionRow>(`
        SELECT * FROM l2_memory_delete_versions
        WHERE delete_id = ? AND restored_at IS NULL
        LIMIT 1
      `, [deleteId]);

      if (!versionRow) return null;

      await tx.run(
        `UPDATE l2_memories
        SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
        WHERE id = ?`,
        [versionRow.memory_id],
      );
      const versionResult = await tx.run(
        `UPDATE l2_memory_delete_versions
        SET restored_at = ?, restored_by = ?
        WHERE delete_id = ? AND restored_at IS NULL`,
        [restoredAt, restoredBy, deleteId],
      );
      if (versionResult.changes === 0) return null;

      const restoreVersion = {
        ...mapMemoryDeleteVersionRow(versionRow),
        restoredAt,
        restoredBy,
      } satisfies MemoryDeleteVersion;

      this.journal?.onRestore(restoreVersion);
      return restoreVersion;
    });
  }

  async getDeleteVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined> {
    await this.ensureInitialized();
    const row = await this.adapter.queryOne<MemoryDeleteVersionRow>(`
      SELECT *
      FROM l2_memory_delete_versions
      WHERE delete_id = ?
      LIMIT 1
    `, [deleteId]);
    if (!row) return undefined;
    return mapMemoryDeleteVersionRow(row);
  }

  async recordAbstractionLink(
    input: {
      sourceMemoryId: string;
      abstractedMemoryId: string;
      externalRef: string;
      createdAt?: number;
      createdBy?: string;
      reason?: string;
      linkId?: string;
    },
  ): Promise<MemoryAbstractionLink> {
    await this.ensureInitialized();
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

    await this.adapter.run(
      `INSERT INTO l2_memory_abstraction_links (
        id,
        source_memory_id,
        abstracted_memory_id,
        external_ref,
        created_at,
        created_by,
        reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sourceMemoryId,
        abstractedMemoryId,
        externalRef,
        createdAt,
        createdBy ?? null,
        reason ?? null,
      ],
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

  async getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]> {
    await this.ensureInitialized();
    const normalized = sourceMemoryId.trim();
    if (!normalized) return [];
    const rows = await this.adapter.query<MemoryAbstractionLinkRow>(
      `SELECT *
      FROM l2_memory_abstraction_links
      WHERE source_memory_id = ?
      ORDER BY created_at DESC`,
      [normalized],
    );
    return rows.map(mapMemoryAbstractionLinkRow);
  }

  async getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]> {
    await this.ensureInitialized();
    const normalized = abstractedMemoryId.trim();
    if (!normalized) return [];
    const rows = await this.adapter.query<MemoryAbstractionLinkRow>(
      `SELECT *
      FROM l2_memory_abstraction_links
      WHERE abstracted_memory_id = ?
      ORDER BY created_at DESC`,
      [normalized],
    );
    return rows.map(mapMemoryAbstractionLinkRow);
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; avgSalience: number }> {
    await this.ensureInitialized();
    const rows = await this.adapter.query<{ type: string; count: number; avg_sal: number }>(`
      SELECT type, COUNT(*) as count, AVG(salience) as avg_sal
      FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL GROUP BY type
    `);

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

  async getMemoriesByChannel(channelId: string, limit: number): Promise<PurrMemory[]> {
    await this.ensureInitialized();
    const rows = await this.adapter.query<MemoryRow>(
      `SELECT * FROM l2_memories
      WHERE source_ref LIKE ? AND superseded_by IS NULL AND deleted_at IS NULL
      ORDER BY extracted_at DESC
      LIMIT ?`,
      [`${channelId}:%`, limit],
    );
    return rows.map(mapMemoryRow);
  }

  async getMemoriesByContact(contactId: string, limit: number): Promise<PurrMemory[]> {
    await this.ensureInitialized();
    const rows = await this.adapter.query<MemoryRow>(
      `SELECT * FROM l2_memories
      WHERE contact_id = ? AND superseded_by IS NULL AND deleted_at IS NULL
      ORDER BY salience DESC, extracted_at DESC
      LIMIT ?`,
      [contactId, limit],
    );
    return rows.map(mapMemoryRow);
  }

  // ── Memory Links ──

  async linkMemories(id1: string, id2: string, linkType: string = 'related'): Promise<MemoryLink | null> {
    await this.ensureInitialized();
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
    const result = await this.adapter.run(
      `INSERT OR IGNORE INTO memory_links (id1, id2, link_type, created_at)
      VALUES (?, ?, ?, ?)`,
      [first, second, normalizedType, now],
    );

    if (result.changes === 0) return null;
    return { id1: first, id2: second, linkType: normalizedType, createdAt: now };
  }

  async unlinkMemories(id1: string, id2: string): Promise<boolean> {
    await this.ensureInitialized();
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) return false;

    // Try both orderings in case caller doesn't know canonical order
    const [first, second] = normalizedId1 < normalizedId2
      ? [normalizedId1, normalizedId2]
      : [normalizedId2, normalizedId1];

    const result = await this.adapter.run(
      `DELETE FROM memory_links WHERE id1 = ? AND id2 = ?`,
      [first, second],
    );
    return result.changes > 0;
  }

  async getLinkedMemories(id: string): Promise<MemoryLink[]> {
    await this.ensureInitialized();
    const normalizedId = id.trim();
    if (!normalizedId) return [];

    const rows = await this.adapter.query<MemoryLinkRow>(
      `SELECT id1, id2, link_type, created_at
      FROM memory_links
      WHERE id1 = ? OR id2 = ?
      ORDER BY created_at DESC`,
      [normalizedId, normalizedId],
    );

    return rows.map(mapMemoryLinkRow);
  }

  // ── Bulk Operations ──

  async bulkDelete(ids: string[]): Promise<number> {
    await this.ensureInitialized();
    if (!ids.length) return 0;
    const now = Date.now();
    const deletedBy = 'admin:bulk';

    return this.adapter.transaction(async (tx) => {
      let count = 0;
      for (const id of ids) {
        const normalizedId = id.trim();
        if (!normalizedId) continue;

        const row = await tx.queryOne<MemoryRow>(`
          SELECT * FROM l2_memories
          WHERE id = ? AND deleted_at IS NULL
          LIMIT 1
        `, [normalizedId]);

        if (!row) continue;

        const snapshot = mapMemoryRow(row);
        const deleteId = randomUUID();
        await tx.run(
          `INSERT INTO l2_memory_delete_versions (
            delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason
          )
          VALUES (?, ?, ?, ?, ?, ?)`,
          [
            deleteId,
            normalizedId,
            JSON.stringify(snapshot),
            now,
            deletedBy,
            'bulk delete',
          ],
        );
        const result = await tx.run(
          `UPDATE l2_memories
          SET deleted_at = ?, deleted_by = ?, delete_reason = ?
          WHERE id = ? AND deleted_at IS NULL`,
          [now, deletedBy, 'bulk delete', normalizedId],
        );
        if (result.changes > 0) count++;
      }
      return count;
    });
  }

  async bulkUpdate(
    ids: string[],
    fields: Partial<Pick<PurrMemory, 'type' | 'sensitivity'>>,
  ): Promise<number> {
    await this.ensureInitialized();
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

    return this.adapter.transaction(async (tx) => {
      let count = 0;
      for (const id of ids) {
        const normalizedId = id.trim();
        if (!normalizedId) continue;
        const result = await tx.run(
          `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
          [...setValues, normalizedId],
        );
        if (result.changes > 0) count++;
      }
      return count;
    });
  }

  async upsertContactProfile(profile: ContactProfileArtifact): Promise<void> {
    await this.ensureInitialized();
    await this.adapter.run(
      `INSERT INTO contact_profiles (
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
        updated_at = excluded.updated_at`,
      [
        profile.contactId,
        profile.summary,
        JSON.stringify(profile.sourceMemoryIds),
        profile.confidenceScore,
        profile.noveltyScore,
        profile.updatedAt,
      ],
    );
  }

  async getContactProfile(contactId: string): Promise<ContactProfileArtifact | undefined> {
    await this.ensureInitialized();
    const row = await this.adapter.queryOne<ContactProfileRow>(`
      SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      FROM contact_profiles
      WHERE contact_id = ?
      LIMIT 1
    `, [contactId]);
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

  async listContactProfiles(): Promise<ContactProfileArtifact[]> {
    await this.ensureInitialized();
    const rows = await this.adapter.query<ContactProfileRow>(`
      SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      FROM contact_profiles
      ORDER BY updated_at DESC
    `);

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

  async addScratchpadEntry(
    content: string,
    options: {
      id?: string;
      now?: number;
    } = {},
  ): Promise<ScratchpadAddResult> {
    await this.ensureInitialized();
    const normalizedContent = this.normalizeScratchpadContent(content);
    const id = options.id?.trim() || randomUUID();
    const now = options.now ?? Date.now();

    return this.adapter.transaction(async (tx) => {
      const countRow = await tx.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM scratchpad_entries`);
      const rowCount = countRow?.count ?? 0;
      const overflow = Math.max(0, rowCount - SCRATCHPAD_MAX_ENTRIES + 1);
      let evicted: string[] = [];

      if (overflow > 0) {
        const rows = await tx.query<{ id: string }>(
          `SELECT id FROM scratchpad_entries ORDER BY updated_at ASC, created_at ASC LIMIT ?`,
          [overflow],
        );
        evicted = rows.map(entry => entry.id);
        for (const evictedId of evicted) {
          await tx.run(`DELETE FROM scratchpad_entries WHERE id = ?`, [evictedId]);
        }
      }

      await tx.run(
        `INSERT INTO scratchpad_entries (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        [id, normalizedContent, now, now],
      );

      const entry = await tx.queryOne<ScratchpadRow>(
        `SELECT id, content, created_at, updated_at FROM scratchpad_entries WHERE id = ?`,
        [id],
      );

      if (!entry) {
        throw new Error(`Failed to load scratchpad entry after insert: ${id}`);
      }

      await this.syncScratchpadMirror();

      return { entry: mapScratchpadRow(entry), evictedIds: evicted };
    });
  }

  async replaceScratchpadEntry(
    id: string,
    content: string,
    options: {
      now?: number;
    } = {},
  ): Promise<ScratchpadEntry | null> {
    await this.ensureInitialized();
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const normalizedContent = this.normalizeScratchpadContent(content);
    const now = options.now ?? Date.now();

    const result = await this.adapter.run(
      `UPDATE scratchpad_entries SET content = ?, updated_at = ? WHERE id = ?`,
      [normalizedContent, now, normalizedId],
    );

    if (result.changes === 0) return null;
    await this.syncScratchpadMirror();
    const entry = await this.getScratchpadEntry(normalizedId);
    return entry ?? null;
  }

  async removeScratchpadEntry(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    const result = await this.adapter.run(
      `DELETE FROM scratchpad_entries WHERE id = ?`,
      [normalizedId],
    );
    if (result.changes > 0) {
      await this.syncScratchpadMirror();
    }
    return result.changes > 0;
  }

  async getScratchpadEntry(id: string): Promise<ScratchpadEntry | undefined> {
    await this.ensureInitialized();
    const normalizedId = id.trim();
    if (!normalizedId) return undefined;
    const row = await this.adapter.queryOne<ScratchpadRow>(
      `SELECT id, content, created_at, updated_at FROM scratchpad_entries WHERE id = ? LIMIT 1`,
      [normalizedId],
    );
    return row ? mapScratchpadRow(row) : undefined;
  }

  async listScratchpadEntries(limit: number = SCRATCHPAD_MAX_ENTRIES): Promise<ScratchpadEntry[]> {
    await this.ensureInitialized();
    const normalizedLimit = this.normalizeScratchpadLimit(limit);
    const rows = await this.adapter.query<ScratchpadRow>(
      `SELECT id, content, created_at, updated_at FROM scratchpad_entries ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
      [normalizedLimit],
    );
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

  private async syncScratchpadMirror(): Promise<void> {
    if (!this.scratchpadMirrorPath) return;
    try {
      const entries = await this.listScratchpadEntries(SCRATCHPAD_MAX_ENTRIES);
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
