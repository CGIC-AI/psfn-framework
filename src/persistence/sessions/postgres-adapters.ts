import type { Pool, PoolClient } from 'pg';
import { classifyChannelDisclosure } from '../../system/trust/policy.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import { decodeStoredChannelVisibility } from '../../system/trust/types.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryRows,
  withPostgresClient,
} from '../postgres.js';
import { POSTGRES_TRANSCRIPT_MIGRATIONS } from '../postgres/migrations.js';
import type { SessionArchivePort } from '../journals/journal/port.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { isCogSecTombstoneSessionEntry } from '../../core/cogsec/tombstones.js';
import type {
  KeywordSearchableTranscriptProjection,
  SessionSearchHit,
  TranscriptProjectionDrift,
} from './transcript-projection-port.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

interface ProjectionMessageRow {
  channel_id: string;
  message_id: number;
}

interface ProjectionDriftRow {
  channel_id: string;
  reason: string | null;
  marked_at: number;
}

interface SearchRow {
  channel_id: string;
  message_id: number;
  role: SessionSearchHit['role'];
  author_id: string | null;
  author_name: string | null;
  content: string;
  timestamp: number;
  channel_visibility: string;
  score: number;
  snippet: string;
}

interface ProjectionRecord {
  channelId: string;
  messageId: number;
  role: SessionSearchHit['role'];
  authorId?: string;
  authorName?: string;
  content: string;
  timestamp: number;
  channelVisibility: ChannelPrivacy;
}

export interface PostgresTranscriptProjectionOptions {
  pool?: Pool;
  applicationName?: string;
}

export interface PostgresSessionAdapters {
  sessionArchivePort: SessionArchivePort;
  transcriptProjection: KeywordSearchableTranscriptProjection;
  transcriptSearch: KeywordSearchableTranscriptProjection;
  turnRecordStore: TurnRecordStorePort;
}

export interface PostgresSessionAdaptersOptions extends PostgresTranscriptProjectionOptions {
  sessionsDir: string;
}

function normalizeSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_SEARCH_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(normalized, MAX_SEARCH_LIMIT);
}

function normalizeChannelVisibility(
  value: string | undefined,
  channelId: string,
): ChannelPrivacy {
  // Stored rows may predate the E3.1 vocabulary rename; the shared decoder
  // maps legacy 'semi_private' to 'invite_only'.
  return decodeStoredChannelVisibility(value) ?? classifyChannelDisclosure(channelId).channelPrivacy;
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value)) return Date.now();
  return Math.max(0, Math.floor(value));
}

function toProjectionRecord(
  entry: import('../../core/session/types.js').SessionEntry,
  options: { channelId?: string } = {},
): ProjectionRecord {
  const channelId = options.channelId ?? entry.channelId;
  return {
    channelId,
    messageId: entry.id,
    role: entry.role,
    ...(entry.authorId ? { authorId: entry.authorId } : {}),
    ...(entry.authorName ? { authorName: entry.authorName } : {}),
    content: entry.content,
    timestamp: normalizeTimestamp(entry.timestamp),
    channelVisibility: normalizeChannelVisibility(entry.channelVisibility, channelId),
  };
}

async function preloadMessageIds(pool: Pool): Promise<Map<string, Set<number>>> {
  const rows = await queryRows<ProjectionMessageRow>(
    pool,
    `
      SELECT channel_id, message_id
      FROM session_messages_projection
      ORDER BY channel_id ASC, message_id ASC
    `,
  );
  const byChannel = new Map<string, Set<number>>();
  for (const row of rows) {
    const existing = byChannel.get(row.channel_id) ?? new Set<number>();
    existing.add(Math.floor(row.message_id));
    byChannel.set(row.channel_id, existing);
  }
  return byChannel;
}

async function preloadDrift(pool: Pool): Promise<Map<string, TranscriptProjectionDrift>> {
  const rows = await queryRows<ProjectionDriftRow>(
    pool,
    `
      SELECT channel_id, reason, marked_at
      FROM session_projection_drift
      ORDER BY marked_at DESC, channel_id ASC
    `,
  );
  const drift = new Map<string, TranscriptProjectionDrift>();
  for (const row of rows) {
    drift.set(row.channel_id, {
      channelId: row.channel_id,
      ...(row.reason ? { reason: row.reason } : {}),
      markedAt: normalizeTimestamp(row.marked_at),
    });
  }
  return drift;
}

async function upsertProjectionRecord(client: PoolClient, record: ProjectionRecord): Promise<void> {
  await client.query(
    `
      INSERT INTO session_messages_projection (
        channel_id,
        message_id,
        role,
        author_id,
        author_name,
        content,
        timestamp,
        channel_visibility
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (channel_id, message_id) DO UPDATE SET
        role = EXCLUDED.role,
        author_id = EXCLUDED.author_id,
        author_name = EXCLUDED.author_name,
        content = EXCLUDED.content,
        timestamp = EXCLUDED.timestamp,
        channel_visibility = EXCLUDED.channel_visibility
    `,
    [
      record.channelId,
      record.messageId,
      record.role,
      record.authorId ?? null,
      record.authorName ?? null,
      record.content,
      record.timestamp,
      record.channelVisibility,
    ],
  );
}

async function deleteProjectionRecord(client: PoolClient, channelId: string, messageId: number): Promise<void> {
  await client.query(
    `
      DELETE FROM session_messages_projection
      WHERE channel_id = $1 AND message_id = $2
    `,
    [channelId, messageId],
  );
}

class PostgresTranscriptProjection implements KeywordSearchableTranscriptProjection {
  private readonly pool: Pool;
  private readonly messageIdsByChannel: Map<string, Set<number>>;
  private readonly driftByChannel: Map<string, TranscriptProjectionDrift>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    pool: Pool,
    messageIdsByChannel: Map<string, Set<number>>,
    driftByChannel: Map<string, TranscriptProjectionDrift>,
  ) {
    this.pool = pool;
    this.messageIdsByChannel = messageIdsByChannel;
    this.driftByChannel = driftByChannel;
  }

  private enqueueWrite(
    channelId: string,
    work: (client: PoolClient) => Promise<void>,
  ): void {
    this.writeChain = this.writeChain
      .then(async () => {
        try {
          await withPostgresClient(this.pool, work);
        } catch (error) {
          this.captureWriteFailure(channelId, error);
        }
      });
  }

  private captureWriteFailure(channelId: string, error: unknown): void {
    this.driftByChannel.set(channelId, {
      channelId,
      reason: error instanceof Error ? error.message : String(error),
      markedAt: Date.now(),
    });
  }

  private replaceCachedChannel(channelId: string, messageIds: readonly number[]): void {
    this.messageIdsByChannel.set(channelId, new Set(messageIds.map(id => Math.floor(id))));
  }

  upsertSessionEntry(
    entry: import('../../core/session/types.js').SessionEntry,
    options: { channelId?: string } = {},
  ): void {
    const channelId = options.channelId ?? entry.channelId;
    if (isCogSecTombstoneSessionEntry(entry)) {
      const messageIds = this.messageIdsByChannel.get(channelId) ?? new Set<number>();
      messageIds.delete(entry.id);
      this.messageIdsByChannel.set(channelId, messageIds);
      this.driftByChannel.delete(channelId);

      this.enqueueWrite(channelId, async (client) => {
        await deleteProjectionRecord(client, channelId, entry.id);
        await client.query(
          `
            DELETE FROM session_projection_drift
            WHERE channel_id = $1
          `,
          [channelId],
        );
      });
      return;
    }

    const record = toProjectionRecord(entry, options);
    const messageIds = this.messageIdsByChannel.get(record.channelId) ?? new Set<number>();
    messageIds.add(record.messageId);
    this.messageIdsByChannel.set(record.channelId, messageIds);
    this.driftByChannel.delete(record.channelId);

    this.enqueueWrite(record.channelId, async (client) => {
      await upsertProjectionRecord(client, record);
      await client.query(
        `
          DELETE FROM session_projection_drift
          WHERE channel_id = $1
        `,
        [record.channelId],
      );
    });
  }

  replaceChannelEntries(
    channelId: string,
    entries: readonly import('../../core/session/types.js').SessionEntry[],
  ): void {
    const records = entries
      .filter(entry => !isCogSecTombstoneSessionEntry(entry))
      .map(entry => toProjectionRecord(entry, { channelId }));
    this.replaceCachedChannel(channelId, records.map(record => record.messageId));
    this.driftByChannel.delete(channelId);

    this.enqueueWrite(channelId, async (client) => {
      await client.query(
        `
          DELETE FROM session_messages_projection
          WHERE channel_id = $1
        `,
        [channelId],
      );
      for (const record of records) {
        await upsertProjectionRecord(client, record);
      }
      await client.query(
        `
          DELETE FROM session_projection_drift
          WHERE channel_id = $1
        `,
        [channelId],
      );
    });
  }

  countProjectedMessages(channelId: string): number {
    return this.messageIdsByChannel.get(channelId)?.size ?? 0;
  }

  markProjectionDrift(channelId: string, reason?: string): void {
    const drift = {
      channelId,
      ...(reason ? { reason } : {}),
      markedAt: Date.now(),
    } satisfies TranscriptProjectionDrift;
    this.driftByChannel.set(channelId, drift);
    this.enqueueWrite(channelId, async (client) => {
      await client.query(
        `
          INSERT INTO session_projection_drift (channel_id, reason, marked_at)
          VALUES ($1, $2, $3)
          ON CONFLICT (channel_id) DO UPDATE SET
            reason = EXCLUDED.reason,
            marked_at = EXCLUDED.marked_at
        `,
        [channelId, reason ?? null, drift.markedAt],
      );
    });
  }

  clearProjectionDrift(channelId: string): void {
    this.driftByChannel.delete(channelId);
    this.enqueueWrite(channelId, async (client) => {
      await client.query(
        `
          DELETE FROM session_projection_drift
          WHERE channel_id = $1
        `,
        [channelId],
      );
    });
  }

  listProjectionDrift(): TranscriptProjectionDrift[] {
    return [...this.driftByChannel.values()].sort((left, right) => (
      right.markedAt - left.markedAt || left.channelId.localeCompare(right.channelId)
    ));
  }

  async flushPendingWrites(): Promise<void> {
    await this.writeChain;
  }

  async searchByKeywords(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<SessionSearchHit[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    await this.flushPendingWrites();
    const boundedLimit = normalizeSearchLimit(limit);
    const rows = await queryRows<SearchRow>(
      this.pool,
      `
        SELECT
          channel_id,
          message_id,
          role,
          author_id,
          author_name,
          content,
          timestamp,
          channel_visibility,
          ts_rank_cd(search_vector, websearch_to_tsquery('simple', $1)) AS score,
          ts_headline(
            'simple',
            content,
            websearch_to_tsquery('simple', $1),
            'StartSel=[,StopSel=],MaxFragments=2,MaxWords=18,MinWords=6'
          ) AS snippet
        FROM session_messages_projection
        WHERE search_vector @@ websearch_to_tsquery('simple', $1)
        ORDER BY score DESC, timestamp DESC, message_id DESC
        LIMIT $2
      `,
      [normalizedQuery, boundedLimit],
    );

    return rows.map(row => ({
      channelId: row.channel_id,
      messageId: Math.floor(row.message_id),
      role: row.role,
      ...(row.author_id ? { authorId: row.author_id } : {}),
      ...(row.author_name ? { authorName: row.author_name } : {}),
      content: row.content,
      timestamp: normalizeTimestamp(row.timestamp),
      channelVisibility: normalizeChannelVisibility(row.channel_visibility, row.channel_id),
      score: Number(row.score) || 0,
      snippet: row.snippet.trim() || row.content,
    }));
  }
}

export async function createPostgresTranscriptProjection(
  databaseUrl: string,
  options: PostgresTranscriptProjectionOptions = {},
): Promise<KeywordSearchableTranscriptProjection> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-session-search',
    allowExitOnIdle: true,
  });
  await ensurePostgresSchema(pool, POSTGRES_TRANSCRIPT_MIGRATIONS);
  const [messageIdsByChannel, driftByChannel] = await Promise.all([
    preloadMessageIds(pool),
    preloadDrift(pool),
  ]);
  return new PostgresTranscriptProjection(pool, messageIdsByChannel, driftByChannel);
}

export async function createDefaultPostgresSessionAdapters(
  databaseUrl: string,
  options: PostgresSessionAdaptersOptions,
): Promise<PostgresSessionAdapters> {
  const transcriptProjection = await createPostgresTranscriptProjection(databaseUrl, options);
  return {
    sessionArchivePort: createFilesystemSessionArchivePort(),
    transcriptProjection,
    transcriptSearch: transcriptProjection,
    turnRecordStore: createFilesystemTurnRecordStorePort(options.sessionsDir),
  };
}
