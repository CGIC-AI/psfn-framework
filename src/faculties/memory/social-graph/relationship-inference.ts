// ── Relationship-type inference for the graph-builder worker (E4.2) ──
// Fine-grained keyword → SocialRelationshipKind mapping used by the
// named-relationship evidence class. This extends the coarse
// inferRelationshipTypeFromFact usage (mention-only-contacts.ts) with the
// finer social-graph kinds (sibling/parent/child/…).
//
// Directionality convention: a directional edge (source, target, kind) reads
// "target is source's <kind>". Symmetric kinds are emitted as a single
// UNDIRECTED edge (directional=false), which in the social-graph schema IS
// bidirectional (listRelatedContactIds returns the other endpoint regardless of
// stored order) — so one undirected proposal already represents "both ways".
// Asymmetric kinds are single-direction (directional=true); the inverse edge
// (e.g. `child` as the inverse of `parent`, `direct_report` for `manager`) is
// intentionally NOT emitted here — the full symmetric/inverse table is bead
// E4.3.

import type { RelationshipType, SocialRelationshipKind } from '../../../core/contacts/types.js';
import {
  SYMMETRIC_SOCIAL_RELATIONSHIP_KINDS,
  isSymmetricRelationship,
} from '../../../core/contacts/social-relationship-classification.js';

export interface RelationshipKindInference {
  kind: SocialRelationshipKind;
  /** false => undirected symmetric edge (bidirectional); true => single direction. */
  directional: boolean;
}

/**
 * Symmetric social-graph kinds: represented as one undirected edge. The
 * canonical classification (symmetric / inverse_pair / genuinely_directional)
 * now lives in core/contacts/social-relationship-classification.ts (E4.3); this
 * re-export preserves the worker's existing import surface.
 */
export { SYMMETRIC_SOCIAL_RELATIONSHIP_KINDS };

export function isSymmetricSocialRelationshipKind(kind: SocialRelationshipKind): boolean {
  return isSymmetricRelationship(kind);
}

// Ordered fine-grained rules: first match wins. Kept intentionally conservative —
// a keyword must be present for a typed named-relationship proposal.
const FINE_KEYWORD_RULES: ReadonlyArray<readonly [RegExp, SocialRelationshipKind]> = [
  [/\b(sisters?|brothers?|siblings?|sis|bro)\b/i, 'sibling'],
  [/\b(mom|mum|mother|dad|father|parents?|stepmother|stepfather)\b/i, 'parent'],
  [/\b(sons?|daughters?|children|child|kids?)\b/i, 'child'],
  [/\b(husband|wife|spouse|partner|boyfriend|girlfriend|fiance[ée]?)\b/i, 'partner'],
  [/\b(best friends?|friends?|buddy|pal)\b/i, 'friend'],
  [/\b(coworkers?|colleagues?|classmates?|teammates?)\b/i, 'colleague'],
  [/\b(roommates?|housemates?|flatmates?)\b/i, 'household'],
  [/\b(managers?|bosses|boss|supervisors?)\b/i, 'manager'],
  [/\b(direct reports?|reports? to|subordinates?)\b/i, 'direct_report'],
  [/\b(caregivers?|carers?|nurses?|guardians?)\b/i, 'caregiver'],
  [/\b(cousins?|aunts?|uncles?|nieces?|nephews?|grand(?:mother|father|ma|pa|parents?)|in-?law|relatives?)\b/i, 'family'],
  [/\b(neighbou?rs?)\b/i, 'acquaintance'],
];

/**
 * Fine-grained named-relationship inference. Returns undefined when no
 * relationship keyword is present (the caller then falls back to acquaintance
 * or skips, per evidence class).
 */
export function inferSocialRelationshipKindFromText(text: string): RelationshipKindInference | undefined {
  for (const [pattern, kind] of FINE_KEYWORD_RULES) {
    if (pattern.test(text)) {
      return { kind, directional: !isSymmetricSocialRelationshipKind(kind) };
    }
  }
  return undefined;
}

const COARSE_TYPE_TO_KIND: Readonly<Record<RelationshipType, SocialRelationshipKind>> = {
  partner: 'partner',
  family: 'family',
  friend: 'friend',
  acquaintance: 'acquaintance',
  stranger: 'acquaintance',
  ai_companion: 'other',
};

/** Coarse RelationshipType (inferRelationshipTypeFromFact output) → kind. All symmetric. */
export function coarseRelationshipTypeToKind(type: RelationshipType): SocialRelationshipKind {
  return COARSE_TYPE_TO_KIND[type];
}
