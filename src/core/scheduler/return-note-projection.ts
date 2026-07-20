// ── Destination-eligible return-note summarizer projection (bible §15.2 / §10.8) ──
//
// A free-time block runs on the companion's own INTERNAL channel with a broad,
// mixed-lineage transcript (private self-retrieval may draw on many contacts'
// material across turns). When that block ends, a "while you were away" return
// note is surfaced. The summarizer that writes that note must NOT see the broad
// private transcript when the note's DESTINATION cannot lawfully receive all of
// it (bible §15.2): a note bound for contact A's DM must never be summarized
// from a turn whose disclosure lineage belongs to contact B.
//
// This module owns the PROJECTION half of jp36.2.3: given the completed block's
// evidence (each transcript entry paired with its captured per-turn
// DisclosureLineage) and the note's resolved DISCLOSURE DESTINATION, it returns
// only the evidence eligible for that destination — the exact input the bounded
// summarizer may read. The ROUTING half (resolving the destination from the
// workspace return policy, choosing the append target, system-note attribution,
// non-initiation) is the sibling bead jp36.2.3.1; this module is destination-in,
// eligible-evidence-out and never decides where the note lands.
//
// It rides the landed CogSec disclosure decision layer (jp36.1,
// `assessDisclosure`) for eligibility — there is NO parallel classification
// here. Fail-closed posture (charter / AGENTS.md):
//
//   - `companion_self` (private/self) is the private sink: full fidelity, every
//     entry is eligible, even entries without usable lineage. Private work keeps
//     its detail (bible §15.3 single-partner experience).
//   - `publication` return notes carry publication STATE, not transcript
//     content (bible §10.8 rows 4-5): the projection yields NO content evidence,
//     so routing surfaces only a state update, never a broad self-disclosure.
//   - Every other outward destination (contact DM, invite-only room, public
//     room) admits an entry ONLY when `assessDisclosure(entry.lineage,
//     destination).allowed` holds. An entry with no lineage, an unclassified
//     source, an unrelated subject contact, or a non-permitted destination is
//     dropped. If NOTHING survives, the note COLLAPSES to the private/self form
//     — a content-free "spent some time on my own" note — rather than leaking a
//     broad summary to a destination that could not receive it.

import type { SessionEntry } from '../session/types.js';
import {
  assessDisclosure,
  type DisclosureDestination,
  type DisclosureLineage,
} from '../cogsec/disclosure/index.js';

/**
 * One free-time transcript entry paired with its captured per-turn disclosure
 * lineage. `lineage` is `undefined` when no usable lineage was captured for that
 * turn — which fails closed for every OUTWARD destination (the entry is dropped)
 * while remaining fully eligible for the `companion_self` private sink.
 */
export interface ReturnNoteEvidenceItem {
  readonly entry: SessionEntry;
  readonly lineage: DisclosureLineage | undefined;
}

/**
 * How the routing layer should render the return note for this destination:
 *
 * - `content`          — summarize `eligibleEntries` into the destination.
 * - `state_only`       — publication state update; NO transcript content.
 * - `collapsed_private`— fail-closed collapse: nothing was eligible for the
 *                        requested outward destination, so the note keeps to the
 *                        companion's own space as a content-free self note.
 */
export type ReturnNoteProjectionMode = 'content' | 'state_only' | 'collapsed_private';

/** The eligible-evidence projection the bounded summarizer / routing consumes. */
export interface ReturnNoteProjection {
  /**
   * The destination the projection is scoped to AFTER any fail-closed collapse.
   * On a collapse this is `{ kind: 'companion_self' }`, never the requested
   * outward destination.
   */
  readonly destination: DisclosureDestination;
  readonly mode: ReturnNoteProjectionMode;
  /**
   * Entries the summarizer may read for this destination. Non-empty only in
   * `content` mode; empty for `state_only` and `collapsed_private` so no
   * transcript ever reaches a summary the destination could not receive.
   */
  readonly eligibleEntries: readonly SessionEntry[];
  /** True when the requested outward destination was collapsed to private/self. */
  readonly collapsed: boolean;
  /** Human-readable rationale for telemetry / audit. */
  readonly reason: string;
}

/**
 * Project a completed free-time block's evidence down to the subset eligible for
 * the return note's resolved disclosure destination.
 *
 * The requested `destination` is authoritative input from the routing layer
 * (jp36.2.3.1); this function only NARROWS what the summarizer may read for it,
 * and can never widen the destination or invent a new one. See the module header
 * for the full fail-closed contract.
 */
export function projectReturnNoteEvidence(input: {
  readonly evidence: readonly ReturnNoteEvidenceItem[];
  readonly destination: DisclosureDestination;
}): ReturnNoteProjection {
  const { evidence, destination } = input;

  // Private sink: full fidelity. Every entry is eligible regardless of lineage,
  // because a companion-self note stays private by construction (§9.3, §15.3).
  if (destination.kind === 'companion_self') {
    return {
      destination,
      mode: 'content',
      eligibleEntries: evidence.map(item => item.entry),
      collapsed: false,
      reason: 'companion-self is the private sink — full-fidelity return note',
    };
  }

  // Publication return notes carry publication STATE, not transcript content
  // (§10.8): the projection intentionally yields no content evidence so routing
  // can only surface a state update, never a broad self-disclosure.
  if (destination.kind === 'publication') {
    return {
      destination,
      mode: 'state_only',
      eligibleEntries: [],
      collapsed: false,
      reason: 'publication return note carries state, not transcript content (§10.8)',
    };
  }

  // Every other outward destination: admit an entry ONLY when the landed
  // disclosure decision layer allows THIS entry's lineage to reach THIS exact
  // destination. Fail closed per entry (no lineage / unclassified / unrelated
  // subject / not permitted all resolve to `allowed: false` inside
  // `assessDisclosure`).
  const eligibleEntries = evidence
    .filter(item => assessDisclosure(item.lineage, destination).allowed)
    .map(item => item.entry);

  if (eligibleEntries.length === 0) {
    // Nothing was eligible for the requested outward destination: collapse to
    // the private/self form rather than leaking a summary the destination could
    // not receive (§10.8 "keep private, or surface only a content-free note").
    return {
      destination: { kind: 'companion_self' },
      mode: 'collapsed_private',
      eligibleEntries: [],
      collapsed: true,
      reason: `no destination-eligible evidence for ${destination.kind}; collapsed to private/self form (§10.8)`,
    };
  }

  return {
    destination,
    mode: 'content',
    eligibleEntries,
    collapsed: false,
    reason: `projected ${eligibleEntries.length} destination-eligible entr${eligibleEntries.length === 1 ? 'y' : 'ies'} for ${destination.kind}`,
  };
}
