import type { SessionEntry } from '../../core/session/types.js';

/**
 * Bounded hot session tail shared across processes (psfn-framework-hgw3.5).
 *
 * JSONL journals remain the source of truth and the HMAC chain is untouched:
 * the tail holds only a bounded recent window of message entries per channel
 * so agent/gateway/garden read ONE consistent recent view instead of three
 * per-process file caches. Every write path appends through; journal rewrites
 * (CogSec tombstones, compaction invalidation/regeneration, turn tombstones)
 * invalidate the channel key rather than patching it.
 *
 * Entries serialize as plain SessionEntry JSON WITHOUT `_hmac` fields; the
 * integrity chain lives only in the journal files.
 */
export interface SessionTailCachePort {
  /** Bound enforced on append/replace (settings.json sessionTailCache.maxEntriesPerChannel). */
  readonly maxEntriesPerChannel: number;
  /** Fetch the bounded tail for a channel. Order is not guaranteed; callers normalize. */
  getTail(channelKey: string): Promise<SessionEntry[]>;
  /** Append one entry and trim the tail to the bound. */
  appendEntry(channelKey: string, entry: SessionEntry): Promise<void>;
  /** Replace the channel tail wholesale (repopulation after a miss). */
  replaceTail(channelKey: string, entries: readonly SessionEntry[]): Promise<void>;
  /** Drop the channel tail (journal rewrite/repair paths must never patch it). */
  invalidateChannel(channelKey: string): Promise<void>;
  close?(): Promise<void>;
}

const SESSION_ENTRY_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * Serialize a session entry for the tail. Defensively strips integrity fields:
 * the HMAC chain belongs to the journal file, never to the cache.
 */
export function serializeSessionTailEntry(entry: SessionEntry): string {
  const { _hmac, _hmacKeyVersion, ...rest } = entry as SessionEntry & {
    _hmac?: unknown;
    _hmacKeyVersion?: unknown;
  };
  void _hmac;
  void _hmacKeyVersion;
  return JSON.stringify(rest);
}

/** Parse a serialized tail entry. Fails closed on malformed payloads. */
export function deserializeSessionTailEntry(raw: string): SessionEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Session tail entry is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Session tail entry is not an object');
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.id !== 'number'
    || !Number.isFinite(row.id)
    || typeof row.channelId !== 'string'
    || typeof row.content !== 'string'
    || typeof row.timestamp !== 'number'
    || typeof row.role !== 'string'
    || !SESSION_ENTRY_ROLES.has(row.role)
  ) {
    throw new Error('Session tail entry is missing required SessionEntry fields');
  }
  if ('_hmac' in row || '_hmacKeyVersion' in row) {
    throw new Error('Session tail entry must not carry integrity fields');
  }
  return row as unknown as SessionEntry;
}

/**
 * Normalize a fetched tail: ascending by entry id, fail closed on duplicate
 * ids (two copies of one id means the tail absorbed a rewrite it should have
 * been invalidated for — treat the whole tail as corrupt).
 */
export function normalizeSessionTailEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const sorted = [...entries].sort((left, right) => left.id - right.id);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].id === sorted[index - 1].id) {
      throw new Error(`Session tail contains duplicate entry id ${sorted[index].id}`);
    }
  }
  return sorted;
}
