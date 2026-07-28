import type {
  ToolCallOutcome,
  TurnID,
  TurnRecord,
} from '../../shared/contracts/runtime.js';

/**
 * Content-free projection used by deterministic usage aggregation.
 *
 * Keeping this projection at the persistence boundary prevents callers that
 * only need timestamps and tool outcomes from retaining or redaction-resolving
 * the much larger observability/session payload of historical TurnRecords.
 */
export interface TurnRecordUsageToolCall {
  readonly toolName: string;
  readonly outcome?: ToolCallOutcome;
  readonly isError?: boolean;
}

export interface TurnRecordUsageRecord {
  readonly turnId: TurnID;
  readonly startedAt: number;
  readonly toolCalls: readonly TurnRecordUsageToolCall[];
}

/**
 * Opaque continuation for a fixed physical TurnRecord snapshot.
 *
 * Callers may persist this value only for the lifetime of the backing store.
 * Supplying no cursor explicitly starts a fresh snapshot.
 */
export type TurnRecordPageCursor = string & {
  readonly __turnRecordPageCursor: unique symbol;
};

export interface TurnRecordPage {
  /** Physical rows in ascending (oldest-first) order within this page. */
  readonly records: TurnRecord[];
  /** Present only while unread rows remain in the fixed snapshot. */
  readonly nextCursor?: TurnRecordPageCursor;
  /** True only when this page consumed the complete fixed snapshot. */
  readonly exhausted: boolean;
}

export interface TurnRecordStorePort {
  appendTurnRecord(record: TurnRecord): void;
  /** Reads the bounded newest tail ordered oldest-to-newest. */
  readRecentTurnRecords(channelId: string, limit: number): TurnRecord[];
  /**
   * Reads at most `limit` physical rows from a fixed newest-to-oldest snapshot.
   * Optional for narrow test adapters; introspection fails closed when absent.
   */
  readTurnRecordPage?(
    channelId: string,
    limit: number,
    cursor?: TurnRecordPageCursor,
  ): TurnRecordPage;
  /**
   * Reads only the content-free fields needed by tool-usage aggregation.
   * Optional for narrow test adapters; production callers fail closed when the
   * backing store cannot provide the projection.
   */
  readRecentTurnRecordUsage?(
    channelId: string,
    limit: number,
  ): TurnRecordUsageRecord[];
  /**
   * Streams normalized records without retaining a whole source archive.
   * Production startup recovery uses this async path so historical scans yield
   * to interactive traffic between small batches.
   */
  streamTurnRecordsForRecovery?(channelId: string): AsyncIterable<TurnRecord>;
  /** Counts exact identity matches up to two without retaining the source archive. */
  countTurnRecordsByTurnId?(channelId: string, turnId: string): number;
  findTurnRecord(channelId: string, turnId: string): TurnRecord | null;
}
