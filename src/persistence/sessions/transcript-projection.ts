import type Database from 'better-sqlite3';
import { classifyChannel } from '../../system/trust/policy.js';
import type { ChannelVisibility } from '../../system/trust/types.js';
import { decodeStoredChannelVisibility } from '../../system/trust/types.js';
import { initDatabase } from '../sqlite-utils.js';
import type { SessionEntry } from '../../core/session/types.js';
import { isCogSecTombstoneSessionEntry } from '../../core/cogsec/tombstones.js';
import type {
  KeywordSearchableTranscriptProjection,
  SessionSearchHit,
  TranscriptProjectionDrift,
} from './transcript-projection-port.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

interface IndexedSearchRow {
  channel_id: string;
  message_id: number;
  role: SessionEntry['role'];
  author_id: string | null;
  author_name: string | null;
  content: string;
  timestamp: number;
  channel_visibility: string;
  score: number;
  snippet: string;
}

interface ProjectionDriftRow {
  channel_id: string;
  reason: string | null;
  marked_at: number;
}

function escapeMatchToken(token: string): string {
  return token.replaceAll('"', '""');
}

function normalizeSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(normalized, MAX_SEARCH_LIMIT);
}

function normalizeChannelVisibility(
  value: string | undefined,
  channelId: string,
): ChannelVisibility {
  // Stored rows may predate the E3.1 vocabulary rename; the shared decoder
  // maps legacy 'semi_private' to 'invite_only'.
  return decodeStoredChannelVisibility(value) ?? classifyChannel(channelId);
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value)) return Date.now();
  const floored = Math.floor(value);
  return Math.max(0, floored);
}

function buildSafeMatchQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 0)
    .slice(0, 12);

  if (tokens.length === 0) return '';
  return tokens.map(token => `"${escapeMatchToken(token)}"`).join(' AND ');
}

export class SqliteTranscriptProjection implements KeywordSearchableTranscriptProjection {
  private db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly deleteChannelStmt: Database.Statement;
  private readonly deleteEntryStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;
  private readonly countChannelStmt: Database.Statement;
  private readonly markDriftStmt: Database.Statement;
  private readonly clearDriftStmt: Database.Statement;
  private readonly listDriftStmt: Database.Statement;

  constructor(databasePath: string) {
    this.db = initDatabase(databasePath, { synchronous: 'NORMAL' });
    this.createSchema();
    this.upsertStmt = this.db.prepare(`
      INSERT INTO session_messages_index (
        channel_id,
        message_id,
        role,
        author_id,
        author_name,
        content,
        timestamp,
        channel_visibility
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, message_id) DO UPDATE SET
        role = excluded.role,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        content = excluded.content,
        timestamp = excluded.timestamp,
        channel_visibility = excluded.channel_visibility
    `);
    this.deleteChannelStmt = this.db.prepare(`
      DELETE FROM session_messages_index
      WHERE channel_id = ?
    `);
    this.deleteEntryStmt = this.db.prepare(`
      DELETE FROM session_messages_index
      WHERE channel_id = ? AND message_id = ?
    `);
    this.searchStmt = this.db.prepare(`
      SELECT
        m.channel_id,
        m.message_id,
        m.role,
        m.author_id,
        m.author_name,
        m.content,
        m.timestamp,
        m.channel_visibility,
        bm25(session_fts) AS score,
        snippet(session_fts, 0, '[', ']', ' ... ', 18) AS snippet
      FROM session_fts
      JOIN session_messages_index m ON m.rowid = session_fts.rowid
      WHERE session_fts MATCH ?
      ORDER BY score ASC, m.timestamp DESC
      LIMIT ?
    `);
    this.countChannelStmt = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM session_messages_index
      WHERE channel_id = ?
    `);
    this.markDriftStmt = this.db.prepare(`
      INSERT INTO session_projection_drift (channel_id, reason, marked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        reason = excluded.reason,
        marked_at = excluded.marked_at
    `);
    this.clearDriftStmt = this.db.prepare(`
      DELETE FROM session_projection_drift
      WHERE channel_id = ?
    `);
    this.listDriftStmt = this.db.prepare(`
      SELECT channel_id, reason, marked_at
      FROM session_projection_drift
      ORDER BY marked_at DESC, channel_id ASC
    `);
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages_index (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        channel_visibility TEXT NOT NULL,
        UNIQUE(channel_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_index_channel_timestamp
        ON session_messages_index(channel_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS session_projection_drift (
        channel_id TEXT PRIMARY KEY,
        reason TEXT,
        marked_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        content,
        content='session_messages_index',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS session_messages_index_ai AFTER INSERT ON session_messages_index BEGIN
        INSERT INTO session_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_index_ad AFTER DELETE ON session_messages_index BEGIN
        INSERT INTO session_fts(session_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_index_au AFTER UPDATE ON session_messages_index BEGIN
        INSERT INTO session_fts(session_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO session_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  upsertSessionEntry(entry: SessionEntry, options: { channelId?: string } = {}): void {
    const channelId = options.channelId ?? entry.channelId;
    if (isCogSecTombstoneSessionEntry(entry)) {
      this.deleteEntryStmt.run(channelId, entry.id);
      this.clearProjectionDrift(channelId);
      return;
    }

    const visibility = normalizeChannelVisibility(entry.channelVisibility, entry.channelId);
    this.upsertStmt.run(
      channelId,
      entry.id,
      entry.role,
      entry.authorId ?? null,
      entry.authorName ?? null,
      entry.content,
      normalizeTimestamp(entry.timestamp),
      visibility,
    );
    this.clearProjectionDrift(channelId);
  }

  replaceChannelEntries(channelId: string, entries: readonly SessionEntry[]): void {
    const tx = this.db.transaction((targetChannelId: string, replacementEntries: readonly SessionEntry[]) => {
      this.deleteChannelStmt.run(targetChannelId);
      for (const entry of replacementEntries) {
        this.upsertSessionEntry(entry, { channelId: targetChannelId });
      }
      this.clearProjectionDrift(targetChannelId);
    });
    tx(channelId, entries);
  }

  countProjectedMessages(channelId: string): number {
    const row = this.countChannelStmt.get(channelId) as { count?: number } | undefined;
    if (!row || !Number.isFinite(row.count)) return 0;
    return Math.max(0, Math.floor(row.count ?? 0));
  }

  markProjectionDrift(channelId: string, reason?: string): void {
    this.markDriftStmt.run(channelId, reason ?? null, Date.now());
  }

  clearProjectionDrift(channelId: string): void {
    this.clearDriftStmt.run(channelId);
  }

  listProjectionDrift(): TranscriptProjectionDrift[] {
    const rows = this.listDriftStmt.all() as ProjectionDriftRow[];
    return rows.map(row => ({
      channelId: row.channel_id,
      ...(row.reason ? { reason: row.reason } : {}),
      markedAt: row.marked_at,
    }));
  }

  async searchByKeywords(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<SessionSearchHit[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const ftsQuery = buildSafeMatchQuery(normalizedQuery);
    if (!ftsQuery) return [];
    const boundedLimit = normalizeSearchLimit(limit);

    let rows: IndexedSearchRow[] = [];
    try {
      rows = this.searchStmt.all(ftsQuery, boundedLimit) as IndexedSearchRow[];
    } catch {
      const fallback = `"${escapeMatchToken(normalizedQuery)}"`;
      try {
        rows = this.searchStmt.all(fallback, boundedLimit) as IndexedSearchRow[];
      } catch {
        return [];
      }
    }

    return rows.map(row => {
      const visibility = normalizeChannelVisibility(row.channel_visibility, row.channel_id);
      return {
        channelId: row.channel_id,
        messageId: row.message_id,
        role: row.role,
        ...(row.author_id ? { authorId: row.author_id } : {}),
        ...(row.author_name ? { authorName: row.author_name } : {}),
        content: row.content,
        timestamp: row.timestamp,
        channelVisibility: visibility,
        score: row.score,
        snippet: row.snippet,
      };
    });
  }
}

export function createSqliteTranscriptProjection(databasePath: string): SqliteTranscriptProjection {
  return new SqliteTranscriptProjection(databasePath);
}
