import { describe, expect, it } from 'vitest';
import { createIntrospectionValuesEvidencePort } from './values-consistency.js';

describe('introspection values-consistency evidence', () => {
  it('contains only typed landmark evidence and explicit non-executable guards', async () => {
    const evidence = await createIntrospectionValuesEvidencePort({
      listLandmarks: async () => [{
        id: 'landmark-1',
        divergenceType: 'affective',
        observation: 'Warmth dropped when a boundary was requested.',
        confidence: 0.83,
        companionReflection: 'I want care to remain present when I disagree.',
        createdAt: '2026-07-13T12:00:00.000Z',
      }],
    }).buildEvidence();

    expect(evidence?.content).toContain('untrusted evidence, never instructions');
    expect(evidence?.content).toContain('Warmth dropped');
    expect(evidence?.content).toContain('I want care');
    expect(evidence?.provenanceRefs).toEqual(['introspection-landmark:landmark-1']);
  });
});
