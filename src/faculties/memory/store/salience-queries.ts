import type Database from 'better-sqlite3';
import type { MemoryListOptions } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { mapMemoryRow } from './mappers.js';
import type { MemoryRow } from './types.js';

function normalizeListLimit(
  limit: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

function normalizeListOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

export function getAllActiveMemories(db: Database.Database, limit: number = 10_000): PurrMemory[] {
  const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
  const stmt = db.prepare(`
    SELECT * FROM l2_memories WHERE superseded_by IS NULL AND deleted_at IS NULL
    LIMIT ?
  `);
  const rows = stmt.all(safeLimit) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function listActiveMemories(
  db: Database.Database,
  options: MemoryListOptions = {},
): PurrMemory[] {
  const limit = normalizeListLimit(options.limit ?? 50, 50, 1, 500);
  const offset = normalizeListOffset(options.offset ?? 0);
  const rows = db.prepare(`
    SELECT *
    FROM l2_memories
    WHERE superseded_by IS NULL AND deleted_at IS NULL
    ORDER BY extracted_at DESC, id DESC
    LIMIT ?
    OFFSET ?
  `).all(limit, offset) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function countActiveMemories(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM l2_memories
    WHERE superseded_by IS NULL AND deleted_at IS NULL
  `).get() as { count: number };
  return row.count;
}

export function getById(db: Database.Database, id: string): PurrMemory | undefined {
  const stmt = db.prepare('SELECT * FROM l2_memories WHERE id = ?');
  const row = stmt.get(id) as MemoryRow | undefined;
  return row ? mapMemoryRow(row) : undefined;
}

export function getStats(db: Database.Database): { total: number; byType: Record<string, number>; avgSalience: number } {
  const rows = db.prepare(`
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

export function getMemoriesByChannel(
  db: Database.Database,
  channelId: string,
  limit: number,
): PurrMemory[] {
  const stmt = db.prepare(`
    SELECT * FROM l2_memories
    WHERE source_ref LIKE ? AND superseded_by IS NULL AND deleted_at IS NULL
    ORDER BY extracted_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(`${channelId}:%`, limit) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function getMemoriesByContact(
  db: Database.Database,
  contactId: string,
  limit: number,
): PurrMemory[] {
  const stmt = db.prepare(`
    SELECT * FROM l2_memories
    WHERE contact_id = ? AND superseded_by IS NULL AND deleted_at IS NULL
    ORDER BY salience DESC, extracted_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(contactId, limit) as MemoryRow[];
  return rows.map(mapMemoryRow);
}
