// ── Social-relationship directionality classification (E4.3) ──
// Canonical, exhaustive classification of every SocialRelationshipKind into one
// of three directionality classes. This table is the single source of truth for
// how an edge of a given type is REPRESENTED and kept consistent:
//
//   symmetric            — the relation is inherently mutual (A is B's <k> iff
//                          B is A's <k>). Stored as ONE undirected row
//                          (directional=false) with canonical endpoint ordering.
//                          A symmetric type written with directional:true is
//                          NORMALIZED to undirected (never rejected) — the
//                          direction carries no meaning for these kinds.
//
//   inverse_pair         — the relation is directional AND has a distinct named
//                          inverse kind that is itself a member of the union
//                          (parent<->child, manager<->direct_report). Stored as
//                          TWO directional rows: the written edge (A->B, kind)
//                          and a linked MIRROR (B->A, inverse) that shares
//                          confidence / evidence / sensitivity / provenance.
//
//   genuinely_directional — the relation is directional with NO representable
//                          inverse kind in the union (caregiver: the
//                          care-recipient/dependent role is not a kind), OR is an
//                          unclassifiable catch-all where no symmetry or inverse
//                          claim can be justified (other). Stored as written, as
//                          a single row, with no mirror.
//
// Exhaustiveness is enforced at COMPILE TIME: the table is typed as
// Record<SocialRelationshipKind, …>, so adding a new kind to the union without
// classifying it here is a type error. A runtime test additionally asserts the
// inverse relation is involutive (inverse(inverse(k)) === k).

import type { SocialRelationshipKind } from './types.js';
import { VALID_SOCIAL_RELATIONSHIP_KINDS } from './types.js';

export type SocialRelationshipDirectionality =
  | 'symmetric'
  | 'inverse_pair'
  | 'genuinely_directional';

export interface SocialRelationshipClassification {
  directionality: SocialRelationshipDirectionality;
  /** Present iff directionality === 'inverse_pair': the reciprocal kind. */
  inverse?: SocialRelationshipKind;
  /** Human-readable justification for this classification (esp. judgment calls). */
  rationale: string;
}

/**
 * Canonical classification table. Exhaustive over SocialRelationshipKind by
 * construction (Record key type) — a new kind added to the union forces a
 * classification here or the build fails.
 */
export const SOCIAL_RELATIONSHIP_CLASSIFICATION:
  Readonly<Record<SocialRelationshipKind, SocialRelationshipClassification>> = {
    // ── Symmetric (mutual; one undirected row) ──
    partner: {
      directionality: 'symmetric',
      rationale: 'Partnership is mutual: A is B\'s partner iff B is A\'s partner.',
    },
    friend: {
      directionality: 'symmetric',
      rationale: 'Friendship is mutual by convention.',
    },
    acquaintance: {
      directionality: 'symmetric',
      rationale: 'Acquaintance is mutual: knowing-of is symmetric.',
    },
    colleague: {
      directionality: 'symmetric',
      rationale: 'Being colleagues is a shared peer relation, mutual by definition.',
    },
    sibling: {
      directionality: 'symmetric',
      rationale: 'Siblinghood is mutual: A is B\'s sibling iff B is A\'s sibling.',
    },
    household: {
      directionality: 'symmetric',
      rationale: 'Shared-household membership (roommates/housemates) is mutual.',
    },
    family: {
      // Judgment call: "family" is the coarse catch-all for kin whose specific
      // role is unknown (cousin/aunt/in-law/…). Although the specific role may
      // be asymmetric (aunt/nephew), the RELATION recorded here is
      // shared-kinship-group membership, which is mutual: A is B's family iff
      // B is A's family. So it is classified symmetric. Fine-grained asymmetric
      // kin roles are out of scope of the current union.
      directionality: 'symmetric',
      rationale: 'Coarse kin-group membership is mutual; specific asymmetric roles are not modeled as kinds.',
    },

    // ── Inverse pair (directional; linked mirror row) ──
    parent: {
      directionality: 'inverse_pair',
      inverse: 'child',
      rationale: 'A is B\'s parent iff B is A\'s child.',
    },
    child: {
      directionality: 'inverse_pair',
      inverse: 'parent',
      rationale: 'A is B\'s child iff B is A\'s parent.',
    },
    manager: {
      directionality: 'inverse_pair',
      inverse: 'direct_report',
      rationale: 'A manages B iff B is A\'s direct report.',
    },
    direct_report: {
      directionality: 'inverse_pair',
      inverse: 'manager',
      rationale: 'A reports to B iff B manages A.',
    },

    // ── Genuinely directional (directional; no mirror) ──
    caregiver: {
      // Judgment call: caregiver is directional (A cares for B). Its natural
      // inverse — the care-recipient / dependent / ward role — is NOT a member
      // of SocialRelationshipKind, so no mirror can be represented. Rather than
      // invent an unmodeled kind or mis-map it to an existing one, caregiver is
      // classified genuinely_directional and stored as a single directional row.
      directionality: 'genuinely_directional',
      rationale: 'Directional care relation whose reciprocal (care-recipient) is not a modeled kind, so no mirror is stored.',
    },
    other: {
      // Judgment call: "other" is the unclassifiable escape hatch. We can make
      // no principled symmetry or inverse claim about an unknown relation, so it
      // is stored exactly as written (respecting the caller's directional flag)
      // with no normalization beyond canonical endpoint ordering when undirected.
      directionality: 'genuinely_directional',
      rationale: 'Unknown/unclassifiable relation; no symmetry or inverse can be justified, so the row is stored verbatim.',
    },
  };

export function classifySocialRelationship(
  kind: SocialRelationshipKind,
): SocialRelationshipClassification {
  return SOCIAL_RELATIONSHIP_CLASSIFICATION[kind];
}

export function isSymmetricRelationship(kind: SocialRelationshipKind): boolean {
  return classifySocialRelationship(kind).directionality === 'symmetric';
}

export function isInversePairRelationship(kind: SocialRelationshipKind): boolean {
  return classifySocialRelationship(kind).directionality === 'inverse_pair';
}

export function isGenuinelyDirectionalRelationship(kind: SocialRelationshipKind): boolean {
  return classifySocialRelationship(kind).directionality === 'genuinely_directional';
}

/** The reciprocal kind for an inverse_pair kind, else undefined. */
export function inverseRelationshipKind(
  kind: SocialRelationshipKind,
): SocialRelationshipKind | undefined {
  return classifySocialRelationship(kind).inverse;
}

/**
 * Effective stored `directional` flag for an edge of the given type. Symmetric
 * kinds are always undirected; inverse-pair kinds are always directional;
 * genuinely-directional kinds respect the caller-requested flag (default true).
 */
export function effectiveEdgeDirectional(
  kind: SocialRelationshipKind,
  requestedDirectional: boolean | undefined,
): boolean {
  const classification = classifySocialRelationship(kind);
  if (classification.directionality === 'symmetric') return false;
  if (classification.directionality === 'inverse_pair') return true;
  return requestedDirectional ?? true;
}

/** Symmetric kinds as a set — single source of truth for the graph-builder worker. */
export const SYMMETRIC_SOCIAL_RELATIONSHIP_KINDS: ReadonlySet<SocialRelationshipKind> = new Set(
  VALID_SOCIAL_RELATIONSHIP_KINDS.filter(isSymmetricRelationship),
);
