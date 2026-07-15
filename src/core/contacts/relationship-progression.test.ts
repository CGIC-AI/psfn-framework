import { describe, expect, it } from 'vitest';
import {
  evaluateRelationshipProgressionSuggestion,
  isManualRelationshipMutationAuthorized,
} from './relationship-progression.js';

describe('relationship progression policy', () => {
  it('makes stranger to acquaintance low-friction without requiring identity verification', () => {
    expect(evaluateRelationshipProgressionSuggestion('stranger', {
      positiveInteractionCount: 3,
      negativeInteractionCount: 1,
      verifiedIdentityLinks: 0,
      consistentBoundaryRespect: true,
    })).toMatchObject({
      fromRelationshipType: 'stranger',
      suggestedRelationshipType: 'acquaintance',
      requiresApproval: false,
    });
  });

  it('requires substantially stronger evidence to progress from acquaintance to friend', () => {
    expect(evaluateRelationshipProgressionSuggestion('acquaintance', {
      positiveInteractionCount: 3,
      negativeInteractionCount: 0,
      consistentBoundaryRespect: true,
    })).toBeNull();

    expect(evaluateRelationshipProgressionSuggestion('acquaintance', {
      positiveInteractionCount: 12,
      negativeInteractionCount: 1,
      consistentBoundaryRespect: true,
    })).toMatchObject({
      fromRelationshipType: 'acquaintance',
      suggestedRelationshipType: 'friend',
      requiresApproval: false,
    });
  });

  it('fails closed when boundary-respect evidence is absent', () => {
    expect(evaluateRelationshipProgressionSuggestion('stranger', {
      positiveInteractionCount: 100,
      negativeInteractionCount: 0,
    })).toBeNull();
  });

  it('marks family and partner progressions as approval-gated', () => {
    expect(evaluateRelationshipProgressionSuggestion('friend', {
      positiveInteractionCount: 24,
      negativeInteractionCount: 0,
      consistentBoundaryRespect: true,
    })).toMatchObject({ suggestedRelationshipType: 'family', requiresApproval: true });

    expect(evaluateRelationshipProgressionSuggestion('family', {
      positiveInteractionCount: 48,
      negativeInteractionCount: 0,
      consistentBoundaryRespect: true,
    })).toMatchObject({ suggestedRelationshipType: 'partner', requiresApproval: true });
  });

  it('does not progress machine-intelligence or terminal partner classifications', () => {
    expect(evaluateRelationshipProgressionSuggestion('ai_companion', {
      positiveInteractionCount: 100,
      consistentBoundaryRespect: true,
    })).toBeNull();
    expect(evaluateRelationshipProgressionSuggestion('partner', {
      positiveInteractionCount: 100,
      consistentBoundaryRespect: true,
    })).toBeNull();
  });

  it('requires an explicit manual actor for gated relationship writes', () => {
    expect(isManualRelationshipMutationAuthorized('operator:confirmation-queue')).toBe(true);
    expect(isManualRelationshipMutationAuthorized('admin:api')).toBe(true);
    expect(isManualRelationshipMutationAuthorized('agent:tool:contact_set_relationship')).toBe(false);
    expect(isManualRelationshipMutationAuthorized('system:memory_extraction')).toBe(false);
    expect(isManualRelationshipMutationAuthorized(undefined)).toBe(false);
  });
});
