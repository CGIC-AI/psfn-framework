import { isRecord } from '../../shared/utils/types.js';
import type { ObservedMemory, ObservedScoredMemory } from '../../core/turns/observability.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { restoreSnapshotSection } from './turn-record-snapshot-view.js';

/**
 * Turn-record retrieved-memory diet (bead psfn-framework-jsi9).
 *
 * A turn record's `observability.snapshot.memory` used to persist every
 * retrieved memory VERBATIM: the four candidate arrays
 * (`contactEmotionalMemories`, `semanticCandidates`, `lexicalCandidates`,
 * `proactiveCandidates`) each carried the full `ObservedMemory` — embedding
 * stripped, but `.text` (the only large free-form field) copied in full. The
 * text already lives in the memory store; duplicating it per turn bloated the
 * record AND — because it froze the memory at capture time — meant a later
 * redaction/deletion of a memory (via the memory tool's redact/delete actions)
 * did NOT propagate to the persisted turn record: the old verbatim text was
 * resurrected on read.
 *
 * This module replaces the four inline candidate arrays with a single
 * `candidatesRef` holding only memory ids (plus the retrieval-time `similarity`
 * for the scored arrays, which is NOT recoverable from the memory store) and
 * reconstructs the arrays from the LIVE memory store at the read boundary, so:
 * - the memory store is the single durable source of a memory's text/metadata;
 * - a memory redacted / deleted after the turn can NEVER be resurfaced from the
 *   turn record — reconstruction only ever surfaces the store's CURRENT truth,
 *   and a memory that is gone (or soft-deleted) is dropped;
 * - `similarity` stays with the ref because it is a property of the retrieval,
 *   not of the memory, and the store cannot reproduce it.
 *
 * Convention parity with the sibling L0 session-entry diet
 * (turn-record-session-refs.ts) and the content-addressed sidecars
 * (turn-record-shared-store.ts): an inline field is replaced by a sibling ref;
 * old fat records lack the ref and pass through untouched; a record that
 * carries BOTH the ref and any inline candidate array is ambiguous and fails
 * closed.
 *
 * Heal-vs-fail boundary (the one documented deviation from the immutable
 * content-addressed sidecars, shared with the session-entry diet): STRUCTURAL
 * corruption of the ref shape (checkable without any store read — bad version,
 * non-array items, a missing/empty id, both ref+inline present) FAILS CLOSED.
 * But a memory legitimately absent on re-read (hard-deleted, so the resolver
 * returns `undefined`, or soft-deleted, which the resolver is expected to treat
 * as absent) is EXPECTED and HEALS: the candidate is dropped from its array.
 * Memories are mutable/erasable by design; their disappearance is the redaction
 * propagation, not corruption.
 *
 * Resolution seam — deviation from the session-entry diet: session-entry refs
 * resolve at the SessionManager store boundary because that reader owns the
 * (synchronous, in-memory) journal range reader AND session entries are needed
 * by consumers just above the store. Memory candidates are NOT: the ONLY
 * consumer of persisted `snapshot.memory` candidate arrays is the Garden Loom
 * observability view. The live-agent hot path (getRecentTurnRecords feeding
 * context assembly, introspection auditing, hasRecordedTurn) never reads them.
 * Resolving here would therefore (a) add an async memory-store round-trip to
 * every hot-path turn-record read that needs no memory text and (b) require the
 * persistence layer to depend on the memory faculty and become async. So the
 * slim projection runs at the persistence write boundary (pure, no store
 * access) and the resolve runs ONLY at the Garden read boundary, which already
 * owns the memory store. Every hot-path read exit passes the slim record
 * through untouched, which is safe precisely because none of them read
 * `snapshot.memory`.
 */

/** Field on `snapshot.memory` replacing the four inline candidate arrays. */
export const MEMORY_CANDIDATES_REF_FIELD = 'candidatesRef';
/** Ref schema version; a future incompatible shape bumps this. */
export const MEMORY_CANDIDATES_REF_VERSION = 1 as const;

/** A scored candidate reference: memory id + its retrieval-time similarity. */
interface ScoredMemoryRef {
  id: string;
  similarity: number;
}

interface MemoryCandidatesRef {
  v: typeof MEMORY_CANDIDATES_REF_VERSION;
  /** contactEmotionalMemories — unscored, bare ids. */
  contactEmotional: string[];
  /** semanticCandidates — scored. */
  semantic: ScoredMemoryRef[];
  /** lexicalCandidates — scored. */
  lexical: ScoredMemoryRef[];
  /** proactiveCandidates — unscored, bare ids. */
  proactive: string[];
}

/**
 * Resolve a memory id to its CURRENT store view (embedding-stripped), or
 * `undefined` when the memory is gone or has been soft-deleted. The resolver is
 * responsible for treating soft-deleted memories as absent — that is what makes
 * deletion propagate.
 */
export type ObservedMemoryResolver = (id: string) => ObservedMemory | undefined;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readMemorySnapshot(record: TurnRecord): Record<string, unknown> | undefined {
  const snapshot = record.observability?.snapshot;
  if (!snapshot || !isRecord(snapshot.memory)) return undefined;
  return snapshot.memory;
}

function withMemorySnapshot(record: TurnRecord, memory: Record<string, unknown>): TurnRecord {
  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        memory: restoreSnapshotSection(memory),
      },
    },
  };
}

const INLINE_CANDIDATE_FIELDS = [
  'contactEmotionalMemories',
  'semanticCandidates',
  'lexicalCandidates',
  'proactiveCandidates',
] as const;

function readObservedArray(memory: Record<string, unknown>, field: string): ObservedMemory[] {
  const value = memory[field];
  return Array.isArray(value) ? (value as ObservedMemory[]) : [];
}

function toIdRef(memory: ObservedMemory, field: string): string {
  if (!isNonEmptyString(memory.id)) {
    throw new Error(`TurnRecord snapshot.memory.${field} candidate is missing a string id`);
  }
  return memory.id;
}

function toScoredRef(memory: ObservedScoredMemory, field: string): ScoredMemoryRef {
  if (!isNonEmptyString(memory.id)) {
    throw new Error(`TurnRecord snapshot.memory.${field} candidate is missing a string id`);
  }
  return { id: memory.id, similarity: memory.similarity };
}

// ── write projection ─────────────────────────────────────────────────────────

/**
 * Persist projection: replace the four inline retrieved-memory candidate arrays
 * on `snapshot.memory` with a single `candidatesRef` of ids (+ similarity for
 * the scored arrays). Records with no memory snapshot, or whose four candidate
 * arrays are all empty (nothing to save), pass through untouched. Every other
 * field on `snapshot.memory` (channelId, profile, emotionalSnapshot,
 * episodicChains, withheldSummary, versionPointer) is preserved inline —
 * `episodicChains` is deliberately left inline (it is not one of the retrieved
 * `*Candidates` arrays and carries its own episode text; its diet is a separate
 * follow-up). The input record is not mutated. Fails closed on a candidate with
 * no string id (structural corruption at write time).
 */
export function slimTurnRecordMemoryCandidatesForAppend(record: TurnRecord): TurnRecord {
  const memory = readMemorySnapshot(record);
  if (!memory) return record;
  const contactEmotional = readObservedArray(memory, 'contactEmotionalMemories');
  const semantic = readObservedArray(memory, 'semanticCandidates') as ObservedScoredMemory[];
  const lexical = readObservedArray(memory, 'lexicalCandidates') as ObservedScoredMemory[];
  const proactive = readObservedArray(memory, 'proactiveCandidates');
  const total = contactEmotional.length + semantic.length + lexical.length + proactive.length;
  if (total === 0) return record;

  const ref: MemoryCandidatesRef = {
    v: MEMORY_CANDIDATES_REF_VERSION,
    contactEmotional: contactEmotional.map(memoryEntry => toIdRef(memoryEntry, 'contactEmotionalMemories')),
    semantic: semantic.map(memoryEntry => toScoredRef(memoryEntry, 'semanticCandidates')),
    lexical: lexical.map(memoryEntry => toScoredRef(memoryEntry, 'lexicalCandidates')),
    proactive: proactive.map(memoryEntry => toIdRef(memoryEntry, 'proactiveCandidates')),
  };

  const rest: Record<string, unknown> = { ...memory };
  for (const field of INLINE_CANDIDATE_FIELDS) delete rest[field];
  rest[MEMORY_CANDIDATES_REF_FIELD] = ref;
  return withMemorySnapshot(record, rest);
}

// ── read resolution ──────────────────────────────────────────────────────────

function isScoredMemoryRef(value: unknown): value is ScoredMemoryRef {
  return isRecord(value) && isNonEmptyString(value.id) && typeof value.similarity === 'number';
}

function parseMemoryCandidatesRef(value: unknown): MemoryCandidatesRef {
  if (!isRecord(value)) {
    throw new Error(`TurnRecord snapshot.memory.${MEMORY_CANDIDATES_REF_FIELD} must be an object`);
  }
  if (value.v !== MEMORY_CANDIDATES_REF_VERSION) {
    throw new Error(
      `TurnRecord snapshot.memory.${MEMORY_CANDIDATES_REF_FIELD}.v must be ${MEMORY_CANDIDATES_REF_VERSION}`,
    );
  }
  for (const field of ['contactEmotional', 'proactive'] as const) {
    if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every(isNonEmptyString)) {
      throw new Error(
        `TurnRecord snapshot.memory.${MEMORY_CANDIDATES_REF_FIELD}.${field} must be an array of non-empty ids`,
      );
    }
  }
  for (const field of ['semantic', 'lexical'] as const) {
    if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every(isScoredMemoryRef)) {
      throw new Error(
        `TurnRecord snapshot.memory.${MEMORY_CANDIDATES_REF_FIELD}.${field} must be an array of {id, similarity}`,
      );
    }
  }
  return value as unknown as MemoryCandidatesRef;
}

function resolveUnscored(ids: string[], resolve: ObservedMemoryResolver): ObservedMemory[] {
  const out: ObservedMemory[] = [];
  for (const id of ids) {
    const memory = resolve(id);
    if (memory) out.push(memory); // absent/deleted → dropped (redaction propagation)
  }
  return out;
}

function resolveScored(refs: ScoredMemoryRef[], resolve: ObservedMemoryResolver): ObservedScoredMemory[] {
  const out: ObservedScoredMemory[] = [];
  for (const ref of refs) {
    const memory = resolve(ref.id);
    if (memory) out.push({ ...memory, similarity: ref.similarity });
  }
  return out;
}

/**
 * Read inverse for `candidatesRef`: reconstruct the four candidate arrays from
 * the live memory store (via `resolve`), in the same order they were stored.
 * Records without the ref pass through untouched. Fails closed on a structurally
 * corrupt ref or an ambiguous ref+inline record; heals (drops the candidate)
 * when a referenced memory is absent/soft-deleted on re-read.
 */
export function resolveTurnRecordMemoryCandidates(
  record: TurnRecord,
  resolve: ObservedMemoryResolver,
): TurnRecord {
  const memory = readMemorySnapshot(record);
  const rawRef = memory?.[MEMORY_CANDIDATES_REF_FIELD];
  if (!memory || rawRef === undefined) return record;
  for (const field of INLINE_CANDIDATE_FIELDS) {
    if (memory[field] !== undefined) {
      throw new Error(
        `TurnRecord snapshot.memory carries both inline ${field} and ${MEMORY_CANDIDATES_REF_FIELD}`,
      );
    }
  }
  const ref = parseMemoryCandidatesRef(rawRef);
  const { [MEMORY_CANDIDATES_REF_FIELD]: _ref, ...rest } = memory;
  return withMemorySnapshot(record, {
    ...rest,
    contactEmotionalMemories: resolveUnscored(ref.contactEmotional, resolve),
    semanticCandidates: resolveScored(ref.semantic, resolve),
    lexicalCandidates: resolveScored(ref.lexical, resolve),
    proactiveCandidates: resolveUnscored(ref.proactive, resolve),
  });
}

/**
 * Collect every memory id referenced by a record's `candidatesRef` (empty for
 * old fat records / records with no ref). Lets the Garden read boundary
 * batch-fetch the memory store once per read instead of per candidate.
 */
export function collectTurnRecordMemoryRefIds(record: TurnRecord): string[] {
  const memory = readMemorySnapshot(record);
  const rawRef = memory?.[MEMORY_CANDIDATES_REF_FIELD];
  if (rawRef === undefined) return [];
  const ref = parseMemoryCandidatesRef(rawRef);
  return [
    ...ref.contactEmotional,
    ...ref.semantic.map(entry => entry.id),
    ...ref.lexical.map(entry => entry.id),
    ...ref.proactive,
  ];
}
