import { describe, it, expect } from 'vitest';
import { detectEmotionDiscrepancies } from './discrepancy.js';
import type { EmotionStateSnapshot } from './state.js';
import type { AcacSnapshot } from './acac.js';
import type { EmotionTelemetryValidation } from '../../shared/contracts/emotion-contracts.js';

function trustedValidation(
  overrides: Partial<EmotionTelemetryValidation> = {},
): EmotionTelemetryValidation {
  return {
    status: 'trusted',
    source: 'classifier_inferred',
    reasons: [],
    confidence: 0.8,
    weight: 1,
    observedAtMs: 1000,
    validatedAtMs: 2000,
    staleAfterMs: 600000,
    provenance: [{ source: 'classifier_inferred', modality: 'text', provenanceRef: 'test:classifier' }],
    rawSignal: { confidence: 0.8, topDiscreteLabels: [], strongestLabelScore: 0 },
    ...overrides,
  };
}

function snapshot(overrides: Partial<EmotionStateSnapshot> = {}): EmotionStateSnapshot {
  return {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: {},
    confidence: 0.8,
    ...overrides,
  };
}

function acac(connectionScore: number): AcacSnapshot {
  return {
    schemaVersion: 1,
    artifactType: 'psfn.acac_self_report',
    provenance: { kind: 'self_report', source: 'companion-journal' },
    axes: {
      agency: { score: 0.5, rationale: 'x' },
      connection: { score: connectionScore, rationale: 'felt close' },
      authenticity: { score: 0.5, rationale: 'x' },
      curiosity: { score: 0.5, rationale: 'x' },
    },
  };
}

describe('detectEmotionDiscrepancies', () => {
  it('surfaces low valence + high love (valence_vs_discrete) with both sides', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: -0.5, arousal: 0.2, dominance: 0 }, discrete: { love: 0.7 } }),
      validation: trustedValidation(),
    });
    const split = result.find(d => d.kind === 'valence_vs_discrete');
    expect(split).toBeDefined();
    // Both signals are carried verbatim — neither averaged nor dropped (charter 8.3).
    const valenceSide = split!.sides.find(s => s.family === 'vad_valence');
    const discreteSide = split!.sides.find(s => s.family === 'discrete_affect');
    expect(valenceSide?.value).toBe(-0.5);
    expect(discreteSide?.label).toBe('love');
    expect(discreteSide?.value).toBe(0.7);
    // Provenance + confidence present on both sides (twa0 contract).
    expect(valenceSide?.confidence).toBe(0.8);
    expect(valenceSide?.provenance[0]?.source).toBe('classifier_inferred');
    expect(discreteSide?.confidence).toBe(0.8);
    expect(discreteSide?.provenance.length).toBeGreaterThan(0);
  });

  it('surfaces momentary VAD vs mood divergence', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 }, mood: { valence: -0.1, arousal: 0, dominance: 0 } }),
      validation: trustedValidation(),
    });
    const split = result.find(d => d.kind === 'momentary_vs_mood');
    expect(split).toBeDefined();
    expect(split!.sides.find(s => s.label === 'momentary_valence')?.value).toBe(0.5);
    expect(split!.sides.find(s => s.label === 'mood_valence')?.value).toBe(-0.1);
  });

  it('surfaces ACAC self-report vs classifier disagreement', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: -0.4, arousal: 0, dominance: 0 } }),
      validation: trustedValidation(),
      acac: acac(0.85),
    });
    const split = result.find(d => d.kind === 'self_report_vs_classifier');
    expect(split).toBeDefined();
    const selfReport = split!.sides.find(s => s.family === 'acac_self_report');
    const classifier = split!.sides.find(s => s.family === 'vad_valence');
    expect(selfReport?.value).toBe(0.85);
    expect(selfReport?.provenance[0]?.source).toBe('self_report');
    expect(classifier?.value).toBe(-0.4);
  });

  it('produces no descriptor when nothing diverges', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: 0.4, arousal: 0, dominance: 0 }, mood: { valence: 0.35, arousal: 0, dominance: 0 }, discrete: { joy: 0.6 } }),
      validation: trustedValidation(),
    });
    expect(result).toEqual([]);
  });

  it('suppresses discrepancies built on a suppressed signal', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: -0.5, arousal: 0, dominance: 0 }, discrete: { love: 0.7 } }),
      validation: trustedValidation({ status: 'suppressed', weight: 0, confidence: 0 }),
    });
    expect(result).toEqual([]);
  });

  it('suppresses discrepancies when telemetry is merely uncertain', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: -0.5, arousal: 0, dominance: 0 }, discrete: { love: 0.7 } }),
      validation: trustedValidation({ status: 'uncertain', weight: 0.25, confidence: 0.2 }),
    });
    expect(result).toEqual([]);
  });

  it('does not manufacture a valence_vs_discrete split for near-neutral valence', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: -0.05, arousal: 0, dominance: 0 }, discrete: { love: 0.7 } }),
      validation: trustedValidation(),
    });
    expect(result.find(d => d.kind === 'valence_vs_discrete')).toBeUndefined();
  });

  it('does not fire self_report_vs_classifier when both agree', () => {
    const result = detectEmotionDiscrepancies({
      snapshot: snapshot({ vad: { valence: 0.5, arousal: 0, dominance: 0 } }),
      validation: trustedValidation(),
      acac: acac(0.85),
    });
    expect(result.find(d => d.kind === 'self_report_vs_classifier')).toBeUndefined();
  });
});
