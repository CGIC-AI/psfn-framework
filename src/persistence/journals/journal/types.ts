import type { JournalEntry, JournalMarkerType } from '../../../core/session/types.js';

export interface QuarantinedJournalEntry {
  lineNumber: number;
  error: string;
  raw: string;
}

export interface ReadJournalResult {
  entries: JournalEntry[];
  maxId: number;
  quarantined: QuarantinedJournalEntry[];
}

export interface ReadJournalFileOptions {
  persistQuarantine?: boolean;
}

export interface ScanJournalMetadataOptions {
  persistQuarantine?: boolean;
}

export interface JournalFileMetadata {
  entryCount: number;
  minId: number;
  maxId: number;
  messageCount: number;
  compactionCount: number;
  turnTombstoneCount: number;
  activeTurnTombstoneCount: number;
  activeTurnTombstoneIds: string[];
  lastTimestamp: number;
  lastHmac: string | null;
  lastEntry: JournalEntry | null;
  lastExtractionCoveredUpTo: number;
  quarantined: QuarantinedJournalEntry[];
}

export interface ReadJournalTailOptions {
  messageLimit: number;
  includeBoundaryEntry?: boolean;
}

export interface ReadJournalTailResult {
  entries: JournalEntry[];
  quarantined: QuarantinedJournalEntry[];
  truncated: boolean;
}

export interface ReadJournalMatchingOptions {
  limit: number;
  matches: (entry: JournalEntry) => boolean;
  /**
   * Stop after this entry has supplied any pending integrity-chain boundary.
   * Backward range readers use this once monotonically increasing entry IDs
   * have passed below their requested window.
   */
  stopAfter?: (entry: JournalEntry) => boolean;
}

export interface JournalBackwardMatch {
  entry: JournalEntry;
  previousHmac: string | null;
}

export interface ReadJournalMatchingResult {
  matches: JournalBackwardMatch[];
  quarantined: QuarantinedJournalEntry[];
}
export interface JournalBoundedReadStats {
  bytesRead: number;
  readCalls: number;
  filesRead: number;
  /** Maximum physical seek-row bytes retained by one cooperative read. */
  maxRetainedLineBytes?: number;
  /** Explicit event-loop yields completed while locating a journal window. */
  eventLoopYields?: number;
}

export interface ReadJournalBeforeOptions {
  beforeId: number;
  messageLimit: number;
  includeBoundaryEntry?: boolean;
  scanChunkBytes?: number;
  stats?: JournalBoundedReadStats;
  /** A sampled id may exclude bytes only when its HMAC boundary is trusted. */
  trustSeekEntry?: (entry: JournalEntry, previousHmac: string | null) => boolean;
  /** HMAC immediately preceding this physical file in the logical chain. */
  previousFileHmac?: string | null;
}

export interface ReadJournalBeforeResult {
  entries: JournalEntry[];
  quarantined: QuarantinedJournalEntry[];
  truncated: boolean;
}

export interface SessionHmacKeyring {
  activeVersion: string;
  keys: Record<string, string>;
}

export interface SessionHmacKeyringInput {
  serializedKeys?: string;
  singleKey?: string;
  activeVersion?: string;
  defaultVersion?: string;
}

export interface JournalIntegrityVerificationResult {
  verified: boolean;
  observedHmac: string | null;
  expectedHmac?: string | null;
  reason?: string;
}

export interface JournalMarkerEntry {
  id: number;
  channelId: string;
  marker: JournalMarkerType;
  timestamp: number;
  coveredUpTo?: number;
}

export interface JournalTurnTombstoneEntry {
  id: number;
  channelId: string;
  targetType: 'turn';
  targetId: string;
  action: 'redact' | 'restore';
  timestamp: number;
  actor?: string;
  reason?: string;
}

export interface LegacyChatSourceRecord {
  sourceIndex: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  authorId?: string;
  authorName?: string;
  metadata?: string;
  originChannelId?: string;
  channelVisibility?: string;
}

export type LegacyChatSourceFormat = 'jsonl' | 'json-array' | 'json-messages';

export interface ParsedLegacyChatSource {
  format: LegacyChatSourceFormat;
  sourceHash: string;
  records: LegacyChatSourceRecord[];
}
