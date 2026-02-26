import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as sqliteVec from 'sqlite-vec';
import {
  normalizeConsentFlags,
  type PurrMemory,
  type SensitivityLevel,
  type ConsentFlags,
} from './types.js';

const SCRATCHPAD_MAX_ENTRIES = 64;
const SCRATCHPAD_MAX_CONTENT_CHARS = 1_000;

interface MemoryRow {
  id: string;
  text: string;
  type: PurrMemory['type'];
  importance: number;
  confidence: number;
  emotional_valence: number;
  salience: number;
  source_ref: string;
  extracted_at: number;
  last_accessed: number;
  access_count: number;
  superseded_by: string | null;
  tags: string;
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
  let provenanceRefs: string[] = [];
  let consentFlags: ConsentFlags = {};
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
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

  return {
    id: row.id,
    text: row.text,
    type: row.type,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence,
    salience: row.salience,
    sourceRef: row.source_ref,
    extractedAt: row.extracted_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    supersededBy: row.superseded_by ?? undefined,
    tags,
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

export class MemoryStore {
  private db: Database.Database;
  private embeddingDims: number;

  constructor(db: Database.Database, embeddingDims: number = 1024) {
    this.db = db;
    this.embeddingDims = embeddingDims;
    this.loadExtensions();
    this.createTables();
    this.migrateSchema();
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
        salience REAL NOT NULL DEFAULT 0.5,
        source_ref TEXT NOT NULL,
        extracted_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
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

  private hasColumn(tableName: string, columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    return rows.some(row => row.name === columnName);
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
    if (!this.hasColumn('l2_memories', 'contact_id')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN contact_id TEXT`);
    }

    if (this.hasColumn('l2_memories', 'contact_id')) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_contact ON l2_memories(contact_id)`);
    }

    if (!this.hasColumn('l2_memories', 'provenance_refs')) {
      this.db.exec(`ALTER TABLE l2_memories ADD COLUMN provenance_refs TEXT NOT NULL DEFAULT '[]'`);
    }

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
  }

  // ── L2 Memories ──

  insertMemory(memory: PurrMemory, embedding: Float32Array): void {
    const insertMem = this.db.prepare(`
      INSERT INTO l2_memories (id, text, type, importance, confidence, emotional_valence,
        salience, source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,
        provenance_refs, sensitivity, consent_flags, contact_id, deleted_at, deleted_by, delete_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        memory.salience,
        memory.sourceRef,
        memory.extractedAt,
        memory.lastAccessed,
        memory.accessCount,
        memory.supersededBy ?? null,
        JSON.stringify(memory.tags),
        JSON.stringify(memory.provenanceRefs ?? []),
        memory.sensitivity ?? 'personal',
        JSON.stringify(memory.consentFlags ?? {}),
        memory.contactId ?? null,
        memory.deletedAt ?? null,
        memory.deletedBy ?? null,
        memory.deleteReason ?? null,
      );
      insertVec.run(memory.id, Buffer.from(embedding.buffer));
    });

    transaction();
  }

  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
  ): Array<PurrMemory & { similarity: number }> {
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
      ORDER BY v.distance ASC
    `);

    const rows = stmt.all(Buffer.from(embedding.buffer), limit * 2) as Array<MemoryRow & {
      distance: number;
    }>;

    return rows
      .map(row => {
        const similarity = 1 - row.distance;
        if (similarity < threshold) return null;
        return { ...mapMemoryRow(row), similarity };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .slice(0, limit);
  }

  updateMemory(id: string, updates: Partial<Pick<PurrMemory, 'salience' | 'lastAccessed' | 'accessCount' | 'supersededBy' | 'sensitivity' | 'consentFlags' | 'tags' | 'provenanceRefs' | 'contactId' | 'deletedAt' | 'deletedBy' | 'deleteReason'>>): void {
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
    const stmt = this.db.prepare(
      `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ?`,
    );
    stmt.run(...values);
  }

  getAllActiveMemories(): PurrMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL
    `);
    const rows = stmt.all() as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  getById(id: string): PurrMemory | undefined {
    const stmt = this.db.prepare('SELECT * FROM l2_memories WHERE id = ?');
    const row = stmt.get(id) as MemoryRow | undefined;
    return row ? mapMemoryRow(row) : undefined;
  }

  softDeleteMemory(
    id: string,
    options: {
      deletedBy?: string;
      reason?: string;
      deletedAt?: number;
      deleteId?: string;
    } = {},
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

    return transaction();
  }

  undoSoftDelete(
    deleteId: string,
    options: {
      restoredBy?: string;
      restoredAt?: number;
    } = {},
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

    return transaction();
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

  recordAbstractionLink(
    input: {
      sourceMemoryId: string;
      abstractedMemoryId: string;
      externalRef: string;
      createdAt?: number;
      createdBy?: string;
      reason?: string;
      linkId?: string;
    },
  ): MemoryAbstractionLink {
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
    options: {
      id?: string;
      now?: number;
    } = {},
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

    return { entry, evictedIds };
  }

  replaceScratchpadEntry(
    id: string,
    content: string,
    options: {
      now?: number;
    } = {},
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
    return this.getScratchpadEntry(normalizedId) ?? null;
  }

  removeScratchpadEntry(id: string): boolean {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    const result = this.db.prepare(`DELETE FROM scratchpad_entries WHERE id = ?`).run(normalizedId);
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
}
