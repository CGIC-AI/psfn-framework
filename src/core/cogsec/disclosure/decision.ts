// ── CogSec outbound disclosure: pure decision functions (bible §9) ──
//
// Three fail-closed decision rules, plus a pure accumulator fold that composes
// them. No runtime wiring: these functions read no clocks, stores, or config.
//
//   1. maxSensitivity        — effective sensitivity is the MOST RESTRICTIVE
//                              admitted source (§6.3). Empty input fails closed
//                              to the most restrictive level.
//   2. destination intersect — permitted destinations are the INTERSECTION of
//                              every source's permission set, never the union
//                              (§6.3). A destination survives only when every
//                              source permits it.
//   3. fail-closed unclassified — an output with no usable lineage, or any
//                              admitted source lacking usable lineage, is never
//                              auto-shareable to an outward destination (§9.5).
//                              `companion_self` is the private sink and remains
//                              eligible regardless.
//   4. epoch disclosure boundary — a room's classification epoch increments when
//                              it widens (invite-only → public). Content admitted
//                              under epoch N of a channel is auto-eligible to the
//                              room only while the room is still at epoch N
//                              (§9.3). A destination carrying a current epoch is
//                              auto-eligible only for content whose admitted epoch
//                              for that channel matches; unknown or mismatched
//                              epoch fails closed to review (not auto-release).
//                              A destination with no tracked epoch skips the gate
//                              entirely — behavior is exactly pre-epoch, so
//                              absent epoch data is never MORE permissive.

import {
  SENSITIVITY_LEVELS,
  sensitivityOrd,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  DISCLOSURE_DESTINATION_KINDS,
  DISCLOSURE_KIND_ID_FIELD,
  type DisclosureClassification,
  type DisclosureDecision,
  type DisclosureDestination,
  type DisclosureDestinationConstraint,
  type DisclosureDestinationKind,
  type DisclosureLineage,
  type DisclosureSourceContribution,
  type DisclosureSourceSnapshot,
  type GenerationDisclosureContext,
} from './contracts.js';

// The most restrictive sensitivity — used as the fail-closed floor for an empty
// source set and as the auto-shareable ceiling for the private sink.
const MOST_RESTRICTIVE_SENSITIVITY: SensitivityLevel = SENSITIVITY_LEVELS[SENSITIVITY_LEVELS.length - 1];

/**
 * Per-destination ceiling: the highest effective sensitivity that can be
 * auto-shareable to a destination of this kind. Content above the ceiling is
 * still not auto-released even when the destination survives intersection —
 * it routes to human review (`approval_required`). This is a documented default
 * policy (versioned via `classifierVersion`), a belt-and-suspenders guard on
 * top of the destination-intersection rule.
 */
const DESTINATION_AUTO_SHAREABLE_CEILING: Record<DisclosureDestinationKind, SensitivityLevel> = {
  companion_self: 'confidential',
  contact_dm: 'confidential',
  invite_only_room: 'personal',
  public_room: 'public',
  publication: 'public',
};

// ── Rule 1: most-restrictive sensitivity ─────────────────────────────────────

/**
 * Effective sensitivity of a generation context: the most restrictive (highest)
 * of all admitted sources (§6.3). An empty set fails closed to the most
 * restrictive level rather than defaulting to `public`.
 */
export function maxSensitivity(levels: readonly SensitivityLevel[]): SensitivityLevel {
  if (levels.length === 0) return MOST_RESTRICTIVE_SENSITIVITY;
  return levels.reduce<SensitivityLevel>(
    (highest, level) => (sensitivityOrd(level) > sensitivityOrd(highest) ? level : highest),
    levels[0],
  );
}

// ── Rule 2: destination intersection ─────────────────────────────────────────

// Internal id-set representation. `UNRESTRICTED` means "any id of this kind".
const UNRESTRICTED = Symbol('disclosure.unrestricted');
type IdSet = readonly string[] | typeof UNRESTRICTED;

function constraintChannelOrContactIds(constraint: DisclosureDestinationConstraint): readonly string[] | undefined {
  const field = DISCLOSURE_KIND_ID_FIELD[constraint.kind];
  if (field === 'channelId') return constraint.channelIds;
  if (field === 'contactId') return constraint.contactIds;
  return undefined;
}

/**
 * Merge all constraints of one kind WITHIN a single source's permission list
 * into one id-set. Multiple entries of the same kind union (a source permitting
 * both room A and room B permits {A, B}); an unrestricted entry dominates.
 * Returns `null` when the kind is absent from the list.
 */
function mergeSourceIds(
  constraints: readonly DisclosureDestinationConstraint[],
  kind: DisclosureDestinationKind,
): IdSet | null {
  const matching = constraints.filter(constraint => constraint.kind === kind);
  if (matching.length === 0) return null;
  if (DISCLOSURE_KIND_ID_FIELD[kind] === null) return UNRESTRICTED;
  const ids = new Set<string>();
  for (const constraint of matching) {
    const scoped = constraintChannelOrContactIds(constraint);
    if (scoped === undefined) return UNRESTRICTED;
    for (const id of scoped) ids.add(id);
  }
  return [...ids];
}

function intersectIdSets(left: IdSet, right: IdSet): IdSet {
  if (left === UNRESTRICTED) return right;
  if (right === UNRESTRICTED) return left;
  const rightSet = new Set(right);
  return left.filter(id => rightSet.has(id));
}

// ── Per-channel admitted-epoch merge (rule 4) ────────────────────────────────
//
// Epoch scoping is auxiliary to `channelIds`: `channelIds` remains the sole
// authority for WHICH channels a source permits; `channelEpochs` records, for a
// channel the source permits, the epoch the content was admitted under there.
// Merging is deliberately fail-closed:
//   - WITHIN one source, two constraints of the same kind that disagree on a
//     channel's epoch collapse that channel to UNKNOWN (drop it from the map).
//   - ACROSS sources (intersection), an epoch survives only when both sources
//     record it AND agree; one-sided or disagreeing epochs drop to UNKNOWN.
// An UNKNOWN admitted epoch is denied against an epoch-tracked destination and
// ignored against an untracked one — never a widening.

/**
 * Merge the admitted epochs a single source's constraint list records for one
 * room kind. Channels with an intra-source epoch disagreement are omitted
 * (UNKNOWN, fail closed). Only `channelId`-scoped kinds carry epochs.
 */
function mergeSourceEpochs(
  constraints: readonly DisclosureDestinationConstraint[],
  kind: DisclosureDestinationKind,
): Map<string, number> {
  if (DISCLOSURE_KIND_ID_FIELD[kind] !== 'channelId') return new Map();
  const epochs = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const constraint of constraints) {
    if (constraint.kind !== kind || !constraint.channelEpochs) continue;
    for (const [id, epoch] of Object.entries(constraint.channelEpochs)) {
      if (typeof epoch !== 'number' || !Number.isFinite(epoch)) continue;
      if (conflicted.has(id)) continue;
      const prior = epochs.get(id);
      if (prior === undefined) epochs.set(id, epoch);
      else if (prior !== epoch) { epochs.delete(id); conflicted.add(id); }
    }
  }
  return epochs;
}

/**
 * Intersect two already-merged per-source epoch maps: keep a channel's epoch
 * only when both sides record it and agree. Restricted to `keepIds` when the
 * surviving id-set is concrete (an UNRESTRICTED id-set carries no epochs).
 */
function intersectEpochs(
  left: Map<string, number>,
  right: Map<string, number>,
  keepIds: IdSet,
): Map<string, number> {
  const result = new Map<string, number>();
  const allow = keepIds === UNRESTRICTED ? null : new Set(keepIds);
  for (const [id, epoch] of left) {
    if (allow && !allow.has(id)) continue;
    if (right.get(id) === epoch) result.set(id, epoch);
  }
  return result;
}

function buildConstraint(
  kind: DisclosureDestinationKind,
  ids: IdSet,
  epochs?: Map<string, number>,
): DisclosureDestinationConstraint {
  const field = DISCLOSURE_KIND_ID_FIELD[kind];
  if (field === null || ids === UNRESTRICTED) return { kind };
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  if (field !== 'channelId') return { kind, contactIds: sorted };
  if (epochs && epochs.size > 0) {
    const channelEpochs: Record<string, number> = {};
    for (const id of sorted) {
      const epoch = epochs.get(id);
      if (epoch !== undefined) channelEpochs[id] = epoch;
    }
    if (Object.keys(channelEpochs).length > 0) return { kind, channelIds: sorted, channelEpochs };
  }
  return { kind, channelIds: sorted };
}

/**
 * Intersection of two sources' permission sets (§6.3). A kind survives only when
 * BOTH sources permit it; id-scoped kinds keep only the shared ids. When the
 * shared id-set is empty the kind is dropped entirely (no common destination).
 */
export function intersectDestinationConstraints(
  left: readonly DisclosureDestinationConstraint[],
  right: readonly DisclosureDestinationConstraint[],
): DisclosureDestinationConstraint[] {
  const result: DisclosureDestinationConstraint[] = [];
  for (const kind of DISCLOSURE_DESTINATION_KINDS) {
    const leftIds = mergeSourceIds(left, kind);
    const rightIds = mergeSourceIds(right, kind);
    if (leftIds === null || rightIds === null) continue;
    const merged = intersectIdSets(leftIds, rightIds);
    if (merged !== UNRESTRICTED && merged.length === 0) continue;
    const mergedEpochs = intersectEpochs(
      mergeSourceEpochs(left, kind),
      mergeSourceEpochs(right, kind),
      merged,
    );
    result.push(buildConstraint(kind, merged, mergedEpochs));
  }
  return result;
}

/**
 * Does a concrete destination survive an already-intersected permission set?
 * `companion_self` always passes — it is the private sink, gated by nothing.
 * This is the kind/id gate ONLY; the epoch disclosure boundary (rule 4) is the
 * separate `destinationEpochEligible` gate that `assessDisclosure` composes on
 * top, so this predicate's pre-epoch semantics are unchanged.
 */
export function destinationPermitted(
  constraints: readonly DisclosureDestinationConstraint[],
  destination: DisclosureDestination,
): boolean {
  if (destination.kind === 'companion_self') return true;
  const ids = mergeSourceIds(constraints, destination.kind);
  if (ids === null) return false;
  if (ids === UNRESTRICTED) return true;
  const targetId = destination.kind === 'contact_dm' ? destination.contactId : destination.channelId;
  return ids.includes(targetId);
}

/**
 * Epoch disclosure-boundary gate (rule 4, bible §9.3). Presumes the kind/id gate
 * (`destinationPermitted`) already passed. Returns:
 *   - `true` for non-room destinations (contact_dm, publication, companion_self):
 *     they carry no room-classification epoch.
 *   - `true` for a room destination with no tracked `currentEpoch`: the channel
 *     is not epoch-tracked, so eligibility is exactly the pre-epoch behavior.
 *   - otherwise `true` ONLY when the content's admitted epoch for that channel is
 *     known AND equals the destination's current epoch. An unknown admitted epoch
 *     (content predates or was not stamped for this epoch) or a mismatched one
 *     (content from a prior epoch of a since-widened room) fails closed.
 */
export function destinationEpochEligible(
  constraints: readonly DisclosureDestinationConstraint[],
  destination: DisclosureDestination,
): boolean {
  if (destination.kind !== 'invite_only_room' && destination.kind !== 'public_room') return true;
  if (destination.currentEpoch === undefined) return true;
  const admittedEpoch = mergeSourceEpochs(constraints, destination.kind).get(destination.channelId);
  return admittedEpoch !== undefined && admittedEpoch === destination.currentEpoch;
}

// ── Rule 3 + composition: accumulate and assess ──────────────────────────────

function deriveClassification(
  effectiveSensitivity: SensitivityLevel,
  sourceCount: number,
  hasUnclassifiedSource: boolean,
): DisclosureClassification {
  if (sourceCount === 0 || hasUnclassifiedSource) return 'non_shareable';
  if (effectiveSensitivity === 'public') return 'auto_shareable';
  if (effectiveSensitivity === 'personal') return 'restricted';
  return 'approval_required';
}

/**
 * Initial accumulator before any source is admitted: no usable lineage, fail
 * closed. `permittedDestinations` is empty (intersection identity is applied on
 * the first admitted source, not here) and sensitivity is the most restrictive
 * floor.
 */
export function beginDisclosureAccumulation(context: GenerationDisclosureContext): DisclosureLineage {
  return {
    provenanceRefs: [],
    sourceSnapshots: [],
    effectiveSensitivity: MOST_RESTRICTIVE_SENSITIVITY,
    permittedDestinations: [],
    subjectContactIds: [],
    sourceChannelIds: [],
    generationContextRef: context.generationContextRef,
    classification: 'non_shareable',
    classifiedAt: context.classifiedAt,
    classifierVersion: context.classifierVersion,
    sourceCount: 0,
    hasUnclassifiedSource: false,
  };
}

/**
 * Fold one admitted source into the accumulator (§9.2). Pure: sensitivity takes
 * the max (rule 1), permitted destinations intersect (rule 2), and any source
 * lacking usable lineage flips `hasUnclassifiedSource` so assessment fails
 * closed (rule 3). A later, more restrictive source tightens subsequent outputs.
 */
export function accumulateDisclosureSource(
  lineage: DisclosureLineage,
  contribution: DisclosureSourceContribution,
): DisclosureLineage {
  const isFirstSource = lineage.sourceCount === 0;
  const nextPermitted = isFirstSource
    ? normalizeConstraints(contribution.permittedDestinations)
    : intersectDestinationConstraints(lineage.permittedDestinations, contribution.permittedDestinations);

  const effectiveSensitivity = maxSensitivity([lineage.effectiveSensitivity, contribution.sensitivity]);
  // On the first source, replace the fail-closed floor with the source's actual
  // sensitivity; afterwards keep the running max.
  const nextSensitivity = isFirstSource ? contribution.sensitivity : effectiveSensitivity;

  const subjectContactIds = uniqueSorted([
    ...lineage.subjectContactIds,
    ...(contribution.subjectContactIds ?? []),
  ]);
  const sourceChannelIds = uniqueSorted([
    ...lineage.sourceChannelIds,
    ...(contribution.sourceChannelId ? [contribution.sourceChannelId] : []),
  ]);
  const provenanceRefs = uniqueSorted([
    ...lineage.provenanceRefs,
    ...(contribution.provenanceRefs ?? []),
    contribution.ref,
  ]);

  const snapshot: DisclosureSourceSnapshot = {
    ref: contribution.ref,
    sensitivity: contribution.sensitivity,
    permittedDestinations: normalizeConstraints(contribution.permittedDestinations),
    subjectContactIds: uniqueSorted(contribution.subjectContactIds ?? []),
    sourceChannelId: contribution.sourceChannelId,
    classified: contribution.classified,
  };

  const sourceCount = lineage.sourceCount + 1;
  const hasUnclassifiedSource = lineage.hasUnclassifiedSource || !contribution.classified;

  return {
    ...lineage,
    provenanceRefs,
    sourceSnapshots: [...lineage.sourceSnapshots, snapshot],
    effectiveSensitivity: nextSensitivity,
    permittedDestinations: nextPermitted,
    subjectContactIds,
    sourceChannelIds,
    classification: deriveClassification(nextSensitivity, sourceCount, hasUnclassifiedSource),
    sourceCount,
    hasUnclassifiedSource,
  };
}

/**
 * Destination-relative eligibility (§9.3). Composes all three rules:
 *
 *  - `companion_self` is always eligible (private sink), even unclassified.
 *  - No usable lineage, or any unclassified admitted source, fails closed to
 *    `non_shareable` for every outward destination (rule 3, §9.5).
 *  - Otherwise the destination must survive the intersected permission set
 *    (rule 2) AND sit at or below the destination's auto-shareable ceiling for
 *    the effective (most-restrictive) sensitivity (rule 1); content above the
 *    ceiling routes to `approval_required` rather than auto-release.
 */
export function assessDisclosure(
  lineage: DisclosureLineage | undefined,
  destination: DisclosureDestination,
): DisclosureDecision {
  const effectiveSensitivity = lineage?.effectiveSensitivity ?? MOST_RESTRICTIVE_SENSITIVITY;

  if (destination.kind === 'companion_self') {
    return decide(true, 'auto_shareable', destination, effectiveSensitivity,
      'companion-self is the private sink and always eligible');
  }

  if (!lineage || lineage.sourceCount === 0) {
    return decide(false, 'non_shareable', destination, effectiveSensitivity,
      'fail closed: no usable disclosure lineage (§9.5)');
  }

  if (lineage.hasUnclassifiedSource) {
    return decide(false, 'non_shareable', destination, effectiveSensitivity,
      'fail closed: an admitted source lacked usable lineage (§9.5)');
  }

  if (!destinationPermitted(lineage.permittedDestinations, destination)) {
    return decide(false, 'non_shareable', destination, effectiveSensitivity,
      'destination not in the intersected permitted-destination set (§6.3)');
  }

  // Rule 4: epoch disclosure boundary (§9.3). A room whose classification has
  // changed since the content was admitted opens a fresh disclosure epoch; prior-
  // epoch material is not auto-eligible and routes to human-in-the-loop egress
  // review (`approval_required`), never a hard non_shareable — it remains
  // shareable through review, just not automatically.
  if (!destinationEpochEligible(lineage.permittedDestinations, destination)) {
    return decide(false, 'approval_required', destination, effectiveSensitivity,
      'content admitted under a prior classification epoch is not auto-eligible after the '
        + "room's classification changed; route to human-in-the-loop egress review (§9.3)");
  }

  const ceiling = DESTINATION_AUTO_SHAREABLE_CEILING[destination.kind];
  if (sensitivityOrd(effectiveSensitivity) > sensitivityOrd(ceiling)) {
    return decide(false, 'approval_required', destination, effectiveSensitivity,
      `effective sensitivity ${effectiveSensitivity} exceeds ${destination.kind} auto-shareable ceiling ${ceiling}`);
  }

  return decide(true, 'auto_shareable', destination, effectiveSensitivity,
    'destination permitted and sensitivity within ceiling');
}

// ── internal helpers ─────────────────────────────────────────────────────────

function decide(
  allowed: boolean,
  outcome: DisclosureClassification,
  destination: DisclosureDestination,
  effectiveSensitivity: SensitivityLevel,
  reason: string,
): DisclosureDecision {
  return { allowed, outcome, destination, effectiveSensitivity, reason };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Canonicalize a source's constraint list into one merged constraint per kind
 * (unioning intra-source scopes) so stored snapshots and first-source lineage
 * are shaped identically to intersection output.
 */
function normalizeConstraints(
  constraints: readonly DisclosureDestinationConstraint[],
): DisclosureDestinationConstraint[] {
  const result: DisclosureDestinationConstraint[] = [];
  for (const kind of DISCLOSURE_DESTINATION_KINDS) {
    const ids = mergeSourceIds(constraints, kind);
    if (ids === null) continue;
    result.push(buildConstraint(kind, ids, mergeSourceEpochs(constraints, kind)));
  }
  return result;
}
