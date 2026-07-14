import type { SessionEntry } from '../../core/session/types.js';

/**
 * Bounded hot session tail shared across processes (psfn-framework-hgw3.5).
 *
 * JSONL journals remain the source of truth and the HMAC chain is untouched:
 * the tail holds only a bounded recent window of rows per channel so
 * agent/gateway/garden read ONE consistent recent view instead of three
 * per-process file caches.
 *
 * Rows come in two kinds:
 * - `message`: a plain SessionEntry (serialized WITHOUT `_hmac` fields; the
 *   integrity chain lives only in the journal files);
 * - `id_gap`: a placeholder for an entry id consumed by a non-message journal
 *   entry (compaction, extraction marker, tombstone, shutdown marker). Entry
 *   ids are strictly sequential per channel across ALL journal entry types,
 *   so placeholders let readers verify ID CONTIGUITY over the whole window:
 *   any hole that is not an explicit placeholder means a lost tail write
 *   (another process's append failed) and the tail must not be trusted.
 *
 * Epoch fencing (hardening of hgw3.5): every journal REWRITE (CogSec
 * tombstones, compaction invalidation/regeneration, turn tombstones, repair
 * reloads) bumps a per-channel epoch via `bumpEpoch` BEFORE the rewrite is
 * allowed to complete. Tail rows live under a key that embeds the epoch
 * current at write time, and readers resolve the current epoch on every read,
 * so a bumped epoch makes every pre-rewrite row structurally unreadable in
 * every process — cross-process invalidation without pub/sub. A failed bump
 * must fail the rewrite loudly: redaction is fail-closed.
 */
export type SessionTailRow =
  | { readonly kind: 'message'; readonly entry: SessionEntry }
  | { readonly kind: 'id_gap'; readonly id: number };

export interface SessionTailCachePort {
  /** Bound enforced on append/replace (settings.json sessionTailCache.maxEntriesPerChannel). */
  readonly maxEntriesPerChannel: number;
  /**
   * Fetch the bounded tail for a channel at the CURRENT epoch. Order is not
   * guaranteed; callers normalize/validate via `validateSessionTailWindow`.
   */
  getTail(channelKey: string): Promise<SessionTailRow[]>;
  /** Append one row at the current epoch and trim the tail to the bound. */
  appendRow(channelKey: string, row: SessionTailRow): Promise<void>;
  /** Replace the current-epoch channel tail wholesale (repopulation after a miss). */
  replaceTail(channelKey: string, rows: readonly SessionTailRow[]): Promise<void>;
  /** Drop the current-epoch channel tail (local poison cleanup before re-append). */
  invalidateChannel(channelKey: string): Promise<void>;
  /**
   * Advance the per-channel epoch, making every previously written row
   * unreadable in every process. MUST be awaited by journal rewrite paths
   * before the rewrite completes; MUST throw on failure (fail-closed
   * redaction — the caller aborts the rewrite loudly).
   */
  bumpEpoch(channelKey: string): Promise<number>;
  close?(): Promise<void>;
}

const SESSION_ENTRY_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/** Marker field distinguishing id-gap placeholder rows from message rows. */
const TAIL_GAP_MARKER_FIELD = 'psfnSessionTailGap';

/** Entry id covered by a tail row (message id or placeholder id). */
export function sessionTailRowId(row: SessionTailRow): number {
  return row.kind === 'message' ? row.entry.id : row.id;
}

/**
 * Serialize a tail row. Message rows are plain SessionEntry JSON with
 * integrity fields defensively stripped: the HMAC chain belongs to the
 * journal file, never to the cache. Gap rows carry only the marker + id.
 */
export function serializeSessionTailRow(row: SessionTailRow): string {
  if (row.kind === 'id_gap') {
    if (!Number.isInteger(row.id) || row.id < 0) {
      throw new Error('Session tail gap row requires a non-negative integer id');
    }
    return JSON.stringify({ [TAIL_GAP_MARKER_FIELD]: true, id: row.id });
  }
  const { _hmac, _hmacKeyVersion, ...rest } = row.entry as SessionEntry & {
    _hmac?: unknown;
    _hmacKeyVersion?: unknown;
  };
  void _hmac;
  void _hmacKeyVersion;
  return JSON.stringify(rest);
}

/** Parse a serialized tail row. Fails closed on malformed payloads. */
export function deserializeSessionTailRow(raw: string): SessionTailRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Session tail row is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Session tail row is not an object');
  }
  const row = parsed as Record<string, unknown>;
  if (row[TAIL_GAP_MARKER_FIELD] === true) {
    if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id < 0) {
      throw new Error('Session tail gap row is missing a valid entry id');
    }
    return { kind: 'id_gap', id: row.id };
  }
  if (
    typeof row.id !== 'number'
    || !Number.isFinite(row.id)
    || typeof row.channelId !== 'string'
    || typeof row.content !== 'string'
    || typeof row.timestamp !== 'number'
    || typeof row.role !== 'string'
    || !SESSION_ENTRY_ROLES.has(row.role)
  ) {
    throw new Error('Session tail row is missing required SessionEntry fields');
  }
  if ('_hmac' in row || '_hmacKeyVersion' in row) {
    throw new Error('Session tail row must not carry integrity fields');
  }
  return { kind: 'message', entry: row as unknown as SessionEntry };
}

/**
 * Validate a fetched tail window and extract its message entries. Fails
 * closed on:
 * - duplicate ids (two copies of one id means the tail absorbed a rewrite it
 *   should have been epoch-fenced away from — treat the whole tail as corrupt);
 * - non-contiguous ids (entry ids are strictly sequential per channel across
 *   all journal entry types, and non-message ids appear as explicit `id_gap`
 *   placeholders, so ANY hole means a lost tail write from some process — the
 *   stale-window heal cannot rely on max-id freshness alone).
 * Callers treat a throw as a miss: journal fallback + repopulation.
 */
export function validateSessionTailWindow(rows: readonly SessionTailRow[]): {
  rows: SessionTailRow[];
  messages: SessionEntry[];
  maxRowId: number | null;
} {
  const sorted = [...rows].sort((left, right) => sessionTailRowId(left) - sessionTailRowId(right));
  for (let index = 1; index < sorted.length; index += 1) {
    const previousId = sessionTailRowId(sorted[index - 1]);
    const currentId = sessionTailRowId(sorted[index]);
    if (currentId === previousId) {
      throw new Error(`Session tail contains duplicate entry id ${currentId}`);
    }
    if (currentId !== previousId + 1) {
      throw new Error(
        `Session tail has an id gap between ${previousId} and ${currentId}; a tail write was lost`,
      );
    }
  }
  const messages = sorted
    .filter((row): row is Extract<SessionTailRow, { kind: 'message' }> => row.kind === 'message')
    .map(row => row.entry);
  const maxRowId = sorted.length > 0 ? sessionTailRowId(sorted[sorted.length - 1]) : null;
  return { rows: sorted, messages, maxRowId };
}
