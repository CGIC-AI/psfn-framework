// ── CogSec outbound disclosure: destination-eligibility contract types ──
//
// The intake firewall (src/shared/contracts/intake-envelope.ts) already models
// the INBOUND axis: taint tiers, whole-output derivation taint, provenance
// chains, and sink gates. What it does not model is the OUTBOUND axis the
// free-time social-autonomy design requires (bible §9): which destinations a
// self-generated output may flow to.
//
// This module owns only the contract shapes for that outbound axis. The pure
// decision functions live in ./decision.ts; runtime accumulation/egress wiring
// is out of scope for this contract bead (bible §9.0/§13.3 — DisclosureLineage
// is a projection over CogSec, not a second store). Everything here fails
// closed: an output with no usable lineage is never automatically shareable
// (§9.5), effective sensitivity is the most restrictive admitted source (§6.3),
// and permitted destinations are the INTERSECTION of every admitted source's
// permission set, never the union (§6.3).

import type { SensitivityLevel } from '../../../system/trust/types.js';

// ── Destination taxonomy (bible §9.3) ──

/**
 * The disclosure destination classes a self-generated output can target.
 *
 * - `companion_self`     — the companion's own private store. The private sink:
 *                          always eligible, even for unclassified/restricted
 *                          content, because it stays private by construction.
 * - `contact_dm`         — a specific verified contact's direct-message channel.
 * - `invite_only_room`   — a specific ordinary invite-only group room.
 * - `public_room`        — a specific public/broadcast group room.
 * - `publication`        — autonomous outbound publication surface.
 */
export const DISCLOSURE_DESTINATION_KINDS = [
  'companion_self',
  'contact_dm',
  'invite_only_room',
  'public_room',
  'publication',
] as const;

export type DisclosureDestinationKind = typeof DISCLOSURE_DESTINATION_KINDS[number];

export function isDisclosureDestinationKind(value: unknown): value is DisclosureDestinationKind {
  return typeof value === 'string'
    && (DISCLOSURE_DESTINATION_KINDS as readonly string[]).includes(value);
}

/** Destination kinds that are scoped to a specific id (channel or contact). */
export const DISCLOSURE_KIND_ID_FIELD: Record<DisclosureDestinationKind, 'channelId' | 'contactId' | null> = {
  companion_self: null,
  contact_dm: 'contactId',
  invite_only_room: 'channelId',
  public_room: 'channelId',
  publication: null,
};

/**
 * A concrete outbound target being assessed. Id-bearing kinds carry the exact
 * channel/contact id so the intersected permission set can be checked against
 * the specific destination rather than the class alone.
 *
 * Room kinds additionally carry the channel's CURRENT classification epoch
 * (`currentEpoch`, jp36.6.3) when the channel is epoch-tracked. A room's epoch
 * increments whenever its classification is widened (invite-only → public); it
 * is the disclosure boundary (bible §9.3): content admitted under epoch N is
 * auto-eligible to the room only while the room is still at epoch N. `undefined`
 * means the channel carries no tracked epoch — the epoch gate then does not
 * engage and eligibility is exactly the pre-epoch behavior (fail closed on
 * missing epoch data means "no more permissive than before", never a widening).
 */
export type DisclosureDestination =
  | { readonly kind: 'companion_self' }
  | { readonly kind: 'contact_dm'; readonly contactId: string }
  | { readonly kind: 'invite_only_room'; readonly channelId: string; readonly currentEpoch?: number }
  | { readonly kind: 'public_room'; readonly channelId: string; readonly currentEpoch?: number }
  | { readonly kind: 'publication' };

/**
 * A single permission entry contributed by an admitted source: "content from
 * me may reach destinations of `kind`". For id-bearing kinds the permission may
 * be scoped to specific ids (`channelIds` / `contactIds`); omitting the id list
 * means "any destination of this kind". The accumulated lineage's
 * `permittedDestinations` is the INTERSECTION of every source's constraint set.
 */
export interface DisclosureDestinationConstraint {
  readonly kind: DisclosureDestinationKind;
  /** Scoping for room kinds (`invite_only_room`, `public_room`). */
  readonly channelIds?: readonly string[];
  /** Scoping for the `contact_dm` kind. */
  readonly contactIds?: readonly string[];
  /**
   * Per-channel classification epoch the content was admitted under, keyed by a
   * channelId that MUST also appear in `channelIds` (jp36.6.3). Only meaningful
   * for room kinds. A channelId absent from this map has an UNKNOWN admitted
   * epoch: against an epoch-tracked destination it fails closed (denied auto-
   * share), against an untracked destination it behaves exactly as pre-epoch.
   * The map only ever tightens under intersection — an epoch survives merge only
   * when every source agrees on it; disagreement drops to unknown (fail closed).
   */
  readonly channelEpochs?: Readonly<Record<string, number>>;
}

// ── Classification / decision vocabulary (bible §9.1) ──

/**
 * Coarse content-side classification of an accumulated lineage. The
 * destination-relative allow decision is `assessDisclosure`, not this field;
 * this is the shareability posture independent of any specific destination.
 */
export const DISCLOSURE_CLASSIFICATIONS = [
  'auto_shareable',
  'restricted',
  'approval_required',
  'non_shareable',
] as const;

export type DisclosureClassification = typeof DISCLOSURE_CLASSIFICATIONS[number];

export function isDisclosureClassification(value: unknown): value is DisclosureClassification {
  return typeof value === 'string'
    && (DISCLOSURE_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Materialized policy facts for one admitted source, captured at generation
 * time (bible §9.1: snapshots prove HOW an artifact was classified; the live
 * source is still rechecked at egress, so a snapshot never freezes expired
 * consent or a now-invalid destination).
 */
export interface DisclosureSourceSnapshot {
  readonly ref: string;
  readonly sensitivity: SensitivityLevel;
  readonly permittedDestinations: readonly DisclosureDestinationConstraint[];
  readonly subjectContactIds: readonly string[];
  readonly sourceChannelId?: string;
  /** False when the source carried no usable lineage — taints the whole context unclassified (§9.5). */
  readonly classified: boolean;
}

/**
 * One source's contribution folded into an accumulator. This is the pure input
 * shape callers (session history, memory, wiki/journal/project, tool results —
 * wired in later beads) hand to `accumulateDisclosureSource`.
 */
export interface DisclosureSourceContribution {
  readonly ref: string;
  readonly sensitivity: SensitivityLevel;
  readonly permittedDestinations: readonly DisclosureDestinationConstraint[];
  readonly subjectContactIds?: readonly string[];
  readonly sourceChannelId?: string;
  readonly provenanceRefs?: readonly string[];
  /**
   * Whether the source carried usable disclosure lineage. A source admitted
   * WITHOUT usable lineage (`false`) taints the entire generation context as
   * unclassified and forces fail-closed at assessment (§9.2 step 3, §9.5).
   */
  readonly classified: boolean;
}

/**
 * Context under which a generation begins. Timestamps/classifier version are
 * runtime-stamped and carried through the pure fold unchanged.
 */
export interface GenerationDisclosureContext {
  readonly generationContextRef: string;
  readonly classifierVersion: string;
  readonly classifiedAt: string;
}

/**
 * The accumulated disclosure projection over an intake-envelope generation
 * context (bible §9.1). Populated by folding source contributions; it is a
 * view, not a second provenance store.
 */
export interface DisclosureLineage {
  readonly provenanceRefs: readonly string[];
  readonly sourceSnapshots: readonly DisclosureSourceSnapshot[];
  readonly effectiveSensitivity: SensitivityLevel;
  readonly permittedDestinations: readonly DisclosureDestinationConstraint[];
  readonly subjectContactIds: readonly string[];
  readonly sourceChannelIds: readonly string[];
  readonly generationContextRef: string;
  readonly classification: DisclosureClassification;
  readonly classifiedAt: string;
  readonly classifierVersion: string;
  /** Count of admitted sources; zero means no usable lineage — fail closed (§9.5). */
  readonly sourceCount: number;
  /** True when any admitted source lacked usable lineage — forces fail-closed. */
  readonly hasUnclassifiedSource: boolean;
}

/** Result of a destination-relative eligibility assessment. */
export interface DisclosureDecision {
  /** True only when the output may flow to the destination without human review. */
  readonly allowed: boolean;
  readonly outcome: DisclosureClassification;
  readonly destination: DisclosureDestination;
  readonly effectiveSensitivity: SensitivityLevel;
  readonly reason: string;
}
