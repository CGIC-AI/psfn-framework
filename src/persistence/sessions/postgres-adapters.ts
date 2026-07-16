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
  TranscriptSearchOptions,
} from './transcript-projection-port.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';
import type { TurnRecordEligibilityFencePort } from './turn-record-eligibility-fence-port.js';
import { PostgresTurnRecordEligibilityFence } from '../postgres/turn-record-eligibility-fence.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

interface ProjectionMessageMetadataRow {
  channel_id: string;
  message_count: number | string;
  max_message_id: number | string | null;
}

interface ProjectionMessageMetadata {
  count: number;
  maxMessageId: number | null;
  epoch: number;
}

interface ProjectionMutationPrediction {
  changed: boolean;
  epoch: number;
}

interface ProjectionUpsertResultRow {
  inserted: boolean;
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
  schema?: string;
}

export interface PostgresSessionAdapters {
  sessionArchivePort: SessionArchivePort;
  transcriptProjection: KeywordSearchableTranscriptProjection;
  transcriptSearch: KeywordSearchableTranscriptProjection;
  turnRecordStore: TurnRecordStorePort;
  turnRecordEligibilityFence: TurnRecordEligibilityFencePort;
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

async function preloadProjectionMessageMetadata(
  pool: Pool,
): Promise<Map<string, ProjectionMessageMetadata>> {
  const rows = await queryRows<ProjectionMessageMetadataRow>(
    pool,
    `
      SELECT
        channel_id,
        COUNT(*) AS message_count,
        MAX(message_id) AS max_message_id
      FROM session_messages_projection
      GROUP BY channel_id
      ORDER BY channel_id ASC
    `,
  );
  const byChannel = new Map<string, ProjectionMessageMetadata>();
  for (const row of rows) {
    const count = Number(row.message_count);
    const maxMessageId = row.max_message_id === null ? null : Number(row.max_message_id);
    byChannel.set(row.channel_id, {
      count: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
      maxMessageId: maxMessageId !== null && Number.isFinite(maxMessageId)
        ? Math.floor(maxMessageId)
        : null,
      epoch: 0,
    });
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

async function upsertProjectionRecord(client: PoolClient, record: ProjectionRecord): Promise<boolean> {
  const result = await client.query<ProjectionUpsertResultRow>(
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
      RETURNING (xmax = 0) AS inserted
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
  return result.rows[0]?.inserted === true;
}

async function deleteProjectionRecord(client: PoolClient, channelId: string, messageId: number): Promise<boolean> {
  const result = await client.query(
    `
      DELETE FROM session_messages_projection
      WHERE channel_id = $1 AND message_id = $2
    `,
    [channelId, messageId],
  );
  return (result.rowCount ?? 0) > 0;
}

class PostgresTranscriptProjection implements KeywordSearchableTranscriptProjection {
  private readonly pool: Pool;
  private readonly messageMetadataByChannel: Map<string, ProjectionMessageMetadata>;
  private readonly driftByChannel: Map<string, TranscriptProjectionDrift>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    pool: Pool,
    messageMetadataByChannel: Map<string, ProjectionMessageMetadata>,
    driftByChannel: Map<string, TranscriptProjectionDrift>,
  ) {
    this.pool = pool;
    this.messageMetadataByChannel = messageMetadataByChannel;
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

  private getMessageMetadata(channelId: string): ProjectionMessageMetadata {
    const existing = this.messageMetadataByChannel.get(channelId);
    if (existing) return existing;
    const created = { count: 0, maxMessageId: null, epoch: 0 };
    this.messageMetadataByChannel.set(channelId, created);
    return created;
  }

  private predictProjectionUpsert(
    channelId: string,
    messageId: number,
  ): ProjectionMutationPrediction {
    const metadata = this.getMessageMetadata(channelId);
    const predictedInserted = metadata.maxMessageId === null || messageId > metadata.maxMessageId;
    if (predictedInserted) {
      metadata.count += 1;
      metadata.maxMessageId = messageId;
    }
    return { changed: predictedInserted, epoch: metadata.epoch };
  }

  private reconcileProjectionUpsert(
    channelId: string,
    messageId: number,
    prediction: ProjectionMutationPrediction,
    inserted: boolean,
  ): void {
    const metadata = this.getMessageMetadata(channelId);
    if (metadata.epoch !== prediction.epoch) return;
    if (inserted && !prediction.changed) metadata.count += 1;
    if (!inserted && prediction.changed) metadata.count = Math.max(0, metadata.count - 1);
    if (inserted && (metadata.maxMessageId === null || messageId > metadata.maxMessageId)) {
      metadata.maxMessageId = messageId;
    }
  }

  private predictProjectionDelete(
    channelId: string,
    messageId: number,
  ): ProjectionMutationPrediction {
    const metadata = this.getMessageMetadata(channelId);
    const predictedDeleted = metadata.count > 0
      && metadata.maxMessageId !== null
      && messageId <= metadata.maxMessageId;
    if (predictedDeleted) metadata.count -= 1;
    return { changed: predictedDeleted, epoch: metadata.epoch };
  }

  private reconcileProjectionDelete(
    channelId: string,
    prediction: ProjectionMutationPrediction,
    deleted: boolean,
  ): void {
    const metadata = this.getMessageMetadata(channelId);
    if (metadata.epoch !== prediction.epoch) return;
    if (deleted && !prediction.changed) metadata.count = Math.max(0, metadata.count - 1);
    if (!deleted && prediction.changed) metadata.count += 1;
  }

  private replaceCachedChannel(channelId: string, messageIds: readonly number[]): void {
    const normalizedIds = messageIds.map(id => Math.floor(id));
    let maxMessageId: number | null = null;
    for (const messageId of normalizedIds) {
      if (maxMessageId === null || messageId > maxMessageId) maxMessageId = messageId;
    }
    const epoch = this.getMessageMetadata(channelId).epoch + 1;
    this.messageMetadataByChannel.set(channelId, {
      count: normalizedIds.length,
      maxMessageId,
      epoch,
    });
  }

  upsertSessionEntry(
    entry: import('../../core/session/types.js').SessionEntry,
    options: { channelId?: string } = {},
  ): void {
    const channelId = options.channelId ?? entry.channelId;
    if (isCogSecTombstoneSessionEntry(entry)) {
      const prediction = this.predictProjectionDelete(channelId, entry.id);
      const clearTrackedDrift = this.driftByChannel.delete(channelId);

      this.enqueueWrite(channelId, async (client) => {
        const deleted = await deleteProjectionRecord(client, channelId, entry.id);
        this.reconcileProjectionDelete(channelId, prediction, deleted);
        if (clearTrackedDrift) {
          await client.query(
            `
              DELETE FROM session_projection_drift
              WHERE channel_id = $1
            `,
            [channelId],
          );
        }
      });
      return;
    }

    const record = toProjectionRecord(entry, options);
    const prediction = this.predictProjectionUpsert(record.channelId, record.messageId);
    const clearTrackedDrift = this.driftByChannel.delete(record.channelId);

    this.enqueueWrite(record.channelId, async (client) => {
      const inserted = await upsertProjectionRecord(client, record);
      this.reconcileProjectionUpsert(
        record.channelId,
        record.messageId,
        prediction,
        inserted,
      );
      if (clearTrackedDrift) {
        await client.query(
          `
            DELETE FROM session_projection_drift
            WHERE channel_id = $1
          `,
          [record.channelId],
        );
      }
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
    const clearTrackedDrift = this.driftByChannel.delete(channelId);

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
      if (clearTrackedDrift) {
        await client.query(
          `
            DELETE FROM session_projection_drift
            WHERE channel_id = $1
          `,
          [channelId],
        );
      }
    });
  }

  countProjectedMessages(channelId: string): number {
    return this.messageMetadataByChannel.get(channelId)?.count ?? 0;
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

  async searchByKeywords(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    options: TranscriptSearchOptions = {},
  ): Promise<SessionSearchHit[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    await this.flushPendingWrites();
    const boundedLimit = normalizeSearchLimit(limit);
    const scopedChannelId = options.channelId?.trim() || undefined;
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
          AND ($3::text IS NULL OR channel_id = $3)
        ORDER BY score DESC, timestamp DESC, message_id DESC
        LIMIT $2
      `,
      [normalizedQuery, boundedLimit, scopedChannelId ?? null],
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
    ...(options.schema ? { schema: options.schema } : {}),
  });
  await ensurePostgresSchema(pool, POSTGRES_TRANSCRIPT_MIGRATIONS);
  const [messageMetadataByChannel, driftByChannel] = await Promise.all([
    preloadProjectionMessageMetadata(pool),
    preloadDrift(pool),
  ]);
  return new PostgresTranscriptProjection(pool, messageMetadataByChannel, driftByChannel);
}

export async function createDefaultPostgresSessionAdapters(
  databaseUrl: string,
  options: PostgresSessionAdaptersOptions,
): Promise<PostgresSessionAdapters> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-session-search',
    allowExitOnIdle: true,
    ...(options.schema ? { schema: options.schema } : {}),
  });
  const transcriptProjection = await createPostgresTranscriptProjection(databaseUrl, {
    ...options,
    pool,
  });
  return {
    sessionArchivePort: createFilesystemSessionArchivePort(),
    transcriptProjection,
    transcriptSearch: transcriptProjection,
    turnRecordStore: createFilesystemTurnRecordStorePort(options.sessionsDir),
    turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
      pool,
      options.schema ?? 'default',
    ),
  };
}
