import type { JournalEntry, JournalMarkerType } from '../../core/session/types.js';
import {
  signJournalEntry,
  verifyJournalEntryIntegrity,
  type LegacyChatSourceFormat,
  type JournalIntegrityVerificationResult,
  type SessionHmacKeyring,
} from '../journals/journal-utils.js';
import type { TranscriptProjectionPort } from './transcript-projection-port.js';

export interface ChannelCache {
  channelId: string;
  entries: import('../../core/session/types.js').SessionEntry[];
  compactions: import('../../core/session/types.js').CompactionSummary[];
  turnTombstones: Set<string>;
  activeTurnTombstoneCount: number;
  nextId: number;
  lastHmac: string | null;
  lastExtractionCoveredUpTo: number;
  lastJournalEntry: JournalEntry | null;
  resolvedPath: string;
  messageCount: number;
  lastTimestamp: number;
  fullyLoaded: boolean;
}

export interface ChannelIndexEntry {
  channelId?: string;
  filename: string;
  messageCount?: number;
  activeTurnTombstoneCount?: number;
  lastTimestamp?: number;
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

export interface SessionFileSeed {
  timestamp: number;
  authorId?: string;
  authorName?: string;
}

export interface SessionStoreOptions {
  integrityProvider?: SessionIntegrityProvider | null;
  integrityKeyring?: SessionHmacKeyring | null;
  searchIndexPath?: string;
  disableSearchIndex?: boolean;
  transcriptProjection?: TranscriptProjectionPort | null;
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
export const CHANNEL_INDEX_VERSION = 3;
export const IMPORT_MANIFEST_FILENAME = '_import_manifest.jsonl';
export const IMPORT_MANIFEST_SCHEMA_VERSION = 1;
export const READABLE_SESSION_FILENAME = /^\d{8}_[a-z0-9-]+_[a-z0-9-]+_\d{6}\.jsonl$/;

/** Sanitize a channelId into a safe filename component using strict allowlist. */
export function sanitizeChannelId(channelId: string): string {
  return channelId.replace(/[^a-zA-Z0-9._-]/g, (ch) => {
    // encodeURIComponent produces %XX sequences using UTF-8 byte encoding
    // This handles multi-byte unicode correctly (e.g. € → %E2%82%AC)
    return encodeURIComponent(ch);
  });
}

/** Reverse sanitizeChannelId: decode %XX hex sequences back to original characters. */
export function unsanitizeChannelId(filename: string): string {
  return decodeURIComponent(filename);
}

export function toSlug(value: string, maxLength: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (!normalized) return 'unknown';
  const sliced = normalized.slice(0, maxLength).replace(/-+$/, '');
  return sliced || 'unknown';
}

export function formatDateUTC(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

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
    && left.messageCount === right.messageCount
    && left.activeTurnTombstoneCount === right.activeTurnTombstoneCount
    && left.lastTimestamp === right.lastTimestamp
    && left.maxId === right.maxId
    && left.lastHmac === right.lastHmac
    && left.lastExtractionCoveredUpTo === right.lastExtractionCoveredUpTo
    && left.lastJournalType === right.lastJournalType
    && left.lastMarker === right.lastMarker;
}
