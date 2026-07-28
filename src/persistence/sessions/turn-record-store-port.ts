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

export interface TurnRecordStorePort {
  appendTurnRecord(record: TurnRecord): void;
  /** Reads a page ordered oldest-to-newest, with offset counted from the newest record. */
  readRecentTurnRecords(channelId: string, limit: number, offset?: number): TurnRecord[];
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
