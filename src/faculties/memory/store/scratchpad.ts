import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import type {
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
} from '../memory-store-port.js';
import { mapScratchpadRow } from './mappers.js';
import type { MemoryStoreOptions, ScratchpadRow } from './types.js';

const SCRATCHPAD_MAX_ENTRIES = 64;
const SCRATCHPAD_MAX_CONTENT_CHARS = 4_000;
const log = createComponentLogger('MemoryStore');

export function resolveScratchpadMirrorPath(options: MemoryStoreOptions): string | null {
  if (typeof options.scratchpadMirrorPath === 'string' && options.scratchpadMirrorPath.trim().length > 0) {
    return options.scratchpadMirrorPath.trim();
  }
  if (typeof options.notesDir === 'string' && options.notesDir.trim().length > 0) {
    return join(options.notesDir.trim(), 'scratchpad.json');
  }
  return null;
}

function normalizeScratchpadContent(content: string): string {
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

function normalizeScratchpadLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SCRATCHPAD_MAX_ENTRIES;
  return Math.max(1, Math.min(SCRATCHPAD_MAX_ENTRIES, Math.floor(limit)));
}

export function addScratchpadEntry(
  db: Database.Database,
  scratchpadMirrorPath: string | null,
  content: string,
  options: ScratchpadEntryCreateOptions = {},
): ScratchpadAddResult {
  const normalizedContent = normalizeScratchpadContent(content);
  const id = options.id?.trim() || randomUUID();
  const now = options.now ?? Date.now();

  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM scratchpad_entries`);
  const oldestStmt = db.prepare(`
    SELECT id
    FROM scratchpad_entries
    ORDER BY updated_at ASC, created_at ASC
    LIMIT ?
  `);
  const deleteStmt = db.prepare(`DELETE FROM scratchpad_entries WHERE id = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const evictedIds = db.transaction(() => {
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

  const entry = getScratchpadEntry(db, id);
  if (!entry) {
    throw new Error(`Failed to load scratchpad entry after insert: ${id}`);
  }
  syncScratchpadMirror(db, scratchpadMirrorPath);

  return { entry, evictedIds };
}

export function replaceScratchpadEntry(
  db: Database.Database,
  scratchpadMirrorPath: string | null,
  id: string,
  content: string,
  options: ScratchpadEntryReplaceOptions = {},
): ScratchpadEntry | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const normalizedContent = normalizeScratchpadContent(content);
  const now = options.now ?? Date.now();

  const result = db.prepare(`
    UPDATE scratchpad_entries
    SET content = ?, updated_at = ?
    WHERE id = ?
  `).run(normalizedContent, now, normalizedId);

  if (result.changes === 0) return null;
  syncScratchpadMirror(db, scratchpadMirrorPath);
  return getScratchpadEntry(db, normalizedId) ?? null;
}

export function appendScratchpadEntry(
  db: Database.Database,
  scratchpadMirrorPath: string | null,
  id: string,
  content: string,
  options: {
    now?: number;
  } = {},
): ScratchpadEntry | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const normalizedAppendix = content.trim();
  if (!normalizedAppendix) {
    throw new Error('Scratchpad content is required');
  }

  const existing = getScratchpadEntry(db, normalizedId);
  if (!existing) return null;

  const separator = existing.content.length > 0 ? '\n' : '';
  const nextContent = normalizeScratchpadContent(`${existing.content}${separator}${normalizedAppendix}`);
  const now = options.now ?? Date.now();

  const result = db.prepare(`
    UPDATE scratchpad_entries
    SET content = ?, updated_at = ?
    WHERE id = ?
  `).run(nextContent, now, normalizedId);

  if (result.changes === 0) return null;
  syncScratchpadMirror(db, scratchpadMirrorPath);
  return getScratchpadEntry(db, normalizedId) ?? null;
}

export function removeScratchpadEntry(
  db: Database.Database,
  scratchpadMirrorPath: string | null,
  id: string,
): boolean {
  const normalizedId = id.trim();
  if (!normalizedId) return false;
  const result = db.prepare(`DELETE FROM scratchpad_entries WHERE id = ?`).run(normalizedId);
  if (result.changes > 0) {
    syncScratchpadMirror(db, scratchpadMirrorPath);
  }
  return result.changes > 0;
}

export function getScratchpadEntry(
  db: Database.Database,
  id: string,
): ScratchpadEntry | undefined {
  const normalizedId = id.trim();
  if (!normalizedId) return undefined;
  const row = db.prepare(`
    SELECT id, content, created_at, updated_at
    FROM scratchpad_entries
    WHERE id = ?
    LIMIT 1
  `).get(normalizedId) as ScratchpadRow | undefined;
  return row ? mapScratchpadRow(row) : undefined;
}

export function listScratchpadEntries(
  db: Database.Database,
  limit: number = SCRATCHPAD_MAX_ENTRIES,
): ScratchpadEntry[] {
  const normalizedLimit = normalizeScratchpadLimit(limit);
  const rows = db.prepare(`
    SELECT id, content, created_at, updated_at
    FROM scratchpad_entries
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(normalizedLimit) as ScratchpadRow[];
  return rows.map(mapScratchpadRow);
}

export function syncScratchpadMirror(
  db: Database.Database,
  scratchpadMirrorPath: string | null,
): void {
  if (!scratchpadMirrorPath) return;
  try {
    const entries = listScratchpadEntries(db, SCRATCHPAD_MAX_ENTRIES);
    writeJsonAtomic(scratchpadMirrorPath, {
      updatedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    });
  } catch (error) {
    log.warn('Failed to sync scratchpad mirror', {
      path: scratchpadMirrorPath,
      error: String(error),
    });
  }
}
