import { describe, expect, it } from 'vitest';
import { VALID_SOCIAL_RELATIONSHIP_KINDS } from './types.js';
import {
  SOCIAL_RELATIONSHIP_CLASSIFICATION,
  SYMMETRIC_SOCIAL_RELATIONSHIP_KINDS,
  classifySocialRelationship,
  effectiveEdgeDirectional,
  inverseRelationshipKind,
  isGenuinelyDirectionalRelationship,
  isInversePairRelationship,
  isSymmetricRelationship,
} from './social-relationship-classification.js';

describe('social-relationship classification table', () => {
  it('classifies every kind in the union (exhaustive)', () => {
    for (const kind of VALID_SOCIAL_RELATIONSHIP_KINDS) {
      const classification = SOCIAL_RELATIONSHIP_CLASSIFICATION[kind];
      expect(classification, `missing classification for ${kind}`).toBeDefined();
      expect(classification.rationale.length).toBeGreaterThan(0);
    }
    // No stray keys beyond the union.
    expect(Object.keys(SOCIAL_RELATIONSHIP_CLASSIFICATION).sort())
      .toEqual([...VALID_SOCIAL_RELATIONSHIP_KINDS].sort());
  });

  it('locks the symmetric set', () => {
    const symmetric = VALID_SOCIAL_RELATIONSHIP_KINDS.filter(isSymmetricRelationship).sort();
    expect(symmetric).toEqual(
      ['acquaintance', 'colleague', 'family', 'friend', 'household', 'partner', 'sibling'].sort(),
    );
    expect([...SYMMETRIC_SOCIAL_RELATIONSHIP_KINDS].sort()).toEqual(symmetric);
  });

  it('locks the inverse-pair set and its reciprocals', () => {
    const inversePairs = VALID_SOCIAL_RELATIONSHIP_KINDS.filter(isInversePairRelationship).sort();
    expect(inversePairs).toEqual(['child', 'direct_report', 'manager', 'parent'].sort());
    expect(inverseRelationshipKind('parent')).toBe('child');
    expect(inverseRelationshipKind('child')).toBe('parent');
    expect(inverseRelationshipKind('manager')).toBe('direct_report');
    expect(inverseRelationshipKind('direct_report')).toBe('manager');
  });

  it('locks the genuinely-directional set (caregiver, other) with no inverse', () => {
    const directional = VALID_SOCIAL_RELATIONSHIP_KINDS.filter(isGenuinelyDirectionalRelationship).sort();
    expect(directional).toEqual(['caregiver', 'other'].sort());
    expect(inverseRelationshipKind('caregiver')).toBeUndefined();
    expect(inverseRelationshipKind('other')).toBeUndefined();
  });

  it('has an involutive inverse relation (inverse(inverse(k)) === k)', () => {
    for (const kind of VALID_SOCIAL_RELATIONSHIP_KINDS) {
      const inverse = inverseRelationshipKind(kind);
      if (!inverse) continue;
      expect(inverseRelationshipKind(inverse)).toBe(kind);
      // Reciprocal must itself be classified inverse_pair.
      expect(classifySocialRelationship(inverse).directionality).toBe('inverse_pair');
    }
  });

  it('only inverse_pair kinds carry an inverse', () => {
    for (const kind of VALID_SOCIAL_RELATIONSHIP_KINDS) {
      const classification = classifySocialRelationship(kind);
      if (classification.directionality === 'inverse_pair') {
        expect(classification.inverse).toBeDefined();
      } else {
        expect(classification.inverse).toBeUndefined();
      }
    }
  });

  it('derives the effective stored directional flag per class', () => {
    // Symmetric: always undirected, even if directional:true requested.
    expect(effectiveEdgeDirectional('friend', true)).toBe(false);
    expect(effectiveEdgeDirectional('friend', undefined)).toBe(false);
    // Inverse pair: always directional.
    expect(effectiveEdgeDirectional('parent', false)).toBe(true);
    expect(effectiveEdgeDirectional('parent', undefined)).toBe(true);
    // Genuinely directional: respect caller, default true.
    expect(effectiveEdgeDirectional('caregiver', undefined)).toBe(true);
    expect(effectiveEdgeDirectional('other', false)).toBe(false);
    expect(effectiveEdgeDirectional('other', true)).toBe(true);
  });
});
