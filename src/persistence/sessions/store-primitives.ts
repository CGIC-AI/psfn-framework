import type { JournalEntry, JournalMarkerType, SessionEntry, SessionEntryRole } from '../../core/session/types.js';
import {
  signJournalEntry,
  verifyJournalEntryIntegrity,
  type LegacyChatSourceFormat,
  type JournalIntegrityVerificationResult,
  type SessionHmacKeyring,
} from '../journals/journal-utils.js';
import type { SessionArchivePort } from '../journals/journal/port.js';
import type { SessionTailCachePort } from './session-tail-cache-port.js';
import type { TranscriptProjectionPort } from './transcript-projection-port.js';
import type { TranscriptSearchPort } from './transcript-search-port.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import type { TurnRecordEligibilityFencePort } from './turn-record-eligibility-fence-port.js';
import type { SessionIntegrityObserver } from '../../shared/contracts/session-integrity.js';
export {
  IMPORT_MANIFEST_FILENAME,
  READABLE_SESSION_FILENAME,
  formatDateUTC,
  sanitizeChannelId,
  toSlug,
  unsanitizeChannelId,
} from './store-file-contracts.js';
export type { SessionFileSeed } from './store-file-contracts.js';

export interface ChannelCache {
  channelId: string;
  entries: import('../../core/session/types.js').SessionEntry[];
  compactions: import('../../core/session/types.js').CompactionSummary[];
  /** Physical archives known to contain at least one compaction entry. */
  compactionArchivePaths: Set<string>;
  turnTombstones: Set<string>;
  activeTurnTombstoneCount: number;
  nextId: number;
  lastHmac: string | null;
  lastExtractionCoveredUpTo: number;
  lastJournalEntry: JournalEntry | null;
  /** Ordered physical JSONL files that form this one logical session. */
  archivePaths: string[];
  /** Active (last) archive path; retained as the write-path convenience pointer. */
  resolvedPath: string;
  archiveFingerprint: string | null;
  messageCount: number;
  lastTimestamp: number;
  lastMessageTimestamp: number;
  lastMessageRole: SessionEntryRole | null;
  lastMessageAuthorName?: string;
  lastMessagePreview: string;
  fullyLoaded: boolean;
  recentEntriesByLimit: Map<number, CachedRecentEntries>;
}

export interface CachedRecentEntries {
  fingerprint: string;
  archiveFingerprint: string;
  entries: import('../../core/session/types.js').SessionEntry[];
}

export interface ChannelIndexEntry {
  channelId?: string;
  /** Active (last) file in `filenames`. */
  filename: string;
  /** Ordered physical JSONL files that form this one logical session. */
  filenames: string[];
  messageCount?: number;
  activeTurnTombstoneCount?: number;
  activeTurnTombstoneIds?: string[];
  archiveFingerprint?: string;
  compactionFilenames?: string[];
  lastTimestamp?: number;
  lastMessageTimestamp?: number;
  lastMessageRole?: SessionEntryRole | null;
  lastMessageAuthorName?: string;
  lastMessagePreview?: string;
  maxId?: number;
  lastHmac?: string | null;
  lastExtractionCoveredUpTo?: number;
  lastJournalType?: JournalEntry['type'];
  lastMarker?: JournalMarkerType;
}

export interface ChannelIndexFile {
  version: number;
  channels: Record<string, ChannelIndexEntry>;
}

export interface SessionStoreOptions {
  integrityProvider?: SessionIntegrityProvider | null;
  integrityKeyring?: SessionHmacKeyring | null;
  sessionArchivePort?: SessionArchivePort | null;
  transcriptProjection?: TranscriptProjectionPort | null;
  transcriptSearch?: TranscriptSearchPort | null;
  turnRecordStore?: TurnRecordStorePort | null;
  /**
   * Cross-process source-authority fence. PostgreSQL runtime composition
   * always supplies this; direct filesystem-only stores have no durable
   * background consumer to coordinate with.
   */
  turnRecordEligibilityFence?: TurnRecordEligibilityFencePort | null;
  /**
   * Optional bounded hot session tail shared across processes
   * (psfn-framework-hgw3.5). Null/absent keeps reads and writes byte-identical
   * to the file-only path.
   */
  tailCache?: SessionTailCachePort | null;
  /**
   * Bead ofa1: upper bound on the per-companion in-memory hot-cache of channel
   * caches. Older channels beyond this recent window are evicted and hydrated
   * on demand from the on-disk journal (which is authoritative), so agent RSS
   * no longer grows unbounded with total session count. Absent uses the store's
   * default window (~1k). Must be >= 1.
   */
  maxHotChannels?: number;
  /**
   * Bead g59z: durable-incident subscriber for session HMAC-chain verification
   * failures. When set, a full journal load that surfaces failed entries emits
   * one content-free event so Garden can record a durable, operator-visible
   * session-integrity incident. Absent keeps reads byte-identical.
   */
  integrityObserver?: SessionIntegrityObserver | null;
}

export interface SessionIntegrityProvider {
  sign(entry: JournalEntry, previousHmac: string | null): JournalEntry;
  verify(entry: JournalEntry, previousHmac: string | null): JournalIntegrityVerificationResult;
}

export function createKeyringIntegrityProvider(keyring: SessionHmacKeyring | null): SessionIntegrityProvider | null {
  if (!keyring) return null;
  return {
    sign: (entry, previousHmac) => signJournalEntry(entry, keyring, previousHmac),
    verify: (entry, previousHmac) => verifyJournalEntryIntegrity(entry, keyring, previousHmac),
  };
}

export interface CrashRecoveryExtractionCandidate {
  channelId: string;
  unextractedEntries: import('../../core/session/types.js').SessionEntry[];
  lastExtractionCoveredUpTo: number;
}

export interface LegacyChatImportRequest {
  channelId: string;
  sourcePath: string;
  defaultAuthorId?: string;
  defaultAuthorName?: string;
  defaultChannelVisibility?: string;
  resumeFromManifest?: boolean;
  metadataTag?: string;
}

export interface LegacyChatImportRange {
  sourceStartIndex: number;
  sourceEndIndex: number;
  firstEntryId: number;
  lastEntryId: number;
  messageCount: number;
}

export interface LegacyChatImportManifest {
  schemaVersion: number;
  importId: string;
  channelId: string;
  sourcePath: string;
  sourceHash: string;
  sourceFormat: LegacyChatSourceFormat;
  importedAt: number;
  resumedFromSourceIndex: number;
  nextSourceIndex: number;
  sourceRecordCount: number;
  importedRecordCount: number;
  skippedRecordCount: number;
  entryRanges: LegacyChatImportRange[];
}

export interface LegacyChatImportResult {
  manifest: LegacyChatImportManifest;
  importedEntryIds: number[];
}

export interface LegacyChatImportManifestFilter {
  channelId?: string;
  sourcePath?: string;
}

export const CHANNEL_INDEX_FILENAME = '_channel_index.json';
export const CHANNEL_INDEX_VERSION = 5;
/**
 * L0 journals roll at a fixed byte threshold. This is deliberately not a
 * mutable runtime setting: the storage contract and its verification costs
 * are byte-denominated, and every deployment should share the same bound.
 */
export const L0_SESSION_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const IMPORT_MANIFEST_SCHEMA_VERSION = 1;
export function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function normalizeOptionalHmac(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  return value;
}

export function normalizeOptionalJournalType(value: unknown): JournalEntry['type'] | undefined {
  if (value === 'message' || value === 'compaction' || value === 'marker' || value === 'tombstone') {
    return value;
  }
  return undefined;
}

export function normalizeOptionalSessionEntryRole(value: unknown): SessionEntryRole | null | undefined {
  if (value == null) return null;
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool') {
    return value;
  }
  return undefined;
}

/**
 * A session entry role is "previewable" only when it represents a conversational
 * turn (user or assistant). System/tool scaffold entries are never surfaced in
 * lastMessagePreview/lastMessageRole, so they must not leak into session-list
 * rows or activity summaries.
 */
export function isPreviewableSessionEntryRole(value: unknown): boolean {
  const role = normalizeOptionalSessionEntryRole(value);
  return role === 'user' || role === 'assistant';
}

/**
 * Return the most recent conversational (user/assistant) entry, scanning from
 * the tail, or undefined when the run holds only system/tool scaffold entries.
 */
export function findLastPreviewableEntry(
  entries: readonly SessionEntry[],
): SessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (isPreviewableSessionEntryRole(entry.role)) return entry;
  }
  return undefined;
}

export function normalizeOptionalMarker(value: unknown): JournalMarkerType | undefined {
  if (value === 'extraction' || value === 'graceful_shutdown') {
    return value;
  }
  return undefined;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized;
}

function normalizeOptionalRange(value: unknown): LegacyChatImportRange | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const sourceStartIndex = normalizeOptionalNonNegativeNumber(row.sourceStartIndex);
  const sourceEndIndex = normalizeOptionalNonNegativeNumber(row.sourceEndIndex);
  const firstEntryId = normalizeOptionalNonNegativeNumber(row.firstEntryId);
  const lastEntryId = normalizeOptionalNonNegativeNumber(row.lastEntryId);
  const messageCount = normalizeOptionalNonNegativeNumber(row.messageCount);
  if (
    sourceStartIndex === undefined
    || sourceEndIndex === undefined
    || firstEntryId === undefined
    || lastEntryId === undefined
    || messageCount === undefined
  ) {
    return null;
  }

  return {
    sourceStartIndex,
    sourceEndIndex,
    firstEntryId,
    lastEntryId,
    messageCount,
  };
}

export function parseImportManifestLine(line: string): LegacyChatImportManifest | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;

    const schemaVersion = normalizeOptionalNonNegativeNumber(row.schemaVersion);
    const channelId = normalizeOptionalString(row.channelId);
    const sourcePath = normalizeOptionalString(row.sourcePath);
    const sourceHash = normalizeOptionalString(row.sourceHash);
    const sourceFormat = row.sourceFormat;
    const importId = normalizeOptionalString(row.importId);
    const importedAt = normalizeOptionalNonNegativeNumber(row.importedAt);
    const resumedFromSourceIndex = normalizeOptionalNonNegativeNumber(row.resumedFromSourceIndex);
    const nextSourceIndex = normalizeOptionalNonNegativeNumber(row.nextSourceIndex);
    const sourceRecordCount = normalizeOptionalNonNegativeNumber(row.sourceRecordCount);
    const importedRecordCount = normalizeOptionalNonNegativeNumber(row.importedRecordCount);
    const skippedRecordCount = normalizeOptionalNonNegativeNumber(row.skippedRecordCount);

    if (
      schemaVersion === undefined
      || !channelId
      || !sourcePath
      || !sourceHash
      || !importId
      || importedAt === undefined
      || resumedFromSourceIndex === undefined
      || nextSourceIndex === undefined
      || sourceRecordCount === undefined
      || importedRecordCount === undefined
      || skippedRecordCount === undefined
    ) {
      return null;
    }

    if (sourceFormat !== 'jsonl' && sourceFormat !== 'json-array' && sourceFormat !== 'json-messages') {
      return null;
    }

    const rangesRaw = Array.isArray(row.entryRanges) ? row.entryRanges : [];
    const entryRanges = rangesRaw
      .map(candidate => normalizeOptionalRange(candidate))
      .filter((candidate): candidate is LegacyChatImportRange => candidate !== null);

    return {
      schemaVersion,
      importId,
      channelId,
      sourcePath,
      sourceHash,
      sourceFormat,
      importedAt,
      resumedFromSourceIndex,
      nextSourceIndex,
      sourceRecordCount,
      importedRecordCount,
      skippedRecordCount,
      entryRanges,
    };
  } catch {
    return null;
  }
}

export function channelIndexEntryEquals(left: ChannelIndexEntry | undefined, right: ChannelIndexEntry): boolean {
  if (!left) return false;
  return left.filename === right.filename
    && left.filenames.length === right.filenames.length
    && left.filenames.every((filename, index) => filename === right.filenames[index])
    && left.messageCount === right.messageCount
    && left.activeTurnTombstoneCount === right.activeTurnTombstoneCount
    && JSON.stringify(left.activeTurnTombstoneIds ?? []) === JSON.stringify(right.activeTurnTombstoneIds ?? [])
    && left.archiveFingerprint === right.archiveFingerprint
    && JSON.stringify(left.compactionFilenames ?? []) === JSON.stringify(right.compactionFilenames ?? [])
    && left.lastTimestamp === right.lastTimestamp
    && left.lastMessageTimestamp === right.lastMessageTimestamp
    && left.lastMessageRole === right.lastMessageRole
    && left.lastMessageAuthorName === right.lastMessageAuthorName
    && left.lastMessagePreview === right.lastMessagePreview
    && left.maxId === right.maxId
    && left.lastHmac === right.lastHmac
    && left.lastExtractionCoveredUpTo === right.lastExtractionCoveredUpTo
    && left.lastJournalType === right.lastJournalType
    && left.lastMarker === right.lastMarker;
}
