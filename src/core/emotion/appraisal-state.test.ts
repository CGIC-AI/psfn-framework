import { describe, expect, it } from 'vitest';

import type { InternalState } from '../self-model/state.js';
import {
  parseEmotionAppraisalStateSnapshot,
  projectEmotionAppraisalState,
} from './appraisal-state.js';

function makeInternalState(): InternalState {
  return {
    emotional: {
      vad: { valence: 0.2, arousal: 0.3, dominance: 0.4 },
      mood: { valence: 0.1, arousal: 0.2, dominance: 0.3 },
      discreteEmotions: { joy: 0.7 },
      confidence: 0.8,
      telemetry: {
        status: 'trusted',
        source: 'runtime_state',
        reasons: [],
        confidence: 0.8,
        weight: 1,
        observedAtMs: 100,
        validatedAtMs: 100,
        staleAfterMs: 1_000,
        provenance: [],
        rawSignal: {
          confidence: 0.8,
          topDiscreteLabels: ['joy'],
          strongestLabelScore: 0.7,
        },
      },
    },
    cognitive: {
      certaintyLevel: 0.6,
      topicEngagement: 0.9,
      processingQuality: 'fluent',
    },
    attention: {
      activeConcerns: [{
        id: 'concern-1',
        text: 'private concern text must stay canonical',
        priority: 'high',
        source: 'agent',
        status: 'active',
        createdAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2026-07-16T00:00:00.000Z',
        salience: 0.8,
        sensitivity: 'intimate',
        owner: 'companion',
        evidenceRefs: [],
        resolutionEvidenceRefs: [],
      }],
      salientEntities: ['private partner detail'],
      conversationTrajectory: 'deepening',
    },
    relational: {
      contactId: 'contact-ref-1',
      trustLevel: 'primary',
      baselineValence: 0.1,
      moodDrift: 0.2,
      recentInteractionFrequency: 0.5,
      lastSeenDeltaSeconds: 10,
    },
    situated: { location: null },
  };
}

describe('emotion appraisal state projection', () => {
  it('keeps only the aggregate signals appraisal consumes', () => {
    const projected = projectEmotionAppraisalState(makeInternalState());

    expect(projected.attention).toEqual({
      activeConcernCount: 1,
      salientEntityCount: 1,
      conversationTrajectory: 'deepening',
    });
    expect(projected.emotional.telemetry).toEqual({
      status: 'trusted',
      source: 'runtime_state',
      reasons: [],
      weight: 1,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('private concern text');
    expect(serialized).not.toContain('private partner detail');
    expect(serialized).not.toContain('activeConcerns');
    expect(serialized).not.toContain('salientEntities');
  });

  it('fails closed when a durable projection adds private-state fields', () => {
    const projected = projectEmotionAppraisalState(makeInternalState());
    expect(() => parseEmotionAppraisalStateSnapshot({
      ...projected,
      attention: {
        ...projected.attention,
        activeConcerns: [{ text: 'must not be persisted' }],
      },
    })).toThrow('unsupported field activeConcerns');
  });
});
