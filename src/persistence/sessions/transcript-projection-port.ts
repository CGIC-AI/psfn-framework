import type { SessionEntry } from '../../core/session/types.js';

export interface SessionSearchHit {
  channelId: string;
  messageId: number;
  role: SessionEntry['role'];
  authorId?: string;
  authorName?: string;
  content: string;
  timestamp: number;
  channelVisibility: import('../../system/trust/context-envelope.js').ChannelPrivacy;
  score: number;
  snippet: string;
}

/**
 * Drift severity classes (bead 6oott).
 *
 * - `sync`: an ordinary best-effort projection write failed. The projection may
 *   be stale but serves nothing canon has redacted; search stays available.
 * - `redaction`: a redaction/tombstone-carrying mutation failed, so the
 *   projection may still hold content canon has redacted (charter Law 22/6.23).
 *   Search must fail closed for the channel until repair clears the record.
 */
export type TranscriptProjectionDriftKind = 'sync' | 'redaction';

export interface TranscriptProjectionDrift {
  channelId: string;
  kind: TranscriptProjectionDriftKind;
  reason?: string;
  markedAt: number;
}

export interface ReplaceChannelEntriesOptions {
  /**
   * Marks the replacement as redaction-driven (CogSec tombstone rewrite, turn
   * redaction). A failed redaction-driven replacement must be recorded as
   * durable `redaction` drift instead of best-effort `sync` drift.
   * Implementations must additionally infer redaction relevance when the
   * provided entries contain CogSec tombstone markers, so callers that forget
   * this flag still fail closed.
   */
  redaction?: boolean;
}

export interface TranscriptSearchOptions {
  /** Restrict hits to one projected channel/logical session. */
  channelId?: string;
}

export interface TranscriptProjectionPort {
  upsertSessionEntry(entry: SessionEntry, options?: { channelId?: string }): void;
  replaceChannelEntries(
    channelId: string,
    entries: readonly SessionEntry[],
    options?: ReplaceChannelEntriesOptions,
  ): void;
  countProjectedMessages(channelId: string): number;
  markProjectionDrift(channelId: string, reason?: string, kind?: TranscriptProjectionDriftKind): void;
  clearProjectionDrift(channelId: string): void;
  listProjectionDrift(): TranscriptProjectionDrift[];
  /**
   * Maintenance-only destructive boundary. Implementations must remove both
   * message and drift rows for exactly one channel in one transaction.
   */
  purgeChannel?(channelId: string): Promise<void>;
  flushPendingWrites?(): Promise<void>;
}

export interface KeywordSearchableTranscriptProjection extends TranscriptProjectionPort {
  searchByKeywords(query: string, limit?: number, options?: TranscriptSearchOptions): Promise<SessionSearchHit[]>;
}

export function supportsKeywordSearch(
  projection: TranscriptProjectionPort | null | undefined,
): projection is KeywordSearchableTranscriptProjection {
  return Boolean(projection && typeof (projection as KeywordSearchableTranscriptProjection).searchByKeywords === 'function');
}
