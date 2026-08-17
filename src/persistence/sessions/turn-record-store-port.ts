import type {
  ToolCallOutcome,
  TurnID,
  TurnRecord,
} from '../../shared/contracts/runtime.js';
import type {
  TurnRecordRecoveryEvidenceSkip,
} from '../../core/agent/background-work/recovery-contract.js';

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

/**
 * One generation-stable answer for an exact physical-channel + TurnID lookup.
 *
 * Callers must not reconstruct this result with separate count/find operations:
 * doing so admits a mutation between the two observations. `duplicated` is a
 * first-class fail-closed state rather than an arbitrary selected record.
 */
export type TurnRecordIdentityLookup =
  | { readonly kind: 'missing' }
  | { readonly kind: 'duplicated' }
  | { readonly kind: 'unique'; readonly record: TurnRecord };

export interface TurnRecordIdentityLookupOptions {
  signal?: AbortSignal;
}

export interface TurnRecordRecoveryScanStats {
  bytesRead: number;
  rowsScanned: number;
  filesScanned: number;
  candidatesYielded: number;
  peakIdentityRowsInMemory: number;
  sqliteCacheBytes: number;
  maxRowBytes: number;
  /** Exact pre-drift emotion appraisal jobs validated and retired during live-alpha repair. */
  legacyEmotionAppraisalJobsRetired?: number;
  /** Structurally invalid TurnRecord rows skipped after durable content-free quarantine. */
  quarantinedTurnRecordRows?: number;
  authorityActionsReturned?: number;
  authorityBytesRead?: number;
  authorityFilesScanned?: number;
  authorityMainMessageBytesRetained?: number;
  authorityOwnersScanned?: number;
  authorityPeakOpenFilesOffPrimary?: number;
  authorityPeakCachedOwners?: number;
  authorityPeakCachedTombstones?: number;
  authorityPeakResultBytes?: number;
  authorityPeakRowBytesOffPrimary?: number;
  authorityRowsScanned?: number;
}

export interface TurnRecordRecoveryScanOptions {
  onEvidenceOwnerSkipped?: (skip: TurnRecordRecoveryEvidenceSkip) => void;
  signal?: AbortSignal;
  stats?: TurnRecordRecoveryScanStats;
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
  ): Promise<TurnRecordPage>;
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
   * Streams exact-unique recovery candidates from one physical snapshot,
   * globally ordered by completedAt/turnId. Before yielding, implementations
   * must validate every semantic handoff binding against the complete source
   * row, then strip user/assistant content from the returned TurnRecord.
   * Identity state stays out of process memory and cancellation closes the
   * snapshot promptly.
   */
  streamTurnRecordsForRecovery?(
    channelIds: readonly string[],
    options?: TurnRecordRecoveryScanOptions,
  ): AsyncIterable<TurnRecord>;
  /**
   * Resolves an exact identity from one snapshot without retaining or
   * normalizing unrelated historical bodies.
   */
  lookupTurnRecordIdentity?(
    channelId: string,
    turnId: string,
    options?: TurnRecordIdentityLookupOptions,
  ): Promise<TurnRecordIdentityLookup>;
  findTurnRecord(channelId: string, turnId: string): TurnRecord | null;
}
