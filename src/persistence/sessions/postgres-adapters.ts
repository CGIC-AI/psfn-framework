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
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';
import type { RedactionProjectionDriftObserver } from '../../shared/contracts/projection-drift.js';
import type {
  KeywordSearchableTranscriptProjection,
  ReplaceChannelEntriesOptions,
  SessionSearchHit,
  TranscriptProjectionDrift,
  TranscriptProjectionDriftKind,
  TranscriptSearchOptions,
} from './transcript-projection-port.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';
import type { TurnRecordEligibilityFencePort } from './turn-record-eligibility-fence-port.js';
import { PostgresTurnRecordEligibilityFence } from '../postgres/turn-record-eligibility-fence.js';
import {
  purgeTestingSessionPostgresData,
  type SessionDatabasePurgePort,
} from './testing-session-postgres-purge.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

const log = createComponentLogger('TranscriptProjection');

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
  kind: string | null;
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
  metadataJson: Record<string, unknown>;
}

export interface PostgresTranscriptProjectionOptions {
  pool?: Pool;
  applicationName?: string;
  schema?: string;
  role?: string;
  /**
   * Operator-visibility seam (bead 6oott): notified when a redaction-driven
   * projection write fails after its bounded retry, and on startup for
   * redaction drift preloaded from the durable record. Optional — search is
   * fail-closed by the durable drift record with or without an observer.
   */
  redactionDriftObserver?: RedactionProjectionDriftObserver;
}

export interface PostgresSessionAdapters {
  sessionPurge: SessionDatabasePurgePort;
  sessionArchivePort: SessionArchivePort;
  transcriptProjection: KeywordSearchableTranscriptProjection;
  transcriptSearch: KeywordSearchableTranscriptProjection;
  turnRecordStore: TurnRecordStorePort;
  turnRecordEligibilityFence: TurnRecordEligibilityFencePort;
  /** Production exact-purge seam; deliberately excludes the testing purge port. */
  exactSessionProjection: {
    pool: Pool;
    flushPendingWrites(): Promise<void>;
    evictChannel(channelId: string): void;
  };
}

export interface PostgresSessionAdaptersOptions extends PostgresTranscriptProjectionOptions {
  sessionsDir: string;
  automataRetentionWriteBarrier?: {
    assertWritable(sessionIdentities: readonly string[]): void;
  };
}

type ExactTranscriptProjection = KeywordSearchableTranscriptProjection
  & SessionDatabasePurgePort
  & {
    flushPendingWrites(): Promise<void>;
    evictChannel(channelId: string): void;
  };

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

function parseProjectionMetadata(metadata: string | undefined): Record<string, unknown> {
  if (metadata === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session projection metadata must be valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session projection metadata must be a JSON object');
  }
  return parsed;
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
    metadataJson: parseProjectionMetadata(entry.metadata),
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

function normalizeDriftKind(value: string | null | undefined): TranscriptProjectionDriftKind {
  // Fail closed: 'sync' is the only kind with best-effort semantics, so any
  // unexpected stored value is treated as the stricter 'redaction' class.
  return value === 'sync' ? 'sync' : 'redaction';
}

async function preloadDrift(pool: Pool): Promise<Map<string, TranscriptProjectionDrift>> {
  const rows = await queryRows<ProjectionDriftRow>(
    pool,
    `
      SELECT channel_id, reason, marked_at, kind
      FROM session_projection_drift
      ORDER BY marked_at DESC, channel_id ASC
    `,
  );
  const drift = new Map<string, TranscriptProjectionDrift>();
  for (const row of rows) {
    drift.set(row.channel_id, {
      channelId: row.channel_id,
      kind: normalizeDriftKind(row.kind),
      ...(row.reason ? { reason: row.reason } : {}),
      markedAt: normalizeTimestamp(row.marked_at),
    });
  }
  return drift;
}

async function persistDriftRecord(client: PoolClient, drift: TranscriptProjectionDrift): Promise<void> {
  // No-downgrade guard: a concurrent or later 'sync' mark must never relax an
  // existing fail-closed 'redaction' record.
  await client.query(
    `
      INSERT INTO session_projection_drift (channel_id, reason, marked_at, kind)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel_id) DO UPDATE SET
        reason = EXCLUDED.reason,
        marked_at = EXCLUDED.marked_at,
        kind = CASE
          WHEN session_projection_drift.kind = 'redaction' THEN 'redaction'
          ELSE EXCLUDED.kind
        END
    `,
    [drift.channelId, drift.reason ?? null, drift.markedAt, drift.kind],
  );
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
        channel_visibility,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (channel_id, message_id) DO UPDATE SET
        role = EXCLUDED.role,
        author_id = EXCLUDED.author_id,
        author_name = EXCLUDED.author_name,
        content = EXCLUDED.content,
        timestamp = EXCLUDED.timestamp,
        channel_visibility = EXCLUDED.channel_visibility,
        metadata_json = EXCLUDED.metadata_json
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
      record.metadataJson,
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
  private readonly redactionDriftObserver: RedactionProjectionDriftObserver | null;
  /**
   * Redaction drift captured in-memory whose durable row could not be written
   * yet (the database was failing at capture time). Flushed before every
   * subsequent write and search; until it lands, the in-memory record keeps
   * in-process search fail-closed (bead 6oott).
   */
  private readonly pendingDurableDriftChannels = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    pool: Pool,
    messageMetadataByChannel: Map<string, ProjectionMessageMetadata>,
    driftByChannel: Map<string, TranscriptProjectionDrift>,
    redactionDriftObserver: RedactionProjectionDriftObserver | null = null,
  ) {
    this.pool = pool;
    this.messageMetadataByChannel = messageMetadataByChannel;
    this.driftByChannel = driftByChannel;
    this.redactionDriftObserver = redactionDriftObserver;
  }

  /**
   * Serialized best-effort write chain. Redaction-classified work gets the
   * fail-closed contract (bead 6oott): one bounded retry, then a DURABLE
   * `redaction` drift record instead of the in-memory-only `sync` capture.
   * Ordinary work keeps the pre-existing best-effort semantics.
   */
  private enqueueWrite(
    channelId: string,
    work: (client: PoolClient) => Promise<void>,
    options: { redaction?: boolean; onCommitted?: () => void } = {},
  ): void {
    this.writeChain = this.writeChain
      .then(async () => {
        try {
          await this.runProjectionWrite(work);
          options.onCommitted?.();
        } catch (error) {
          if (options.redaction === true) {
            // One bounded retry for transient failures (each attempt is a full
            // transaction, so the retry re-runs against a clean rollback).
            try {
              await this.runProjectionWrite(work);
              options.onCommitted?.();
              return;
            } catch (retryError) {
              await this.captureRedactionWriteFailure(channelId, retryError);
              return;
            }
          }
          this.captureWriteFailure(channelId, error);
        }
      });
  }

  private async runProjectionWrite(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const flushedPendingDrift: string[] = [];
    await withPostgresClient(this.pool, async (client) => {
      for (const channelId of this.pendingDurableDriftChannels) {
        const drift = this.driftByChannel.get(channelId);
        if (drift) {
          await persistDriftRecord(client, drift);
        }
        flushedPendingDrift.push(channelId);
      }
      await work(client);
    });
    // Only clear pending markers after the transaction committed.
    for (const channelId of flushedPendingDrift) {
      this.pendingDurableDriftChannels.delete(channelId);
    }
  }

  private captureWriteFailure(channelId: string, error: unknown): void {
    const existing = this.driftByChannel.get(channelId);
    this.driftByChannel.set(channelId, {
      channelId,
      // No-downgrade: an ordinary failure on a channel already fail-closed for
      // a redaction keeps the stricter kind.
      kind: existing?.kind === 'redaction' ? 'redaction' : 'sync',
      reason: error instanceof Error ? error.message : String(error),
      markedAt: Date.now(),
    });
  }

  private async captureRedactionWriteFailure(channelId: string, error: unknown): Promise<void> {
    const drift: TranscriptProjectionDrift = {
      channelId,
      kind: 'redaction',
      reason: error instanceof Error ? error.message : String(error),
      markedAt: Date.now(),
    };
    this.driftByChannel.set(channelId, drift);
    this.notifyRedactionDriftObserver(drift);
    try {
      await withPostgresClient(this.pool, client => persistDriftRecord(client, drift));
      this.pendingDurableDriftChannels.delete(channelId);
    } catch (persistError) {
      // Not a swallow: the in-memory record keeps in-process search fail-closed
      // right now, the pending marker retries durability on every subsequent
      // write and search, and a database this broken fails search outright.
      this.pendingDurableDriftChannels.add(channelId);
      log.warn('Redaction projection drift captured but durable record write failed; will retry', {
        channelId,
        driftReason: drift.reason,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
  }

  private notifyRedactionDriftObserver(drift: TranscriptProjectionDrift): void {
    if (!this.redactionDriftObserver) return;
    try {
      this.redactionDriftObserver.recordRedactionProjectionDrift({
        channelId: drift.channelId,
        reason: drift.reason ?? 'unknown projection write failure',
        markedAtMs: drift.markedAt,
      });
    } catch (error) {
      // The incident is the operator signal, not the enforcement: search is
      // already fail-closed by the drift record itself.
      log.warn('Redaction projection drift incident recording failed; search remains fail-closed', {
        channelId: drift.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Startup re-surface: notify the observer for preloaded redaction drift. */
  notifyPreloadedRedactionDrift(): void {
    for (const drift of this.driftByChannel.values()) {
      if (drift.kind === 'redaction') {
        this.notifyRedactionDriftObserver(drift);
      }
    }
  }

  private hasRedactionDrift(channelId: string): boolean {
    return this.driftByChannel.get(channelId)?.kind === 'redaction';
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

  /**
   * Ordinary-write drift clearing: a single successful write only proves the
   * channel is writable again, so it may clear best-effort `sync` drift but
   * never a fail-closed `redaction` record (a successful append does not
   * remove a surviving redacted row). Redaction drift clears only via a full
   * successful channel replacement, explicit clearProjectionDrift (repair), or
   * purge.
   */
  private takeClearableSyncDrift(channelId: string): boolean {
    const existing = this.driftByChannel.get(channelId);
    if (!existing || existing.kind === 'redaction') return false;
    this.driftByChannel.delete(channelId);
    this.pendingDurableDriftChannels.delete(channelId);
    return true;
  }

  upsertSessionEntry(
    entry: import('../../core/session/types.js').SessionEntry,
    options: { channelId?: string } = {},
  ): void {
    const channelId = options.channelId ?? entry.channelId;
    if (isCogSecTombstoneSessionEntry(entry)) {
      // A tombstone upsert is a redaction propagation: its projection DELETE
      // failing leaves the original content row standing (bead 6oott).
      const prediction = this.predictProjectionDelete(channelId, entry.id);
      const clearTrackedDrift = this.takeClearableSyncDrift(channelId);

      this.enqueueWrite(channelId, async (client) => {
        const deleted = await deleteProjectionRecord(client, channelId, entry.id);
        this.reconcileProjectionDelete(channelId, prediction, deleted);
        if (clearTrackedDrift) {
          await client.query(
            `
              DELETE FROM session_projection_drift
              WHERE channel_id = $1 AND kind <> 'redaction'
            `,
            [channelId],
          );
        }
      }, { redaction: true });
      return;
    }

    const record = toProjectionRecord(entry, options);
    const prediction = this.predictProjectionUpsert(record.channelId, record.messageId);
    const clearTrackedDrift = this.takeClearableSyncDrift(record.channelId);

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
            WHERE channel_id = $1 AND kind <> 'redaction'
          `,
          [record.channelId],
        );
      }
    });
  }

  replaceChannelEntries(
    channelId: string,
    entries: readonly import('../../core/session/types.js').SessionEntry[],
    options: ReplaceChannelEntriesOptions = {},
  ): void {
    // Redaction inference backstop (bead 6oott): canon entries that still carry
    // CogSec tombstone markers mean this replacement is what strips redacted
    // content out of the projection — if it fails, the original rows survive.
    // Callers on redaction paths also pass options.redaction explicitly.
    const redaction = options.redaction === true
      || entries.some(entry => isCogSecTombstoneSessionEntry(entry));
    const records = entries
      .filter(entry => !isCogSecTombstoneSessionEntry(entry))
      .map(entry => toProjectionRecord(entry, { channelId }));
    this.replaceCachedChannel(channelId, records.map(record => record.messageId));
    // Best-effort 'sync' drift keeps its pre-6oott synchronous clear (callers
    // like repair read listProjectionDrift before the queued write flushes).
    // Fail-closed 'redaction' drift is only cleared after the replacement
    // commits (onCommitted below).
    this.takeClearableSyncDrift(channelId);

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
      // A full successful replacement makes the projection match canon, so it
      // clears drift of ANY kind — including fail-closed redaction drift. The
      // durable clear runs inside the write transaction; on failure it rolls
      // back and the drift record stays authoritative.
      await client.query(
        `
          DELETE FROM session_projection_drift
          WHERE channel_id = $1
        `,
        [channelId],
      );
    }, {
      redaction,
      // In-memory drift clears only after the transaction committed, so a
      // commit failure can never leave the in-memory fail-closed record
      // weakened while the durable row survives the rollback.
      onCommitted: () => {
        this.driftByChannel.delete(channelId);
        this.pendingDurableDriftChannels.delete(channelId);
      },
    });
  }

  countProjectedMessages(channelId: string): number {
    return this.messageMetadataByChannel.get(channelId)?.count ?? 0;
  }

  markProjectionDrift(
    channelId: string,
    reason?: string,
    kind: TranscriptProjectionDriftKind = 'sync',
  ): void {
    // No-downgrade: marking 'sync' drift on a channel already fail-closed for
    // a redaction keeps the stricter kind (mirrored durably by
    // persistDriftRecord's conflict clause).
    const existing = this.driftByChannel.get(channelId);
    const effectiveKind = existing?.kind === 'redaction' ? 'redaction' : kind;
    const drift = {
      channelId,
      kind: effectiveKind,
      ...(reason ? { reason } : {}),
      markedAt: Date.now(),
    } satisfies TranscriptProjectionDrift;
    this.driftByChannel.set(channelId, drift);
    this.enqueueWrite(channelId, async (client) => {
      await persistDriftRecord(client, drift);
    }, { redaction: effectiveKind === 'redaction' });
    if (effectiveKind === 'redaction') {
      this.notifyRedactionDriftObserver(drift);
    }
  }

  clearProjectionDrift(channelId: string): void {
    // Explicit repair/operator action: clears drift of any kind.
    this.driftByChannel.delete(channelId);
    this.pendingDurableDriftChannels.delete(channelId);
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

  evictChannel(channelId: string): void {
    this.messageMetadataByChannel.delete(channelId);
    this.driftByChannel.delete(channelId);
    this.pendingDurableDriftChannels.delete(channelId);
  }

  /**
   * Best-effort retry of durable-drift rows whose insert failed at capture
   * time. A failure here is logged, not thrown: the in-memory record already
   * fail-closes in-process search, and a database that cannot accept this
   * write fails the search query itself.
   */
  private async flushPendingDurableDrift(): Promise<void> {
    if (this.pendingDurableDriftChannels.size === 0) return;
    const flushed: string[] = [];
    try {
      await withPostgresClient(this.pool, async (client) => {
        for (const channelId of this.pendingDurableDriftChannels) {
          const drift = this.driftByChannel.get(channelId);
          if (drift) {
            await persistDriftRecord(client, drift);
          }
          flushed.push(channelId);
        }
      });
      for (const channelId of flushed) {
        this.pendingDurableDriftChannels.delete(channelId);
      }
    } catch (error) {
      log.warn('Pending durable drift flush failed; in-memory fail-closed filter remains active', {
        channels: [...this.pendingDurableDriftChannels],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async purgeSession(
    input: Parameters<SessionDatabasePurgePort['purgeSession']>[0],
  ): ReturnType<SessionDatabasePurgePort['purgeSession']> {
    await this.flushPendingWrites();
    const report = await purgeTestingSessionPostgresData(this.pool, input);
    this.messageMetadataByChannel.delete(input.channelId);
    this.driftByChannel.delete(input.channelId);
    this.pendingDurableDriftChannels.delete(input.channelId);
    return report;
  }

  async searchByKeywords(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    options: TranscriptSearchOptions = {},
  ): Promise<SessionSearchHit[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    await this.flushPendingWrites();
    await this.flushPendingDurableDrift();
    const boundedLimit = normalizeSearchLimit(limit);
    const scopedChannelId = options.channelId?.trim() || undefined;
    const firstMessageId = options.firstMessageId;
    const lastMessageId = options.lastMessageId;
    if (
      (firstMessageId !== undefined && (!Number.isSafeInteger(firstMessageId) || firstMessageId < 1))
      || (lastMessageId !== undefined && (!Number.isSafeInteger(lastMessageId) || lastMessageId < 1))
      || (firstMessageId !== undefined && lastMessageId !== undefined && firstMessageId > lastMessageId)
    ) {
      return [];
    }
    // Fail closed under known redaction drift (bead 6oott, charter Law
    // 22/6.23): a channel whose redaction failed to project may still hold
    // content canon has redacted, so its rows are excluded until repair clears
    // the record. The SQL predicate keys on the DURABLE record (covers
    // restarts and other processes sharing the database); the in-memory filter
    // below covers a drift record whose durable write has not landed yet.
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
          AND ($4::bigint IS NULL OR message_id >= $4)
          AND ($5::bigint IS NULL OR message_id <= $5)
          AND NOT EXISTS (
            SELECT 1
            FROM session_projection_drift drift
            WHERE drift.channel_id = session_messages_projection.channel_id
              AND drift.kind = 'redaction'
          )
        ORDER BY score DESC, timestamp DESC, message_id DESC
        LIMIT $2
      `,
      [
        normalizedQuery,
        boundedLimit,
        scopedChannelId ?? null,
        firstMessageId ?? null,
        lastMessageId ?? null,
      ],
    );

    return rows.filter(row => !this.hasRedactionDrift(row.channel_id)).map(row => ({
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
): Promise<ExactTranscriptProjection> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-session-search',
    allowExitOnIdle: true,
    ...(options.schema ? { schema: options.schema } : {}),
    ...(options.role ? { role: options.role } : {}),
  });
  await ensurePostgresSchema(pool, POSTGRES_TRANSCRIPT_MIGRATIONS);
  const [messageMetadataByChannel, driftByChannel] = await Promise.all([
    preloadProjectionMessageMetadata(pool),
    preloadDrift(pool),
  ]);
  const projection = new PostgresTranscriptProjection(
    pool,
    messageMetadataByChannel,
    driftByChannel,
    options.redactionDriftObserver ?? null,
  );
  // Re-surface unresolved redaction drift after a restart: the durable record
  // already fail-closes search; this keeps the operator incident alive even if
  // the process died between drift capture and incident recording.
  projection.notifyPreloadedRedactionDrift();
  return projection;
}

export async function createDefaultPostgresSessionAdapters(
  databaseUrl: string,
  options: PostgresSessionAdaptersOptions,
): Promise<PostgresSessionAdapters> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-session-search',
    allowExitOnIdle: true,
    ...(options.schema ? { schema: options.schema } : {}),
    ...(options.role ? { role: options.role } : {}),
  });
  const transcriptProjection = await createPostgresTranscriptProjection(databaseUrl, {
    ...options,
    pool,
  });
  return {
    sessionPurge: transcriptProjection,
    sessionArchivePort: createFilesystemSessionArchivePort(),
    transcriptProjection,
    transcriptSearch: transcriptProjection,
    turnRecordStore: createFilesystemTurnRecordStorePort(options.sessionsDir, {
      ...(options.automataRetentionWriteBarrier
        ? {
            assertWritable: record => options.automataRetentionWriteBarrier?.assertWritable([
              record.sessionId ?? record.channelId,
              record.channelId,
            ]),
          }
        : {}),
    }),
    turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
      pool,
      options.schema ?? 'default',
    ),
    exactSessionProjection: {
      pool,
      flushPendingWrites: () => transcriptProjection.flushPendingWrites(),
      evictChannel: channelId => transcriptProjection.evictChannel(channelId),
    },
  };
}
