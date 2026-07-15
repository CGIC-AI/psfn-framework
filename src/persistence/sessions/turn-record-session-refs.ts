import { isRecord } from '../../shared/utils/types.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { isCogSecTombstoneContent, isCogSecInvalidatedSummaryContent } from '../../core/cogsec/tombstones.js';

/**
 * Turn-record session-entry diet (bead psfn-framework-9ree).
 *
 * A turn record used to persist the conversation TWICE: the raw L0 session
 * entries (`sessionContext.recentEntries` / `.continuityEntries`, verbatim
 * `SessionEntry[]`) AND the rendered `plan.messages`. The raw copies doubled the
 * per-turn payload AND — because they froze L0 content at capture time — meant a
 * later CogSec redaction of an L0 entry did NOT propagate to the persisted turn
 * record: the old verbatim text was resurrected on read.
 *
 * Scope: this module deduplicates `sessionContext.recentEntries` — the raw L0
 * window in the TURN'S OWN channel. `continuityEntries` is deliberately left
 * inline: continuity spans OTHER channels' journals that the reading store is
 * not guaranteed to be able to re-read (a continuity entry can originate in a
 * session that is never loaded here), so id-range reconstruction would silently
 * drop it. Its dedup is a separate follow-up.
 *
 * This module replaces the verbatim `recentEntries` array with L0 entry-id
 * references and reconstructs it from the journal at the persistence read
 * boundary, so:
 * - the session journal (L0) is the single durable source of the conversation;
 * - a redacted / tombstoned / rolled-off L0 entry can NEVER be resurrected from
 *   the turn record — reconstruction only ever surfaces the journal's CURRENT
 *   truth (redaction marker, or the entry is simply gone);
 * - the rendered view (`plan.messages`, the Loom conversation) is redaction-
 *   gated at read time via each message's `provenance.sourceEntryIds`.
 *
 * Redaction-safety invariant: verbatim `SessionEntry.content` is stored ONLY for
 * entries that have no resolvable positive L0 id (a "divergence delta" — e.g. a
 * synthetic entry that never lived in the journal, so it is not CogSec-redactable
 * L0 content). Every entry with a real L0 id is stored as a bare id and re-read
 * from the journal, so redaction authority stays with L0.
 *
 * Convention parity with the content-addressed sidecars
 * (turn-record-shared-store.ts): an inline field `X` is replaced by a sibling
 * `XRef`; old fat records lack the ref and pass through untouched; a record that
 * carries BOTH the inline field and the ref is ambiguous and fails closed. The
 * one documented deviation: unlike the immutable content-addressed sidecars
 * (dangling ref = fail closed), an L0 entry that is legitimately absent on
 * re-read (redacted-as-tombstone / tombstoned / rolled off by L0 rolling) is
 * EXPECTED and heals (the entry is dropped) rather than throwing — L0 entries
 * are mutable/erasable by design. Only STRUCTURAL corruption of the ref shape
 * (checkable without any journal read) fails closed.
 *
 * These refs are L0-coupled (reconstruction needs the HMAC-verified journal
 * range reader), so — unlike the self-contained sidecars that resolve inside the
 * turn-record store port — the slim/resolve seam lives in the SessionManager
 * store, which owns `getEntriesInRange` and tombstone authority.
 */

/** Persisted field replacing inline `sessionContext.recentEntries`. */
export const RECENT_ENTRIES_REF_FIELD = 'recentEntriesRef';
/** Ref schema version; a future incompatible shape bumps this. */
export const SESSION_ENTRIES_REF_VERSION = 1 as const;

/** Placeholder shown in the rendered view for a message whose backing L0 entry was redacted or removed. */
export const REDACTED_MESSAGE_PLACEHOLDER = '[redacted: source entry removed from the session journal]';

/**
 * Resolve an inclusive L0 entry-id range for a channel through the HMAC-verified
 * journal reader (applies CogSec tombstones + redaction). Entries legitimately
 * absent from the journal are simply omitted from the result.
 */
export type SessionEntryRangeResolver = (
  channelId: string,
  minId: number,
  maxId: number,
) => SessionEntry[];

interface RecentEntryDelta {
  delta: SessionEntry;
}

/** Ordered items: a bare L0 id (re-read from `channelId`) or an inline divergence delta. */
type RecentEntryRefItem = number | RecentEntryDelta;

interface RecentEntriesRef {
  v: typeof SESSION_ENTRIES_REF_VERSION;
  channelId: string;
  items: RecentEntryRefItem[];
}

function isRedactedContent(content: unknown): boolean {
  return typeof content === 'string'
    && (isCogSecTombstoneContent(content) || isCogSecInvalidatedSummaryContent(content));
}

function isValidL0Id(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function readSessionContext(record: TurnRecord): Record<string, unknown> | undefined {
  const snapshot = record.observability?.snapshot;
  if (!snapshot || !isRecord(snapshot.sessionContext)) return undefined;
  return snapshot.sessionContext as unknown as Record<string, unknown>;
}

function withSessionContext(record: TurnRecord, sessionContext: Record<string, unknown>): TurnRecord {
  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        sessionContext: sessionContext as unknown as NonNullable<typeof snapshot.sessionContext>,
      },
    },
  };
}

function cloneEntry(entry: SessionEntry): SessionEntry {
  return { ...entry };
}

// ── recentEntries ────────────────────────────────────────────────────────────

/**
 * Persist projection: replace non-empty inline `sessionContext.recentEntries`
 * with `recentEntriesRef` (bare L0 ids + inline divergence deltas for entries
 * with no resolvable positive id). Skips records with no recentEntries, an empty
 * array, or no id-backed entry to reference (nothing to save). The input record
 * is not mutated.
 */
export function slimTurnRecordRecentEntriesForAppend(record: TurnRecord): TurnRecord {
  const sessionContext = readSessionContext(record);
  const recentEntries = sessionContext?.recentEntries;
  if (!sessionContext || !Array.isArray(recentEntries) || recentEntries.length === 0) {
    return record;
  }
  const channelId = typeof sessionContext.channelId === 'string' ? sessionContext.channelId : '';
  if (channelId.length === 0) return record;
  const items: RecentEntryRefItem[] = recentEntries.map((entry) => {
    if (isRecord(entry) && isValidL0Id(entry.id)) {
      return entry.id;
    }
    // Not L0-backed (no positive journal id): keep inline as a divergence delta.
    // This is never CogSec-redactable L0 content, so storing it verbatim is safe.
    return { delta: cloneEntry(entry as SessionEntry) };
  });
  // Nothing to save unless at least one entry became a bare id reference.
  if (!items.some(item => typeof item === 'number')) return record;
  const ref: RecentEntriesRef = { v: SESSION_ENTRIES_REF_VERSION, channelId, items };
  const { recentEntries: _inline, ...rest } = sessionContext;
  return withSessionContext(record, { ...rest, [RECENT_ENTRIES_REF_FIELD]: ref });
}

function parseRecentEntriesRef(value: unknown): RecentEntriesRef {
  if (!isRecord(value)) {
    throw new Error(`TurnRecord "${RECENT_ENTRIES_REF_FIELD}" must be an object`);
  }
  if (value.v !== SESSION_ENTRIES_REF_VERSION) {
    throw new Error(`TurnRecord "${RECENT_ENTRIES_REF_FIELD}.v" must be ${SESSION_ENTRIES_REF_VERSION}`);
  }
  if (typeof value.channelId !== 'string' || value.channelId.length === 0) {
    throw new Error(`TurnRecord "${RECENT_ENTRIES_REF_FIELD}.channelId" must be a non-empty string`);
  }
  if (!Array.isArray(value.items)) {
    throw new Error(`TurnRecord "${RECENT_ENTRIES_REF_FIELD}.items" must be an array`);
  }
  for (const item of value.items) {
    if (typeof item === 'number') {
      if (!isValidL0Id(item)) {
        throw new Error(`TurnRecord "${RECENT_ENTRIES_REF_FIELD}.items" id must be a positive integer`);
      }
    } else if (!isRecord(item) || !isRecord(item.delta)) {
      throw new Error(`TurnRecord "${RECENT_ENTRIES_REF_FIELD}.items" entry must be an id or an inline delta`);
    }
  }
  return value as unknown as RecentEntriesRef;
}

/**
 * Read inverse for `recentEntriesRef`: reconstruct `sessionContext.recentEntries`
 * from the L0 journal. Fail closed on a structurally corrupt ref or an ambiguous
 * ref+inline record; heal (drop the entry) when an id-backed entry is
 * legitimately absent on re-read — that IS the redaction/rolloff suppression.
 * Records without the ref pass through untouched.
 */
function resolveRecentEntries(record: TurnRecord, resolve: SessionEntryRangeResolver): TurnRecord {
  const sessionContext = readSessionContext(record);
  const rawRef = sessionContext?.[RECENT_ENTRIES_REF_FIELD];
  if (!sessionContext || rawRef === undefined) return record;
  if (sessionContext.recentEntries !== undefined) {
    throw new Error(
      `TurnRecord sessionContext carries both inline recentEntries and ${RECENT_ENTRIES_REF_FIELD}`,
    );
  }
  const ref = parseRecentEntriesRef(rawRef);
  const ids = ref.items.filter((item): item is number => typeof item === 'number');
  const byId = new Map<number, SessionEntry>();
  if (ids.length > 0) {
    const min = Math.min(...ids);
    const max = Math.max(...ids);
    for (const entry of resolve(ref.channelId, min, max)) {
      byId.set(entry.id, entry);
    }
  }
  const recentEntries: SessionEntry[] = [];
  for (const item of ref.items) {
    if (typeof item === 'number') {
      const resolved = byId.get(item);
      if (resolved) recentEntries.push(resolved); // absent → dropped (redacted/tombstoned/rolled-off)
    } else {
      recentEntries.push(item.delta);
    }
  }
  const { [RECENT_ENTRIES_REF_FIELD]: _ref, ...rest } = sessionContext;
  return withSessionContext(record, { ...rest, recentEntries });
}

// ── plan.messages redaction gating ───────────────────────────────────────────

function readPlanMessages(record: TurnRecord): Record<string, unknown>[] | undefined {
  const snapshot = record.observability?.snapshot;
  const plan = snapshot?.plan;
  if (!isRecord(plan) || !Array.isArray(plan.messages)) return undefined;
  return plan.messages as unknown as Record<string, unknown>[];
}

function messageSourceEntryIds(message: Record<string, unknown>): number[] {
  const provenance = message.provenance;
  if (!isRecord(provenance) || !Array.isArray(provenance.sourceEntryIds)) return [];
  return provenance.sourceEntryIds.filter(isValidL0Id);
}

/**
 * Redaction-gate the rendered view (`plan.messages`). Each entry-backed message
 * carries `provenance.sourceEntryIds` (turn-channel id-space). If ANY backing
 * entry is now absent from L0 (tombstoned / rolled off) or resolves to a CogSec
 * redaction marker, the whole message content is masked — a merged multi-id
 * message cannot be partially rebuilt, so masking is the conservative, correct
 * choice. Synthetic messages with no `sourceEntryIds` (e.g. history-compaction
 * summaries, which hold non-verbatim summarized text) pass through. Applied to
 * every record, including old fat records, so redaction propagates uniformly.
 */
function gatePlanMessages(record: TurnRecord, resolve: SessionEntryRangeResolver): TurnRecord {
  const messages = readPlanMessages(record);
  if (!messages || messages.length === 0) return record;
  const sessionContext = readSessionContext(record);
  const channelId = (typeof sessionContext?.channelId === 'string' && sessionContext.channelId.length > 0)
    ? sessionContext.channelId
    : record.channelId;
  if (typeof channelId !== 'string' || channelId.length === 0) return record;

  const allIds = new Set<number>();
  for (const message of messages) {
    for (const id of messageSourceEntryIds(message)) allIds.add(id);
  }
  if (allIds.size === 0) return record;

  const ids = [...allIds];
  const live = new Map<number, SessionEntry>();
  for (const entry of resolve(channelId, Math.min(...ids), Math.max(...ids))) {
    live.set(entry.id, entry);
  }

  const gated = messages.map((message) => {
    const sourceIds = messageSourceEntryIds(message);
    if (sourceIds.length === 0) return message;
    const suppressed = sourceIds.some((id) => {
      const entry = live.get(id);
      return entry === undefined || isRedactedContent(entry.content);
    });
    if (!suppressed) return message;
    return { ...message, content: REDACTED_MESSAGE_PLACEHOLDER };
  });
  // Masking allocates a fresh object per message; identity change ⇒ mutation.
  if (!gated.some((message, index) => message !== messages[index])) return record;

  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  const plan = snapshot.plan as unknown as Record<string, unknown>;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        plan: { ...plan, messages: gated } as unknown as NonNullable<typeof snapshot.plan>,
      },
    },
  };
}

// ── public seam ──────────────────────────────────────────────────────────────

/**
 * Write-side projection: replace the verbatim `recentEntries` array with an L0
 * id reference before the record is appended. Pure (no journal access); the
 * input record is not mutated.
 */
export function slimTurnRecordSessionEntriesForAppend(record: TurnRecord): TurnRecord {
  return slimTurnRecordRecentEntriesForAppend(record);
}

/**
 * Read-side resolution applied at the SessionManager store boundary: reconstruct
 * `recentEntries` from L0 and redaction-gate `plan.messages`, making the diet
 * transparent to every consumer above persistence (Garden Loom, session-turn
 * observability, introspection auditing).
 */
export function resolveTurnRecordSessionEntries(
  record: TurnRecord,
  resolve: SessionEntryRangeResolver,
): TurnRecord {
  return gatePlanMessages(
    resolveRecentEntries(record, resolve),
    resolve,
  );
}
