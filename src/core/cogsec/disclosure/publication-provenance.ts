// ── CogSec publication review: Garden provenance projection (bible §10.10) ──
//
// The operator approves a publication candidate on the existing Garden approvals
// page ("The Gate"). To approve KNOWINGLY (adjudication R1.3, bible §10.10) the
// page must surface the derived memories, conversations, and sources used to
// create the candidate — its disclosure provenance. This module is the pure,
// CONTENT-FREE projection that turns a queued confirmation entry's `params` bag
// into the display view the Garden confirmations route attaches and the admin-ui
// renders (jp36.7.2). It reads ONLY provenance metadata — refs, ids, counts,
// kinds, sensitivity labels, classification flags — never the candidate's body,
// media, or any transcript text (bible §10.10 "content-free provenance refs").
// The candidate CONTENT itself remains visible in the entry's raw-params surface
// (the operator approves that content); this projection is provenance only.
//
// Fail-closed invariants:
//   - A confirmation that is NOT a publication/share candidate projects to `null`
//     (the route attaches nothing; ordinary confirmations are untouched).
//   - A publication candidate whose provenance object is absent or malformed
//     still projects to a view flagged `malformed`, with every unreadable
//     dimension reported as explicitly `'unknown'` — never fabricated, never
//     silently dropped. The operator always sees that provenance is missing.
//   - Only recognized, well-formed values are surfaced; a malformed field of an
//     otherwise-valid candidate degrades that field to `'unknown'`, not the whole
//     view.
//
// Integration seam (for the sibling gateway plumbing bead jp36.7.1.2): a
// publication candidate's provenance is read, in priority order, from
// `params.shareCandidate` (a serialized ShareCandidate/ApprovedShareCapsule),
// `params.disclosureProvenance` (a serialized DisclosureLineage or provenance
// subset), or the top-level `params` when it itself carries the ShareCandidate
// provenance shape. Whichever the enqueuer populates, this projection reads it.

import { isRecord } from '../../../shared/utils/types.js';
import { isSensitivityLevel } from '../../../shared/contracts/artifact-sensitivity.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import { isDisclosureDestinationKind, type DisclosureDestinationKind } from './contracts.js';

/** Whether a provenance dimension was readable (`present`) or absent/malformed (`unknown`). */
export type ProvenanceFieldStatus = 'present' | 'unknown';

/** Content-free classification of an admitted source, derived from its ref prefix. */
export type ProvenanceSourceKind =
  | 'memory'       // `memory:<id>`        — a derived memory
  | 'conversation' // `session:<key>`      — a conversation/session
  | 'project'      // `project:<id>:<ref>` / `wiki:<docId>` — a project/wiki read
  | 'tool'         // `tool:<name>:<callId>` — a tool result
  | 'other';       // any other/unrecognized ref shape

/** One admitted source in the candidate's provenance (content-free). */
export interface ProvenanceSourceView {
  /** Durable, content-free reference (id/prefix only — never transcript text). */
  readonly ref: string;
  readonly kind: ProvenanceSourceKind;
  /** Per-source sensitivity when the carrier is a DisclosureLineage snapshot; `'unknown'` otherwise. */
  readonly sensitivity: SensitivityLevel | 'unknown';
  /** Content-free subject-contact ids this source implicates; empty when not carried per-source. */
  readonly subjectContactIds: readonly string[];
  /** `false` when the source lacked usable lineage (fail-closed marker); `'unknown'` when not carried. */
  readonly classified: boolean | 'unknown';
}

/** A rollup count of admitted sources by kind (content-free). */
export interface ProvenanceSourceKindCount {
  readonly kind: ProvenanceSourceKind;
  readonly count: number;
}

/** A proposed/permitted destination for the candidate (content-free). */
export interface ProvenanceDestinationView {
  readonly kind: DisclosureDestinationKind;
  readonly channelIds: readonly string[];
  readonly contactIds: readonly string[];
}

/**
 * Content-free disclosure-provenance view for a single publication candidate,
 * surfaced on the Garden approvals page so the operator can approve knowingly.
 */
export interface PublicationProvenanceView {
  /** Discriminant: this confirmation entry is a publication/share candidate. */
  readonly isPublicationCandidate: true;
  /** Candidate identity (content-free); `null` when absent/malformed. */
  readonly candidateId: string | null;
  /** Immutable content fingerprint (content-free hash); `null` when absent/malformed. */
  readonly contentHash: string | null;
  /** Candidate-level effective sensitivity indicator. */
  readonly effectiveSensitivity: SensitivityLevel | 'unknown';
  /** The admitted-source list (content-free refs + per-source indicators). */
  readonly sources: readonly ProvenanceSourceView[];
  /** Rollup of `sources` by kind. */
  readonly sourceKindCounts: readonly ProvenanceSourceKindCount[];
  /** Count of admitted sources; `'unknown'` when the provenance carried none/malformed. */
  readonly sourceCount: number | 'unknown';
  /** Subject contacts implicated by the candidate as a whole (content-free ids). */
  readonly subjectContactIds: readonly string[];
  /** Proposed/permitted destinations (content-free kinds + scoped ids). */
  readonly destinations: readonly ProvenanceDestinationView[];
  /** `true` when any admitted source lacked usable disclosure lineage; `'unknown'` when not carried. */
  readonly hasUnclassifiedSource: boolean | 'unknown';
  /** Per-dimension resolution status so explicitly-unknown provenance is visible. */
  readonly status: {
    readonly sources: ProvenanceFieldStatus;
    readonly subjectContactIds: ProvenanceFieldStatus;
    readonly effectiveSensitivity: ProvenanceFieldStatus;
    readonly destinations: ProvenanceFieldStatus;
  };
  /**
   * `true` when a publication candidate was detected but its provenance object
   * was absent or not a readable record — the whole provenance is unknown.
   */
  readonly malformed: boolean;
}

const PROVENANCE_SOURCE_KINDS: readonly ProvenanceSourceKind[] = [
  'memory',
  'conversation',
  'project',
  'tool',
  'other',
];

/** Classify an admitted-source ref into a content-free kind by its durable prefix. */
export function classifyProvenanceSourceRef(ref: string): ProvenanceSourceKind {
  if (ref.startsWith('memory:')) return 'memory';
  if (ref.startsWith('session:')) return 'conversation';
  if (ref.startsWith('project:') || ref.startsWith('wiki:')) return 'project';
  if (ref.startsWith('tool:')) return 'tool';
  return 'other';
}

/**
 * A record that carries the ShareCandidate/ApprovedShareCapsule provenance shape.
 * Detected structurally (schema-versioned candidate marker, or the provenance
 * field triad) rather than by importing the capsule module — this keeps the
 * pure provenance projection free of the capsule runtime's dependency chain so
 * it is safe to share with the admin-ui typecheck graph. A ShareCandidate always
 * carries a numeric `schemaVersion` and a string `candidateId`; the
 * `provenanceRefs`/`effectiveSensitivity`/`subjectContactIds` triad is the
 * fallback marker (bible §10.11 capsule fields, jp36.7.1.1).
 */
function hasPublicationCandidateShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.schemaVersion === 'number' && typeof value.candidateId === 'string') return true;
  return Array.isArray(value.provenanceRefs)
    && 'effectiveSensitivity' in value
    && 'subjectContactIds' in value;
}

/**
 * Locate the provenance-bearing object inside a confirmation entry's params, and
 * report whether the entry is a publication candidate at all. The explicit keys
 * (`shareCandidate`, `disclosureProvenance`) mark a publication candidate even
 * when their value is malformed — so a broken provenance object still fails
 * closed to a `malformed` view rather than being silently treated as an ordinary
 * confirmation.
 */
function locateProvenanceSource(
  params: unknown,
): { readonly obj: unknown } | null {
  if (!isRecord(params)) return null;
  if ('shareCandidate' in params) return { obj: params.shareCandidate };
  if ('disclosureProvenance' in params) return { obj: params.disclosureProvenance };
  if (hasPublicationCandidateShape(params)) return { obj: params };
  return null;
}

/** Parse a JSON value into a content-free array of non-empty strings, or `null` if malformed. */
function parseStringRefList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed) return null;
    refs.push(trimmed);
  }
  return refs;
}

/** Parse a single destination constraint into a content-free view, or `null` if malformed. */
function parseDestinationView(value: unknown): ProvenanceDestinationView | null {
  if (!isRecord(value)) return null;
  if (!isDisclosureDestinationKind(value.kind)) return null;
  const channelIds = value.channelIds === undefined ? [] : parseStringRefList(value.channelIds);
  if (channelIds === null) return null;
  const contactIds = value.contactIds === undefined ? [] : parseStringRefList(value.contactIds);
  if (contactIds === null) return null;
  return { kind: value.kind, channelIds, contactIds };
}

/** Parse a destination constraint list; `null` if the list or any entry is malformed. */
function parseDestinationList(value: unknown): ProvenanceDestinationView[] | null {
  if (!Array.isArray(value)) return null;
  const destinations: ProvenanceDestinationView[] = [];
  for (const item of value) {
    const parsed = parseDestinationView(item);
    if (!parsed) return null;
    destinations.push(parsed);
  }
  return destinations;
}

/** Parse a DisclosureLineage `sourceSnapshots` entry into a per-source view, or `null` if malformed. */
function parseSnapshotSource(value: unknown): ProvenanceSourceView | null {
  if (!isRecord(value)) return null;
  if (typeof value.ref !== 'string' || !value.ref.trim()) return null;
  const ref = value.ref.trim();
  const subjectContactIds = value.subjectContactIds === undefined
    ? []
    : parseStringRefList(value.subjectContactIds);
  if (subjectContactIds === null) return null;
  const sensitivity: SensitivityLevel | 'unknown' = isSensitivityLevel(value.sensitivity)
    ? value.sensitivity
    : 'unknown';
  const classified: boolean | 'unknown' = typeof value.classified === 'boolean'
    ? value.classified
    : 'unknown';
  return { ref, kind: classifyProvenanceSourceRef(ref), sensitivity, subjectContactIds, classified };
}

function rollupSourceKinds(sources: readonly ProvenanceSourceView[]): ProvenanceSourceKindCount[] {
  const counts = new Map<ProvenanceSourceKind, number>();
  for (const source of sources) {
    counts.set(source.kind, (counts.get(source.kind) ?? 0) + 1);
  }
  return PROVENANCE_SOURCE_KINDS
    .filter(kind => counts.has(kind))
    .map(kind => ({ kind, count: counts.get(kind) ?? 0 }));
}

/**
 * Extract the admitted-source list. Prefers a DisclosureLineage `sourceSnapshots`
 * array (per-source sensitivity/subject/classified), and otherwise falls back to
 * a flat ShareCandidate `provenanceRefs` string list. Returns `null` (⇒ status
 * `'unknown'`) only when neither is present or the present one is malformed.
 */
function extractSources(obj: Record<string, unknown>): ProvenanceSourceView[] | null {
  if (obj.sourceSnapshots !== undefined) {
    if (!Array.isArray(obj.sourceSnapshots)) return null;
    const sources: ProvenanceSourceView[] = [];
    for (const snapshot of obj.sourceSnapshots) {
      const parsed = parseSnapshotSource(snapshot);
      if (!parsed) return null;
      sources.push(parsed);
    }
    return sources;
  }
  if (obj.provenanceRefs !== undefined) {
    const refs = parseStringRefList(obj.provenanceRefs);
    if (refs === null) return null;
    return refs.map(ref => ({
      ref,
      kind: classifyProvenanceSourceRef(ref),
      sensitivity: 'unknown' as const,
      subjectContactIds: [],
      classified: 'unknown' as const,
    }));
  }
  return null;
}

/** A fully-unknown view for a detected-but-unreadable publication candidate. */
function malformedView(): PublicationProvenanceView {
  return {
    isPublicationCandidate: true,
    candidateId: null,
    contentHash: null,
    effectiveSensitivity: 'unknown',
    sources: [],
    sourceKindCounts: [],
    sourceCount: 'unknown',
    subjectContactIds: [],
    destinations: [],
    hasUnclassifiedSource: 'unknown',
    status: {
      sources: 'unknown',
      subjectContactIds: 'unknown',
      effectiveSensitivity: 'unknown',
      destinations: 'unknown',
    },
    malformed: true,
  };
}

/**
 * Project a confirmation entry's `params` into a content-free publication-
 * provenance view, or `null` when the entry is not a publication/share candidate.
 * Pure and fail-closed: reads only provenance metadata, never the candidate body,
 * and reports every unreadable dimension as explicitly `'unknown'`.
 */
export function projectPublicationProvenance(params: unknown): PublicationProvenanceView | null {
  const located = locateProvenanceSource(params);
  if (!located) return null;
  const obj = located.obj;
  if (!isRecord(obj)) return malformedView();

  const candidateId = typeof obj.candidateId === 'string' && obj.candidateId.trim()
    ? obj.candidateId.trim()
    : null;
  const contentHash = typeof obj.contentHash === 'string' && obj.contentHash.trim()
    ? obj.contentHash.trim()
    : null;

  const effectiveSensitivity: SensitivityLevel | 'unknown' = isSensitivityLevel(obj.effectiveSensitivity)
    ? obj.effectiveSensitivity
    : 'unknown';

  const sources = extractSources(obj);
  const subjectContactIds = parseStringRefList(obj.subjectContactIds);

  // proposedDestinations (ShareCandidate) or permittedDestinations (capsule/lineage).
  const rawDestinations = obj.proposedDestinations !== undefined
    ? obj.proposedDestinations
    : obj.permittedDestinations;
  const destinations = rawDestinations === undefined ? null : parseDestinationList(rawDestinations);

  const hasUnclassifiedSource: boolean | 'unknown' = typeof obj.hasUnclassifiedSource === 'boolean'
    ? obj.hasUnclassifiedSource
    : sources !== null
      ? sources.some(source => source.classified === false)
      : 'unknown';

  const sourceCount: number | 'unknown' = typeof obj.sourceCount === 'number'
    && Number.isInteger(obj.sourceCount)
    && obj.sourceCount >= 0
    ? obj.sourceCount
    : sources !== null
      ? sources.length
      : 'unknown';

  return {
    isPublicationCandidate: true,
    candidateId,
    contentHash,
    effectiveSensitivity,
    sources: sources ?? [],
    sourceKindCounts: sources ? rollupSourceKinds(sources) : [],
    sourceCount,
    subjectContactIds: subjectContactIds ?? [],
    destinations: destinations ?? [],
    hasUnclassifiedSource,
    status: {
      sources: sources !== null ? 'present' : 'unknown',
      subjectContactIds: subjectContactIds !== null ? 'present' : 'unknown',
      effectiveSensitivity: effectiveSensitivity !== 'unknown' ? 'present' : 'unknown',
      destinations: destinations !== null ? 'present' : 'unknown',
    },
    malformed: false,
  };
}
