import { describe, it, expect } from 'vitest';
import type { EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';
import {
  computeContactRelationshipScore,
  createContactRelationshipScoreReader,
  deriveTrustDriftBehaviorSignals,
  evaluateContactTrustDriftCandidate,
} from './trust-drift-signals.js';

function point(valence: number, confidence = 0.8, observedAtMs = 1_000): EmotionalTimeSeriesPoint {
  return { valence, confidence, observedAtMs };
}

describe('deriveTrustDriftBehaviorSignals', () => {
  it('counts positive and negative interactions from the valence series', () => {
    const signals = deriveTrustDriftBehaviorSignals({
      timeSeries: [point(0.4), point(0.2), point(0.15), point(-0.2), point(0.05)],
      verifiedIdentityLinkCount: 2,
    });
    expect(signals.positiveInteractionCount).toBe(3);
    expect(signals.negativeInteractionCount).toBe(1);
    expect(signals.verifiedIdentityLinks).toBe(2);
    expect(signals.consistentBoundaryRespect).toBe(true);
  });

  it('ignores low-confidence points in both directions', () => {
    const signals = deriveTrustDriftBehaviorSignals({
      timeSeries: [point(0.5, 0.2), point(-0.5, 0.1), point(0.5, 0.8)],
      verifiedIdentityLinkCount: 0,
    });
    expect(signals.positiveInteractionCount).toBe(1);
    expect(signals.negativeInteractionCount).toBe(0);
    expect(signals.consistentBoundaryRespect).toBe(true);
  });

  it('flags a boundary breach on strongly negative points', () => {
    const signals = deriveTrustDriftBehaviorSignals({
      timeSeries: [point(0.3), point(-0.45)],
      verifiedIdentityLinkCount: 1,
    });
    expect(signals.consistentBoundaryRespect).toBe(false);
    expect(signals.negativeInteractionCount).toBe(1);
  });

  it('produces non-promoting signals from empty evidence', () => {
    const signals = deriveTrustDriftBehaviorSignals({
      timeSeries: [],
      verifiedIdentityLinkCount: 0,
    });
    expect(signals.positiveInteractionCount).toBe(0);
    expect(signals.verifiedIdentityLinks).toBe(0);
    expect(signals.consistentBoundaryRespect).toBe(true);
  });

  it('normalizes a non-finite verified link count to zero', () => {
    const signals = deriveTrustDriftBehaviorSignals({
      timeSeries: [],
      verifiedIdentityLinkCount: Number.NaN,
    });
    expect(signals.verifiedIdentityLinks).toBe(0);
  });
});

describe('evaluateContactTrustDriftCandidate', () => {
  const promotableEvidence = {
    timeSeries: [point(0.4), point(0.3), point(0.25)],
    verifiedIdentityLinkCount: 1,
  };

  it('suggests public -> regular when the policy thresholds are met', () => {
    const candidate = evaluateContactTrustDriftCandidate({
      contact: { id: 'c1', displayName: 'Fixture Contact', trustLevel: 'public' },
      evidence: promotableEvidence,
    });
    expect(candidate).not.toBeNull();
    expect(candidate?.suggestion.suggestedTrustLevel).toBe('regular');
    expect(candidate?.suggestion.requiresConfirmation).toBe(true);
  });

  it('returns null when evidence is insufficient', () => {
    const candidate = evaluateContactTrustDriftCandidate({
      contact: { id: 'c1', displayName: 'Fixture Contact', trustLevel: 'public' },
      evidence: { timeSeries: [point(0.4)], verifiedIdentityLinkCount: 1 },
    });
    expect(candidate).toBeNull();
  });

  it('never evaluates high-tier contacts', () => {
    for (const trustLevel of ['trusted', 'primary'] as const) {
      expect(evaluateContactTrustDriftCandidate({
        contact: { id: 'c1', displayName: 'Fixture Contact', trustLevel },
        evidence: promotableEvidence,
      })).toBeNull();
    }
  });

  it('suggests a defensive regular -> public drift on repeated negatives', () => {
    const candidate = evaluateContactTrustDriftCandidate({
      contact: { id: 'c2', displayName: 'Fixture Contact', trustLevel: 'regular' },
      evidence: { timeSeries: [point(-0.3), point(-0.25)], verifiedIdentityLinkCount: 0 },
    });
    expect(candidate?.suggestion.suggestedTrustLevel).toBe('public');
  });
});

describe('computeContactRelationshipScore', () => {
  it('reports full progress for a public contact meeting all thresholds', () => {
    const score = computeContactRelationshipScore({
      trustLevel: 'public',
      signals: {
        positiveInteractionCount: 3,
        negativeInteractionCount: 0,
        verifiedIdentityLinks: 1,
        consistentBoundaryRespect: true,
      },
    });
    expect(score.resolvedTier).toBe('public');
    expect(score.nextTier).toBe('regular');
    expect(score.progressToNextTier).toBe(1);
  });

  it('reports partial progress for partial evidence', () => {
    const score = computeContactRelationshipScore({
      trustLevel: 'public',
      signals: {
        positiveInteractionCount: 1,
        negativeInteractionCount: 0,
        verifiedIdentityLinks: 0,
        consistentBoundaryRespect: true,
      },
    });
    expect(score.progressToNextTier).toBeGreaterThan(0);
    expect(score.progressToNextTier).toBeLessThan(1);
  });

  it('does not report a progress bar for regular contacts (human-approved next tier)', () => {
    const score = computeContactRelationshipScore({
      trustLevel: 'regular',
      signals: { positiveInteractionCount: 10, consistentBoundaryRespect: true },
    });
    expect(score.nextTier).toBe('trusted');
    expect(score.progressToNextTier).toBeUndefined();
  });

  it('reports high tiers as tier-only', () => {
    const score = computeContactRelationshipScore({
      trustLevel: 'primary',
      signals: { positiveInteractionCount: 0 },
    });
    expect(score.resolvedTier).toBe('primary');
    expect(score.nextTier).toBeUndefined();
    expect(score.progressToNextTier).toBeUndefined();
    expect(score.score).toBe(1);
  });
});

describe('createContactRelationshipScoreReader', () => {
  it('maps scores for known contacts and skips unknown ids', async () => {
    const reader = createContactRelationshipScoreReader({
      getById: (id) => (id === 'known'
        ? {
          id: 'known',
          displayName: 'Fixture Contact',
          trustLevel: 'public',
          relationshipType: 'stranger',
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-07-01T00:00:00.000Z',
        }
        : undefined),
      getEmotionalTimeSeries: () => [point(0.4), point(0.3), point(0.2)],
      countVerifiedIdentityLinks: () => 1,
    });
    const scores = await reader.listContactRelationshipScores(['known', 'missing']);
    expect(scores.size).toBe(1);
    const known = scores.get('known');
    expect(known?.resolvedTier).toBe('public');
    expect(known?.progressToNextTier).toBe(1);
    expect(known?.updatedAt).toBe('2026-07-01T00:00:00.000Z');
  });
});
