import type Database from 'better-sqlite3';
import type { MemoryLink } from '../memory-store-port.js';
import { mapMemoryLinkRow } from './mappers.js';
import type { MemoryLinkRow } from './types.js';

export function linkMemories(
  db: Database.Database,
  id1: string,
  id2: string,
  linkType: string = 'related',
): MemoryLink | null {
  const normalizedId1 = id1.trim();
  const normalizedId2 = id2.trim();
  const normalizedType = linkType.trim() || 'related';
  if (!normalizedId1 || !normalizedId2) return null;
  if (normalizedId1 === normalizedId2) return null;

  const [first, second] = normalizedId1 < normalizedId2
    ? [normalizedId1, normalizedId2]
    : [normalizedId2, normalizedId1];

  const now = Date.now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO memory_links (id1, id2, link_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(first, second, normalizedType, now);

  if (result.changes === 0) return null;
  return { id1: first, id2: second, linkType: normalizedType, createdAt: now };
}

export function unlinkMemories(
  db: Database.Database,
  id1: string,
  id2: string,
): boolean {
  const normalizedId1 = id1.trim();
  const normalizedId2 = id2.trim();
  if (!normalizedId1 || !normalizedId2) return false;

  const [first, second] = normalizedId1 < normalizedId2
    ? [normalizedId1, normalizedId2]
    : [normalizedId2, normalizedId1];

  const result = db.prepare(`
    DELETE FROM memory_links WHERE id1 = ? AND id2 = ?
  `).run(first, second);
  return result.changes > 0;
}

export function getLinkedMemories(db: Database.Database, id: string): MemoryLink[] {
  const normalizedId = id.trim();
  if (!normalizedId) return [];

  const rows = db.prepare(`
    SELECT id1, id2, link_type, created_at
    FROM memory_links
    WHERE id1 = ? OR id2 = ?
    ORDER BY created_at DESC
  `).all(normalizedId, normalizedId) as MemoryLinkRow[];

  return rows.map(mapMemoryLinkRow);
}
