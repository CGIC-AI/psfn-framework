import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { PurrMemory, MemoryType } from './types.js';

export class MemoryStore {
  private db: Database.Database;
  private embeddingDims: number;

  constructor(db: Database.Database, embeddingDims: number = 1024) {
    this.db = db;
    this.embeddingDims = embeddingDims;
    this.loadExtensions();
    this.createTables();
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
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_l2_type ON l2_memories(type);
      CREATE INDEX IF NOT EXISTS idx_l2_salience ON l2_memories(salience);

      CREATE VIRTUAL TABLE IF NOT EXISTS l2_memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${this.embeddingDims}]
      );
    `);
  }

  // ── L2 Memories ──

  insertMemory(memory: PurrMemory, embedding: Float32Array): void {
    const insertMem = this.db.prepare(`
      INSERT INTO l2_memories (id, text, type, importance, confidence, emotional_valence,
        salience, source_ref, extracted_at, last_accessed, access_count, superseded_by, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const rows = stmt.all(Buffer.from(embedding.buffer), limit * 2) as Array<{
      id: string;
      text: string;
      type: MemoryType;
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
      distance: number;
    }>;

    return rows
      .map(row => {
        const similarity = 1 - row.distance;
        if (similarity < threshold) return null;
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
          tags: JSON.parse(row.tags) as string[],
          similarity,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .slice(0, limit);
  }

  updateMemory(id: string, updates: Partial<Pick<PurrMemory, 'salience' | 'lastAccessed' | 'accessCount' | 'supersededBy'>>): void {
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
    const rows = stmt.all() as Array<{
      id: string;
      text: string;
      type: MemoryType;
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
    }>;

    return rows.map(row => ({
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
      tags: JSON.parse(row.tags) as string[],
    }));
  }

  getById(id: string): PurrMemory | undefined {
    const stmt = this.db.prepare('SELECT * FROM l2_memories WHERE id = ?');
    const row = stmt.get(id) as {
      id: string;
      text: string;
      type: MemoryType;
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
    } | undefined;
    if (!row) return undefined;
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
      tags: JSON.parse(row.tags) as string[],
    };
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
    const rows = stmt.all(`${channelId}:%`, limit) as Array<{
      id: string;
      text: string;
      type: MemoryType;
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
    }>;

    return rows.map(row => ({
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
      tags: JSON.parse(row.tags) as string[],
    }));
  }
}
