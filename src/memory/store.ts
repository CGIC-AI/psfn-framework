import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { PurrMemory, SensitivityLevel, ConsentFlags } from './types.js';

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
  sensitivity: string | null;
  consent_flags: string | null;
  contact_id: string | null;
}

interface ContactProfileRow {
  contact_id: string;
  summary_text: string;
  source_memory_ids: string;
  confidence_score: number;
  novelty_score: number;
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

function mapMemoryRow(row: MemoryRow): PurrMemory {
  let tags: string[] = [];
  let consentFlags: ConsentFlags = {};
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  try {
    consentFlags = JSON.parse(row.consent_flags ?? '{}') as ConsentFlags;
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
    sensitivity: (row.sensitivity ?? 'personal') as SensitivityLevel,
    consentFlags,
    contactId: row.contact_id ?? undefined,
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
        contact_id TEXT
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

      CREATE VIRTUAL TABLE IF NOT EXISTS l2_memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${this.embeddingDims}]
      );
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
  }

  // ── L2 Memories ──

  insertMemory(memory: PurrMemory, embedding: Float32Array): void {
    const insertMem = this.db.prepare(`
      INSERT INTO l2_memories (id, text, type, importance, confidence, emotional_valence,
        salience, source_ref, extracted_at, last_accessed, access_count, superseded_by, tags,
        sensitivity, consent_flags, contact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        memory.sensitivity ?? 'personal',
        JSON.stringify(memory.consentFlags ?? {}),
        memory.contactId ?? null,
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

  updateMemory(id: string, updates: Partial<Pick<PurrMemory, 'salience' | 'lastAccessed' | 'accessCount' | 'supersededBy' | 'sensitivity' | 'tags' | 'contactId'>>): void {
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
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.contactId !== undefined) {
      setClauses.push('contact_id = ?');
      values.push(updates.contactId);
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
      SELECT * FROM l2_memories WHERE superseded_by IS NULL
    `);
    const rows = stmt.all() as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  getById(id: string): PurrMemory | undefined {
    const stmt = this.db.prepare('SELECT * FROM l2_memories WHERE id = ?');
    const row = stmt.get(id) as MemoryRow | undefined;
    return row ? mapMemoryRow(row) : undefined;
  }

  getStats(): { total: number; byType: Record<string, number>; avgSalience: number } {
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) as count, AVG(salience) as avg_sal
      FROM l2_memories WHERE superseded_by IS NULL GROUP BY type
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
      WHERE source_ref LIKE ? AND superseded_by IS NULL
      ORDER BY extracted_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(`${channelId}:%`, limit) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  getMemoriesByContact(contactId: string, limit: number): PurrMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM l2_memories
      WHERE contact_id = ? AND superseded_by IS NULL
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
}
