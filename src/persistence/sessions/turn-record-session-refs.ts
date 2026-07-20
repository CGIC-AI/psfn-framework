import { isRecord, toRecordView } from '../../shared/utils/types.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { isCogSecTombstoneContent, isCogSecInvalidatedSummaryContent } from '../../core/cogsec/tombstones.js';
import {
  REDACTED_SESSION_ENTRY_PLACEHOLDER,
  resolveContinuityEntryContent,
  type ContinuityEntryWithheldReason,
} from '../../core/session/continuity-redaction.js';
import { restoreSnapshotSection } from './turn-record-snapshot-view.js';

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
 * window in the TURN'S OWN channel. `continuityEntries` stays inline because
 * each item belongs to a different secondary continuity index, but its frozen
 * content is redaction-gated against the immutable origin L0 reference stamped
 * into continuity provenance (bead psfn-framework-ervg).
 *
 * This module replaces the verbatim `recentEntries` array with L0 entry-id
 * references and reconstructs it from the journal at the persistence read
 * boundary, so:
 * - the session journal (L0) is the single durable source of the conversation;
 * - a redacted / tombstoned / rolled-off L0 entry can NEVER be resurrected from
 *   the turn record — reconstruction only ever surfaces the journal's CURRENT
 *   truth (redaction marker, or the entry is simply gone). This holds for
 *   records of ANY vintage: new ref-backed records reconstruct `recentEntries`
 *   from L0, and pre-9ree "old fat" records (inline `recentEntries`, no ref)
 *   are redaction-gated against L0 at read time (bead psfn-framework-hgw3.10) so
 *   their frozen inline plaintext can never outlive an L0 redaction either;
 * - the rendered view (`plan.messages`, the Loom conversation) is redaction-
 *   gated at read time via each message's `provenance.sourceEntryIds`;
 * - the captured provider wire body (Loom "Raw Wire Body", bead
 *   psfn-framework-eb14) is withheld at read time when any SAME-CHANNEL,
 *   entry-backed L0 content it serialized is redacted/absent — its
 *   `plan.messages` history AND the current turn's own partner entry (see
 *   gateRenderedViews).
 *
 * Cross-channel continuity is resolved through the same range-reader seam using
 * each continuity row's source session + source L0 id. Legacy rows without that
 * immutable id, malformed refs, absent/redacted source entries, identity
 * mismatches, and resolver errors all heal to a redaction notice rather than
 * serving frozen content. The same decision masks persisted Loom prompt views
 * and withholds captured provider wire bodies.
 *
 * Redaction-safety invariant: verbatim `SessionEntry.content` is stored ONLY for
 * entries that have no resolvable positive L0 id (a "divergence delta" — e.g. a
 * synthetic entry that never lived in the journal, so it is not CogSec-redactable
 * L0 content). Every entry with a real L0 id is stored as a bare id and re-read
 * from the journal, so redaction authority stays with L0.
 *
 * Convention parity with the content-addressed sidecars
 * (turn-record-shared-store.ts): an inline field `X` is replaced by a sibling
 * `XRef`; old fat records lack the ref and pass through untouched for the diet
 * (their bodies stay on disk); a record that
 * carries BOTH the inline field and the ref is ambiguous and fails closed. The
 * one redaction-safety exception to "pass through untouched": an old fat
 * record's inline `recentEntries` is still redaction-gated against L0 on read
 * (see gateInlineRecentEntries), because leaving frozen L0 plaintext ungated
 * would resurrect a since-redacted entry — the exact pathology this epic closes.
 * The one documented deviation: unlike the immutable content-addressed sidecars
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
export const REDACTED_MESSAGE_PLACEHOLDER = REDACTED_SESSION_ENTRY_PLACEHOLDER;

/**
 * Discriminant stamped on a captured provider wire body that has been withheld
 * because a source L0 entry it embedded was redacted/removed (bead
 * psfn-framework-eb14). The raw provider request body is structured JSON whose
 * `messages`/`system` embed rendered conversation content; a merged, provider-
 * transformed body cannot be partially rebuilt, so the whole body is replaced
 * with this marker — mirroring gatePlanMessages' conservative whole-message
 * masking. The safe summary metadata (api/model/byteLength/toolCount) stays.
 */
export const WITHHELD_WIRE_BODY_MARKER = 'cogsec-redaction' as const;

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

/**
 * Structured heal-drop signal: an id-backed `recentEntries` item resolved to
 * ABSENT from L0 (redacted-as-tombstone / tombstoned / rolled-off) and was
 * dropped rather than resurrected. Emitted for BOTH ref-backed records and
 * pre-9ree inline "old fat" records so operators can distinguish a legitimate
 * redaction/rolloff drop from ref corruption that happened to parse (structural
 * corruption fails closed upstream and never reaches this signal). A surfaced
 * CogSec redaction marker is NOT a drop — the entry is present and the journal's
 * current truth is shown — so it is deliberately not reported here.
 */
export interface TurnRecordRecentEntryHealDrop {
  /** Turn-channel id-space the dropped entry belonged to. */
  channelId: string;
  /** The L0 entry id that could not be re-read. */
  entryId: number;
  /** Storage vintage that produced the drop. */
  source: 'ref-backed' | 'inline-old-fat';
  /** Owning turn record, for audit correlation. */
  turnId: string;
}

/** Sink for {@link TurnRecordRecentEntryHealDrop} events; wired to store telemetry. */
export type TurnRecordHealDropSink = (drop: TurnRecordRecentEntryHealDrop) => void;

/**
 * Structured signal (bead psfn-framework-eb14): a captured provider wire body was
 * withheld on read because a source L0 entry it embedded is now absent/redacted.
 * Emitted so operators can see redaction propagating into the observability wire
 * surface, mirroring {@link TurnRecordRecentEntryHealDrop}.
 */
export interface TurnRecordWireBodyWithheld {
  /** Turn-channel id-space whose L0 redaction triggered the withhold. */
  channelId: string;
  /** Owning turn record, for audit correlation. */
  turnId: string;
}

/** Sink for {@link TurnRecordWireBodyWithheld} events; wired to store telemetry. */
export type TurnRecordWireBodyWithheldSink = (event: TurnRecordWireBodyWithheld) => void;

/** Top-level frozen turn-message copy withheld after its backing L0 row changed. */
export interface TurnRecordMessageWithheld {
  channelId: string;
  entryId: number;
  surface: 'userMessage' | 'assistantMessage';
  turnId: string;
}

/** Sink for top-level user/assistant message withholding (bead sm9l). */
export type TurnRecordMessageWithheldSink = (event: TurnRecordMessageWithheld) => void;

export type TurnRecordContinuityWithheldReason = ContinuityEntryWithheldReason;

/** Cross-channel continuity copy withheld at the turn-record read boundary. */
export interface TurnRecordContinuityWithheld {
  channelId: string;
  sourceChannelId: string;
  sourceEntryId?: number;
  reason: TurnRecordContinuityWithheldReason;
  turnId: string;
}

/** Sink for cross-channel continuity heal-withhold events (bead psfn-framework-ervg). */
export type TurnRecordContinuityWithheldSink = (event: TurnRecordContinuityWithheld) => void;

/**
 * Outcome of the `recentEntries` L0 resolution pass. `windowRedactionDetected`
 * is true when ANY id-backed entry in the record's recentEntries window resolved
 * to a CogSec redaction marker or was absent on re-read (heal-dropped) — the same
 * single L0 range read that reconstructs the window. It is threaded into the
 * wire-body withhold decision (bead psfn-framework-eb14) so a captured wire body
 * is withheld whenever the L0 window it serialized shows any redaction/absence,
 * not only when a `plan.messages` provenance id was suppressed.
 */
interface RecentEntriesResolution {
  record: TurnRecord;
  windowRedactionDetected: boolean;
}

interface ContinuityEntriesResolution {
  record: TurnRecord;
  redactionDetected: boolean;
}

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
  return snapshot.sessionContext;
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
        sessionContext: restoreSnapshotSection(sessionContext),
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
 * ref+inline record; heal (drop the entry, emitting a telemetry signal) when an
 * id-backed entry is legitimately absent on re-read — that IS the
 * redaction/rolloff suppression. A record with NO ref is a pre-9ree "old fat"
 * record; its inline `recentEntries` is redaction-gated against L0 instead of
 * passed through (bead psfn-framework-hgw3.10).
 */
function resolveRecentEntries(
  record: TurnRecord,
  resolve: SessionEntryRangeResolver,
  onHealDrop?: TurnRecordHealDropSink,
): RecentEntriesResolution {
  const sessionContext = readSessionContext(record);
  if (!sessionContext) return { record, windowRedactionDetected: false };
  const rawRef = sessionContext[RECENT_ENTRIES_REF_FIELD];
  if (rawRef === undefined) {
    return gateInlineRecentEntries(record, sessionContext, resolve, onHealDrop);
  }
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
  let windowRedactionDetected = false;
  for (const item of ref.items) {
    if (typeof item === 'number') {
      const resolved = byId.get(item);
      if (resolved) {
        recentEntries.push(resolved);
        // Present but redacted: the journal's current truth is a CogSec marker.
        if (isRedactedContent(resolved.content)) windowRedactionDetected = true;
      } else {
        // absent → dropped (redacted-as-tombstone / tombstoned / rolled-off)
        windowRedactionDetected = true;
        onHealDrop?.({ channelId: ref.channelId, entryId: item, source: 'ref-backed', turnId: record.turnId });
      }
    } else {
      recentEntries.push(item.delta);
    }
  }
  const { [RECENT_ENTRIES_REF_FIELD]: _ref, ...rest } = sessionContext;
  return {
    record: withSessionContext(record, { ...rest, recentEntries }),
    windowRedactionDetected,
  };
}

/**
 * Redaction-gate the inline `recentEntries` of a pre-9ree "old fat" record (no
 * `recentEntriesRef`). Symmetric with both the ref-backed path above and
 * gatePlanMessages: each entry carrying a real positive L0 id is re-read from
 * the journal and REPLACED with the journal's current truth — a since-redacted
 * entry surfaces its CogSec marker, a since-removed entry is dropped (heal +
 * telemetry), and a still-live entry surfaces unchanged. Entries with no
 * positive L0 id (divergence deltas — never L0-redactable content) are kept
 * inline verbatim. This makes redaction propagation vintage-independent so the
 * frozen inline body of a since-redacted entry can never resurrect via
 * getRecentTurnRecords / findTurnRecord. The input record is not mutated; a
 * record with nothing L0-backed to re-read passes through untouched.
 */
function gateInlineRecentEntries(
  record: TurnRecord,
  sessionContext: Record<string, unknown>,
  resolve: SessionEntryRangeResolver,
  onHealDrop?: TurnRecordHealDropSink,
): RecentEntriesResolution {
  const inline = sessionContext.recentEntries;
  if (!Array.isArray(inline) || inline.length === 0) return { record, windowRedactionDetected: false };
  const channelId = typeof sessionContext.channelId === 'string' ? sessionContext.channelId : '';
  const ids: number[] = [];
  for (const entry of inline) {
    if (isRecord(entry) && isValidL0Id(entry.id)) ids.push(entry.id);
  }
  // No re-readable L0 ids (all divergence deltas), or no channel to read from:
  // nothing here is CogSec-redactable, so the inline copy is already the only
  // truth and passes through untouched.
  if (ids.length === 0 || channelId.length === 0) return { record, windowRedactionDetected: false };
  const byId = new Map<number, SessionEntry>();
  for (const entry of resolve(channelId, Math.min(...ids), Math.max(...ids))) {
    byId.set(entry.id, entry);
  }
  const recentEntries: SessionEntry[] = [];
  let windowRedactionDetected = false;
  for (const entry of inline) {
    if (isRecord(entry) && isValidL0Id(entry.id)) {
      const fresh = byId.get(entry.id);
      if (fresh) {
        // Journal-current truth (incl. any redaction marker) — never the frozen inline body.
        recentEntries.push(fresh);
        if (isRedactedContent(fresh.content)) windowRedactionDetected = true;
      } else {
        // absent → dropped (redacted-as-tombstone / tombstoned / rolled-off)
        windowRedactionDetected = true;
        onHealDrop?.({ channelId, entryId: entry.id, source: 'inline-old-fat', turnId: record.turnId });
      }
    } else {
      // Divergence delta: no positive L0 id, so not CogSec-redactable — keep inline.
      recentEntries.push(entry as SessionEntry);
    }
  }
  return {
    record: withSessionContext(record, { ...sessionContext, recentEntries }),
    windowRedactionDetected,
  };
}

// ── cross-channel continuity redaction gating ───────────────────────────────

/**
 * Replace frozen cross-channel continuity content with the origin journal's
 * current truth. Reads are grouped into one inclusive range per source session,
 * bounded by the persisted continuity array. Any state that cannot prove a
 * live, identity-matching source row heals to the standard redaction notice;
 * resolver failures never block the turn-record read and never expose plaintext.
 */
function resolveContinuityEntries(
  record: TurnRecord,
  resolve: SessionEntryRangeResolver,
  onWithheld?: TurnRecordContinuityWithheldSink,
): ContinuityEntriesResolution {
  const sessionContext = readSessionContext(record);
  const inline = sessionContext?.continuityEntries;
  if (!sessionContext || !Array.isArray(inline) || inline.length === 0) {
    return { record, redactionDetected: false };
  }

  const resolution = resolveContinuityEntryContent(
    inline as SessionEntry[],
    resolve,
  );
  for (const withheld of resolution.withheld) {
    onWithheld?.({
      channelId: record.channelId,
      ...withheld,
      turnId: record.turnId,
    });
  }

  return {
    record: withSessionContext(record, {
      ...sessionContext,
      continuityEntries: resolution.entries,
    }),
    redactionDetected: resolution.withheld.length > 0,
  };
}

// ── rendered-view redaction gating ──────────────────────────────────────────

function readPlanMessages(record: TurnRecord): Record<string, unknown>[] | undefined {
  const snapshot = record.observability?.snapshot;
  const plan = snapshot?.plan;
  if (!isRecord(plan) || !Array.isArray(plan.messages)) return undefined;
  return plan.messages.map(toRecordView);
}

function messageSourceEntryIds(message: Record<string, unknown>): number[] {
  const provenance = message.provenance;
  if (!isRecord(provenance) || !Array.isArray(provenance.sourceEntryIds)) return [];
  return provenance.sourceEntryIds.filter(isValidL0Id);
}

/**
 * The current turn's own partner (user) L0 session-entry id (bead
 * psfn-framework-eb14). This entry is deliberately EXCLUDED from `plan.messages`
 * (prompt-assembly throws if it leaks into prior-history), yet its plaintext IS
 * the captured wire body's final user message — derived from
 * `promptContext.currentTurnInput` at capture time. Redacting/removing this entry
 * therefore leaves NO `plan.messages` provenance signal, so the wire body must be
 * gated on this id directly. It equals `currentSessionEntryId` /
 * `userSessionEntryId` at write time (turn-execution-runtime → turn-records).
 */
function readCurrentTurnPartnerEntryId(record: TurnRecord): number | undefined {
  const id = record.userMessage.sessionEntryId;
  return isValidL0Id(id) ? id : undefined;
}

/**
 * Locate the captured provider wire payload record (bead hgw3-80f6) inside a
 * turn snapshot. By the time this gate runs the payload's `bodyRef` has already
 * been resolved back to an inline `body` by the turn-record store port, so a
 * present `body` is the verbatim provider request JSON.
 */
function readCapturedWirePayload(record: TurnRecord): Record<string, unknown> | undefined {
  const promptContext = record.observability?.snapshot?.promptContext;
  if (!isRecord(promptContext)) return undefined;
  const providerObservability = promptContext.providerObservability;
  if (!isRecord(providerObservability)) return undefined;
  const captured = providerObservability.capturedWirePayload;
  return isRecord(captured) ? captured : undefined;
}

function withCapturedWirePayload(record: TurnRecord, captured: Record<string, unknown>): TurnRecord {
  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  const promptContext = toRecordView(snapshot.promptContext!);
  const providerObservability = promptContext.providerObservability as Record<string, unknown>;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        promptContext: restoreSnapshotSection({
          ...promptContext,
          providerObservability: {
            ...providerObservability,
            capturedWirePayload: captured,
          },
        }),
      },
    },
  };
}

/**
 * Mask snapshot duplicates consumed by Garden/telemetry after the canonical
 * top-level turn messages are withheld. Modern records normally derive provider
 * messages from the plan, but legacy/divergent records can retain an embedded
 * copy, so any suppressed prompt input masks those message bodies too.
 */
function withTurnMessageSnapshotViewsWithheld(
  record: TurnRecord,
  userSuppressed: boolean,
  assistantSuppressed: boolean,
  promptInputSuppressed: boolean,
): TurnRecord {
  const observability = record.observability;
  const snapshot = observability?.snapshot;
  const promptContext = snapshot && isRecord(snapshot.promptContext)
    ? toRecordView(snapshot.promptContext)
    : undefined;
  if (!observability || !snapshot || !promptContext) return record;

  let changed = false;
  const next = { ...promptContext };
  if (userSuppressed && typeof promptContext.currentTurnInput === 'string') {
    next.currentTurnInput = REDACTED_MESSAGE_PLACEHOLDER;
    changed = true;
  }
  if (assistantSuppressed && isRecord(promptContext.response)) {
    next.response = {
      ...promptContext.response,
      content: REDACTED_MESSAGE_PLACEHOLDER,
    };
    changed = true;
  }
  if (promptInputSuppressed) {
    if (Array.isArray(promptContext.messages)) {
      next.messages = promptContext.messages.map(value => (
        isRecord(value)
          ? { ...value, content: REDACTED_MESSAGE_PLACEHOLDER }
          : value
      ));
      changed = true;
    }
    if (typeof promptContext.assembledPrompt === 'string') {
      next.assembledPrompt = REDACTED_MESSAGE_PLACEHOLDER;
      changed = true;
    }
    const providerObservability = isRecord(promptContext.providerObservability)
      ? promptContext.providerObservability
      : undefined;
    if (providerObservability && Array.isArray(providerObservability.providerWireMessages)) {
      next.providerObservability = {
        ...providerObservability,
        providerWireMessages: providerObservability.providerWireMessages.map(value => (
          isRecord(value) && value.source === 'message'
            ? { ...value, content: REDACTED_MESSAGE_PLACEHOLDER }
            : value
        )),
      };
      changed = true;
    }
  }
  if (!changed) return record;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        promptContext: restoreSnapshotSection(next),
      },
    },
  };
}

function isContinuityPromptBlockId(id: unknown): boolean {
  return id === 'session.continuity'
    || id === 'cross_channel_continuity'
    || id === 'session.orientation'
    || id === 'wake_orientation';
}

/**
 * Mask persisted, Loom-visible prompt projections that froze the continuity
 * block. The raw captured body is handled separately below; these replacements
 * cover the PromptPlan, final-system section telemetry, embedded legacy provider
 * wire messages, and legacy monolithic prompt strings.
 */
function withContinuityPromptViewsWithheld(record: TurnRecord): TurnRecord {
  const observability = record.observability;
  const snapshot = observability?.snapshot;
  if (!observability || !snapshot) return record;

  const snapshotView = toRecordView(snapshot);
  const plan = isRecord(snapshotView.plan) ? snapshotView.plan : undefined;
  const promptContext = isRecord(snapshotView.promptContext)
    ? snapshotView.promptContext
    : undefined;
  const sessionContext = isRecord(snapshotView.sessionContext)
    ? snapshotView.sessionContext
    : undefined;
  let changed = false;
  let nextPlan = plan;
  let nextPromptContext = promptContext;
  let nextSessionContext = sessionContext;

  if (plan && Array.isArray(plan.blocks)) {
    const blocks = plan.blocks.map((value) => {
      if (!isRecord(value) || !isContinuityPromptBlockId(value.id)) return value;
      changed = true;
      return { ...value, renderedText: REDACTED_MESSAGE_PLACEHOLDER };
    });
    nextPlan = { ...plan, blocks };
  }

  if (promptContext) {
    let promptContextChanged = false;
    const next = { ...promptContext };
    if (Array.isArray(promptContext.finalSystemSections)) {
      next.finalSystemSections = promptContext.finalSystemSections.map((value) => {
        if (!isRecord(value)
          || !isContinuityPromptBlockId(value.id)
          && value.id !== 'final_system_prompt') {
          return value;
        }
        promptContextChanged = true;
        return {
          ...value,
          content: REDACTED_MESSAGE_PLACEHOLDER,
          charCount: REDACTED_MESSAGE_PLACEHOLDER.length,
          tokenCount: 0,
        };
      });
    }

    const providerObservability = isRecord(promptContext.providerObservability)
      ? promptContext.providerObservability
      : undefined;
    if (providerObservability && Array.isArray(providerObservability.providerWireMessages)) {
      const providerWireMessages = providerObservability.providerWireMessages.map((value) => {
        if (!isRecord(value)
          || value.source !== 'system_prompt'
          && value.role !== 'system'
          && value.role !== 'developer'
          && value.role !== 'system_instruction') {
          return value;
        }
        promptContextChanged = true;
        return { ...value, content: REDACTED_MESSAGE_PLACEHOLDER };
      });
      next.providerObservability = {
        ...providerObservability,
        providerWireMessages,
      };
    }

    // Pre-PromptPlan snapshots may carry monolithic prompt strings. Partial
    // reconstruction is impossible, so withhold the complete string.
    for (const field of ['finalSystemPrompt', 'assembledPrompt'] as const) {
      if (typeof promptContext[field] === 'string') {
        next[field] = REDACTED_MESSAGE_PLACEHOLDER;
        promptContextChanged = true;
      }
    }
    if (promptContextChanged) {
      changed = true;
      nextPromptContext = next;
    }
  }

  if (sessionContext && isRecord(sessionContext.orientation)) {
    const orientation = { ...sessionContext.orientation };
    let orientationChanged = false;
    for (const field of [
      'noteText',
      'sessionSummary',
      'continuitySummary',
      'lastUserMessage',
      'openThreadSummary',
    ] as const) {
      if (typeof orientation[field] === 'string') {
        orientation[field] = REDACTED_MESSAGE_PLACEHOLDER;
        orientationChanged = true;
      }
    }
    if (orientationChanged) {
      changed = true;
      nextSessionContext = { ...sessionContext, orientation };
    }
  }

  if (!changed) return record;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        ...(nextPlan ? { plan: restoreSnapshotSection(nextPlan) } : {}),
        ...(nextPromptContext
          ? { promptContext: restoreSnapshotSection(nextPromptContext) }
          : {}),
        ...(nextSessionContext
          ? { sessionContext: restoreSnapshotSection(nextSessionContext) }
          : {}),
      },
    },
  };
}

/** Structured replacement for a withheld captured wire body. */
function buildWithheldWireBody(caseChannelId: string): Record<string, unknown> {
  return {
    withheld: WITHHELD_WIRE_BODY_MARKER,
    reason: 'A source session-journal entry embedded in this captured provider '
      + 'request body was redacted or removed; the raw body is withheld so the '
      + 'redacted content cannot be served.',
    channelId: caseChannelId,
  };
}

/**
 * Redaction-gate the rendered views of a turn against the CURRENT L0 journal, in
 * a single range read shared by both surfaces:
 *
 *  - top-level `userMessage` / `assistantMessage` (bead sm9l): each frozen
 *    copy is masked when its `sessionEntryId` resolves absent/redacted.
 *
 *  - `plan.messages` (the Loom conversation): each entry-backed message carries
 *    `provenance.sourceEntryIds`. If ANY backing entry is now absent from L0
 *    (tombstoned / rolled off) or resolves to a CogSec redaction marker, the
 *    whole message content is masked — a merged multi-id message cannot be
 *    partially rebuilt, so masking is the conservative, correct choice.
 *
 *  - `capturedWirePayload.body` (the Loom "Raw Wire Body", bead
 *    psfn-framework-eb14): the raw provider request JSON embeds the rendered
 *    conversation (`plan.messages` as history) AND the current turn's own partner
 *    text (its final user message, from `promptContext.currentTurnInput`). It is
 *    served verbatim IFF NOTHING in the L0 window it serialized is redacted or
 *    absent; otherwise the whole body is withheld and replaced with a structured
 *    marker (option (b) — provably safe whole-body conservatism, no per-field
 *    surgery of provider-transformed JSON). The safe summary metadata
 *    (api/model/byteLength/toolCount) stays inline. Read-time gating only: the
 *    content-addressed sidecar file is never touched, so bodies shared across
 *    turns and dangling-ref fail-closed semantics are unaffected.
 *
 *    The wire-body withhold key is broader than the `plan.messages` mask because
 *    the wire body carries content `plan.messages` structurally cannot: the
 *    current turn's own partner entry is EXCLUDED from prior-history assembly
 *    (prompt-assembly throws if it leaks in) yet is embedded verbatim as the
 *    body's final user message — the single most common redaction target. So the
 *    body is withheld when ANY of:
 *      (a) a `plan.messages` provenance entry was suppressed (history redaction);
 *      (b) the current-turn partner entry (`userMessage.sessionEntryId`) is now
 *          redacted/absent in L0 (`readCurrentTurnPartnerEntryId`);
 *      (c) the `recentEntries` L0 window showed any redaction/absence
 *          (`windowRedactionDetected`, threaded from the recentEntries pass —
 *          belt-and-suspenders over (a) for the same-channel history window).
 *      (d) a cross-channel continuity entry could not be proven live against
 *          its origin L0 journal (`continuityRedactionDetected`, bead
 *          psfn-framework-ervg).
 *    This gate runs even when `plan.messages` is empty: a body whose only
 *    entry-backed content is the current turn (or an empty-history first turn
 *    whose partner entry is later redacted) must still be gated. Only a record
 *    with NO entry-backed window at all (no plan provenance ids, no current-turn
 *    entry, no window redaction) passes through untouched.
 *
 * Synthetic messages with no `sourceEntryIds` (history-compaction summaries,
 * non-verbatim text) pass through the `plan.messages` mask. Applied to every
 * record — including pre-9ree old fat records and any legacy inline-body record —
 * so redaction propagates uniformly regardless of storage vintage.
 * `onWireBodyWithheld`, if provided, is invoked once per record whose body is
 * withheld.
 *
 * Same-channel ids share one bounded range read. Cross-channel continuity was
 * already resolved by `resolveContinuityEntries`; its suppression signal joins
 * the whole-body withhold key here.
 */
function gateRenderedViews(
  record: TurnRecord,
  resolve: SessionEntryRangeResolver,
  windowRedactionDetected: boolean,
  continuityRedactionDetected: boolean,
  onWireBodyWithheld?: TurnRecordWireBodyWithheldSink,
  onMessageWithheld?: TurnRecordMessageWithheldSink,
): TurnRecord {
  const messages = readPlanMessages(record);
  const sessionContext = readSessionContext(record);
  const channelId = (typeof sessionContext?.channelId === 'string' && sessionContext.channelId.length > 0)
    ? sessionContext.channelId
    : record.channelId;
  if (typeof channelId !== 'string' || channelId.length === 0) return record;

  // Entry-backed L0 ids embedded in the wire body: plan.messages history
  // provenance PLUS the current turn's own partner entry (the body's final user
  // message, which plan.messages structurally excludes).
  const currentTurnPartnerEntryId = readCurrentTurnPartnerEntryId(record);
  const assistantEntryId = isValidL0Id(record.assistantMessage?.sessionEntryId)
    ? record.assistantMessage.sessionEntryId
    : undefined;
  const allIds = new Set<number>();
  if (messages) {
    for (const message of messages) {
      for (const id of messageSourceEntryIds(message)) allIds.add(id);
    }
  }
  if (currentTurnPartnerEntryId !== undefined) allIds.add(currentTurnPartnerEntryId);
  if (assistantEntryId !== undefined) allIds.add(assistantEntryId);

  // Nothing entry-backed AND no redaction signalled by either persisted window
  // ⇒ nothing L0-redactable is embedded in either the rendered view or the
  // captured wire body (only synthetic/summary content), so both pass through.
  if (allIds.size === 0 && !windowRedactionDetected && !continuityRedactionDetected) {
    return record;
  }

  const live = new Map<number, SessionEntry>();
  if (allIds.size > 0) {
    const ids = [...allIds];
    for (const entry of resolve(channelId, Math.min(...ids), Math.max(...ids))) {
      live.set(entry.id, entry);
    }
  }
  const isSuppressedId = (id: number): boolean => {
    const entry = live.get(id);
    return entry === undefined || isRedactedContent(entry.content);
  };

  // Mask the rendered conversation view (plan.messages) where a backing entry was
  // suppressed.
  let anyPlanSuppressed = false;
  let gated = messages;
  if (messages) {
    gated = messages.map((message) => {
      const sourceIds = messageSourceEntryIds(message);
      if (sourceIds.length === 0) return message;
      return sourceIds.some(isSuppressedId)
        ? { ...message, content: REDACTED_MESSAGE_PLACEHOLDER }
        : message;
    });
    // Masking allocates a fresh object per message; identity change ⇒ suppression.
    anyPlanSuppressed = gated.some((message, index) => message !== messages[index]);
  }

  // Withhold the captured wire body if ANY L0 content it serialized is now
  // redacted/absent: a suppressed history message, the current-turn partner
  // entry, or any redaction/absence in the recentEntries window. Serving the raw
  // body in any of those cases would resurrect the exact plaintext L0 removed.
  const currentTurnSuppressed = currentTurnPartnerEntryId !== undefined
    && isSuppressedId(currentTurnPartnerEntryId);
  const assistantSuppressed = assistantEntryId !== undefined
    && isSuppressedId(assistantEntryId);
  const withholdWireBody = anyPlanSuppressed
    || currentTurnSuppressed
    || windowRedactionDetected
    || continuityRedactionDetected;

  let next = record;

  const topLevelMessages: Array<{
    entryId: number | undefined;
    surface: TurnRecordMessageWithheld['surface'];
  }> = [
    { entryId: currentTurnPartnerEntryId, surface: 'userMessage' },
    { entryId: assistantEntryId, surface: 'assistantMessage' },
  ];
  for (const { entryId, surface } of topLevelMessages) {
    if (entryId === undefined || !isSuppressedId(entryId)) continue;
    const message = next[surface];
    if (!message) continue;
    next = {
      ...next,
      [surface]: { ...message, content: REDACTED_MESSAGE_PLACEHOLDER },
    };
    onMessageWithheld?.({
      channelId,
      entryId,
      surface,
      turnId: record.turnId,
    });
  }
  next = withTurnMessageSnapshotViewsWithheld(
    next,
    currentTurnSuppressed,
    assistantSuppressed,
    anyPlanSuppressed || currentTurnSuppressed,
  );

  if (anyPlanSuppressed && messages) {
    const observability = next.observability!;
    const snapshot = observability.snapshot!;
    const plan = toRecordView(snapshot.plan!);
    next = {
      ...next,
      observability: {
        ...observability,
        snapshot: {
          ...snapshot,
          plan: restoreSnapshotSection({ ...plan, messages: gated }),
        },
      },
    };
  }

  if (withholdWireBody) {
    const captured = readCapturedWirePayload(next);
    if (captured && captured.body !== undefined) {
      const { body: _body, ...capturedRest } = captured;
      next = withCapturedWirePayload(next, {
        ...capturedRest,
        body: buildWithheldWireBody(channelId),
      });
      onWireBodyWithheld?.({ channelId: record.channelId, turnId: record.turnId });
    }
  }

  return next;
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
 * (ref-backed) or redaction-gate (pre-9ree inline) `recentEntries` from L0 and
 * redaction-gate every frozen rendered view (top-level messages,
 * `plan.messages`, cross-channel continuity prompt projections, and captured
 * provider wire body), making the diet transparent to every consumer above
 * persistence (Garden Loom, session-turn observability, introspection auditing).
 * `onHealDrop`, if provided, is invoked for each id-backed `recentEntries` item
 * dropped because its L0 entry is absent on re-read; `onWireBodyWithheld`, if
 * provided, is invoked once per record whose captured wire body is withheld
 * because a source L0 entry it embedded was redacted/removed.
 */
export function resolveTurnRecordSessionEntries(
  record: TurnRecord,
  resolve: SessionEntryRangeResolver,
  onHealDrop?: TurnRecordHealDropSink,
  onWireBodyWithheld?: TurnRecordWireBodyWithheldSink,
  onMessageWithheld?: TurnRecordMessageWithheldSink,
  onContinuityWithheld?: TurnRecordContinuityWithheldSink,
): TurnRecord {
  const { record: resolved, windowRedactionDetected } = resolveRecentEntries(record, resolve, onHealDrop);
  const continuity = resolveContinuityEntries(resolved, resolve, onContinuityWithheld);
  const continuityGated = continuity.redactionDetected
    ? withContinuityPromptViewsWithheld(continuity.record)
    : continuity.record;
  return gateRenderedViews(
    continuityGated,
    resolve,
    windowRedactionDetected,
    continuity.redactionDetected,
    onWireBodyWithheld,
    onMessageWithheld,
  );
}
