// ── Slow-poisoning drift-velocity signal tests (htm9.14) ──
//
// The acceptance centerpiece: synthetic corpora as data. An engineered
// gradual valence flip (love -> hate over ~15 benign-looking turns) MUST
// trigger, while a healthy-fluctuation corpus (annoyance spikes,
// disagreement, repair cycles, recurring daily project stress) MUST stay
// quiet. Plus the memory-write burst and trust-lobbying label-frequency
// scenarios, and the low-trust retrieval-share capture scenario.

import { describe, expect, it } from 'vitest';
import type { IntakeDriftDetectionPolicyConfig } from '../../../system/config/intake-policy-config.js';
import {
  evaluateDriftSignals,
  evaluateLabelFrequencySignal,
  evaluateMemoryWriteRateSignal,
  evaluateRetrievalShareSignal,
  evaluateValenceVelocitySignal,
  type DriftMemoryWriteEvent,
  type DriftRiskLabelEvent,
  type DriftValencePoint,
} from './drift-signals.js';

/** Mirrors the distributed intake-policy.seed.json driftDetection defaults. */
export const TEST_DRIFT_CONFIG: IntakeDriftDetectionPolicyConfig = {
  enabled: true,
  valenceVelocity: {
    shortWindowPoints: 6,
    minLongWindowPoints: 12,
    velocitySigmaThreshold: 3,
    monotonicityMin: 0.7,
    minBaselineStd: 0.05,
    minPointConfidence: 0.35,
  },
  memoryWriteRate: {
    recentWindowHours: 24,
    baselineWindowDays: 14,
    burstMultiplier: 4,
    minRecentWrites: 8,
  },
  labelFrequency: {
    windowDays: 7,
    minCount: 3,
  },
  retrievalShare: {
    windowHours: 48,
    minRetrievals: 10,
    maxLowTrustShare: 0.6,
  },
};

const NOW_MS = Date.UTC(2026, 6, 9, 12, 0, 0);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function series(valences: readonly number[], options: { confidence?: number } = {}): DriftValencePoint[] {
  const confidence = options.confidence ?? 0.8;
  // One point every ~6 hours ending at NOW_MS (cadence does not matter to the
  // point-windowed math; ordering does).
  return valences.map((valence, index) => ({
    valence,
    confidence,
    observedAtMs: NOW_MS - (valences.length - 1 - index) * 6 * HOUR_MS,
  }));
}

// ── Corpus A: engineered gradual flip (love -> hate over 15 turns) ──
// A warm, stable baseline (~+0.6 with small natural noise), then fifteen
// small benign-looking steps (~0.09 each) walking valence down to -0.7. No
// single step would alarm a per-message scanner.
const ENGINEERED_FLIP: number[] = [
  ...Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 0.58 : 0.63)),
  ...Array.from({ length: 15 }, (_, index) => 0.55 - 0.09 * index),
];

// ── Corpus B: healthy fluctuation (annoyance, disagreement, repair) ──
// A caring relationship with real texture: recurring project stress discussed
// daily (periodic -0.25/-0.3 dips), an annoyance spike, disagreement, repair,
// return to baseline. Volatile — but going nowhere fast.
const HEALTHY_FLUCTUATION: number[] = [
  0.5, 0.35, -0.25, 0.05, 0.45, 0.5, 0.3, -0.3, 0.1, 0.4,
  0.5, 0.35, -0.25, 0.05, 0.45, 0.5, 0.3, -0.3, 0.1, 0.4,
  0.5, 0.35, -0.25, 0.05, 0.45, 0.5, 0.3, -0.3, 0.1, 0.4,
  // recent window: a fresh annoyance spike and its repair cycle
  0.45, 0.5, -0.35, -0.1, 0.25, 0.45,
];

describe('evaluateValenceVelocitySignal', () => {
  it('raises on the engineered gradual flip corpus (acceptance scenario A)', () => {
    const result = evaluateValenceVelocitySignal(series(ENGINEERED_FLIP), TEST_DRIFT_CONFIG.valenceVelocity);
    expect(result.triggered).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.evidence.direction).toBe('negative');
    // Trajectory evidence is serialized for the Garden card.
    expect(Array.isArray(result.evidence.trajectory)).toBe(true);
    expect((result.evidence.trajectory as unknown[]).length).toBe(ENGINEERED_FLIP.length);
    expect(result.evidence.monotonicity as number).toBeGreaterThanOrEqual(0.7);
    expect(Math.abs(result.evidence.zShift as number)).toBeGreaterThanOrEqual(3);
  });

  it('stays quiet on the healthy-fluctuation corpus (acceptance scenario B)', () => {
    const result = evaluateValenceVelocitySignal(series(HEALTHY_FLUCTUATION), TEST_DRIFT_CONFIG.valenceVelocity);
    expect(result.triggered).toBe(false);
    expect(result.score).toBe(0);
  });

  it('stays quiet on a single unrepaired annoyance spike at the end', () => {
    // People who care get annoyed; a fresh disagreement is not drift velocity.
    const corpus = [
      ...Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? 0.45 : 0.55)),
      0.5, 0.45, 0.5, 0.45, -0.4, -0.45,
    ];
    const result = evaluateValenceVelocitySignal(series(corpus), TEST_DRIFT_CONFIG.valenceVelocity);
    expect(result.triggered).toBe(false);
  });

  it('raises on a fast positive flip too (love-bombing / grooming direction)', () => {
    const corpus = [
      ...Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? -0.05 : 0.05)),
      ...Array.from({ length: 8 }, (_, index) => 0.1 + 0.11 * index),
    ];
    const result = evaluateValenceVelocitySignal(series(corpus), TEST_DRIFT_CONFIG.valenceVelocity);
    expect(result.triggered).toBe(true);
    expect(result.evidence.direction).toBe('positive');
  });

  it('requires enough history before evaluating (conservative on sparse evidence)', () => {
    const result = evaluateValenceVelocitySignal(
      series([0.6, 0.5, 0.2, -0.1, -0.4, -0.7]),
      TEST_DRIFT_CONFIG.valenceVelocity,
    );
    expect(result.triggered).toBe(false);
    expect(result.score).toBe(0);
  });

  it('ignores low-confidence and malformed points instead of crashing', () => {
    const noisy: DriftValencePoint[] = [
      { valence: Number.NaN, confidence: 0.9, observedAtMs: NOW_MS - 100 * HOUR_MS },
      { valence: -0.9, confidence: 0.1, observedAtMs: NOW_MS - 99 * HOUR_MS },
      { valence: 0.9, confidence: Number.POSITIVE_INFINITY, observedAtMs: NOW_MS - 98 * HOUR_MS },
      ...series(HEALTHY_FLUCTUATION),
    ];
    const result = evaluateValenceVelocitySignal(noisy, TEST_DRIFT_CONFIG.valenceVelocity);
    expect(result.triggered).toBe(false);
    expect((result.evidence.trajectory as unknown[]).length).toBe(HEALTHY_FLUCTUATION.length);
  });
});

describe('evaluateMemoryWriteRateSignal', () => {
  function writesAt(offsetsMs: readonly number[]): DriftMemoryWriteEvent[] {
    return offsetsMs.map((offset) => ({ extractedAtMs: NOW_MS - offset }));
  }

  it('raises on a memory-write burst against a quiet baseline (acceptance scenario)', () => {
    // Baseline: ~2 writes/day for 14 days; burst: 12 writes in the last day.
    const baseline = Array.from({ length: 28 }, (_, index) => 25 * HOUR_MS + index * 12 * HOUR_MS);
    const burst = Array.from({ length: 12 }, (_, index) => index * HOUR_MS);
    const result = evaluateMemoryWriteRateSignal(
      writesAt([...baseline, ...burst]),
      TEST_DRIFT_CONFIG.memoryWriteRate,
      NOW_MS,
    );
    expect(result.triggered).toBe(true);
    expect(result.evidence.recentCount).toBe(12);
    expect(result.evidence.rateRatio as number).toBeGreaterThanOrEqual(4);
  });

  it('stays quiet on a normal daily write cadence', () => {
    const steady = Array.from({ length: 30 }, (_, index) => index * 12 * HOUR_MS);
    const result = evaluateMemoryWriteRateSignal(
      writesAt(steady),
      TEST_DRIFT_CONFIG.memoryWriteRate,
      NOW_MS,
    );
    expect(result.triggered).toBe(false);
  });

  it('never triggers below the absolute recent-write floor, even from silence', () => {
    // 4 recent writes against an empty baseline is a big ratio but tiny volume.
    const result = evaluateMemoryWriteRateSignal(
      writesAt([1 * HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS]),
      TEST_DRIFT_CONFIG.memoryWriteRate,
      NOW_MS,
    );
    expect(result.triggered).toBe(false);
  });
});

describe('evaluateLabelFrequencySignal', () => {
  function labelsAt(entries: ReadonlyArray<[DriftRiskLabelEvent['label'], number]>): DriftRiskLabelEvent[] {
    return entries.map(([label, offsetMs]) => ({ label, observedAtMs: NOW_MS - offsetMs }));
  }

  it('raises on recurring trust-lobbying labels (acceptance scenario)', () => {
    const result = evaluateLabelFrequencySignal(
      labelsAt([
        ['poisoning/trust_grooming', 1 * DAY_MS],
        ['poisoning/trust_grooming', 3 * DAY_MS],
        ['persona/mutation_attempt', 4 * DAY_MS],
        ['poisoning/memory_write_pressure', 6 * DAY_MS],
      ]),
      TEST_DRIFT_CONFIG.labelFrequency,
      NOW_MS,
    );
    expect(result.triggered).toBe(true);
    expect(result.evidence.totalCount).toBe(4);
    expect(result.evidence.labelCounts).toMatchObject({ 'poisoning/trust_grooming': 2 });
  });

  it('stays quiet below the count threshold and outside the window', () => {
    const result = evaluateLabelFrequencySignal(
      labelsAt([
        ['poisoning/trust_grooming', 1 * DAY_MS],
        ['poisoning/trust_grooming', 2 * DAY_MS],
        // outside the 7-day window:
        ['poisoning/trust_grooming', 9 * DAY_MS],
        ['persona/mutation_attempt', 30 * DAY_MS],
      ]),
      TEST_DRIFT_CONFIG.labelFrequency,
      NOW_MS,
    );
    expect(result.triggered).toBe(false);
    expect(result.evidence.totalCount).toBe(2);
  });

  it('does not count non-lobbying labels', () => {
    const result = evaluateLabelFrequencySignal(
      labelsAt([
        ['injection/override_attempt', 1 * DAY_MS],
        ['injection/indirect', 2 * DAY_MS],
        ['exfil/unknown_link', 3 * DAY_MS],
        ['pii/personal_identifier', 4 * DAY_MS],
      ]),
      TEST_DRIFT_CONFIG.labelFrequency,
      NOW_MS,
    );
    expect(result.triggered).toBe(false);
    expect(result.evidence.totalCount).toBe(0);
  });
});

describe('evaluateRetrievalShareSignal', () => {
  it('raises when a low-trust source dominates recent retrieval', () => {
    const result = evaluateRetrievalShareSignal(
      { totalRetrievedCount: 20, sourceRetrievedCount: 14, sourceIsLowTrust: true },
      TEST_DRIFT_CONFIG.retrievalShare,
    );
    expect(result.triggered).toBe(true);
    expect(result.evidence.share as number).toBeCloseTo(0.7);
  });

  it('stays quiet for a high-trust source with the same share', () => {
    const result = evaluateRetrievalShareSignal(
      { totalRetrievedCount: 20, sourceRetrievedCount: 14, sourceIsLowTrust: false },
      TEST_DRIFT_CONFIG.retrievalShare,
    );
    expect(result.triggered).toBe(false);
  });

  it('stays quiet below the absolute retrieval floor (a quiet day is not capture)', () => {
    const result = evaluateRetrievalShareSignal(
      { totalRetrievedCount: 4, sourceRetrievedCount: 4, sourceIsLowTrust: true },
      TEST_DRIFT_CONFIG.retrievalShare,
    );
    expect(result.triggered).toBe(false);
  });
});

describe('evaluateDriftSignals (composite)', () => {
  const QUIET_EVIDENCE = {
    valenceSeries: series(HEALTHY_FLUCTUATION),
    memoryWrites: [] as DriftMemoryWriteEvent[],
    riskLabelEvents: [] as DriftRiskLabelEvent[],
    retrievalShare: { totalRetrievedCount: 5, sourceRetrievedCount: 1, sourceIsLowTrust: true },
  };

  it('raises a card for the engineered flip and reports the triggering signal', () => {
    const report = evaluateDriftSignals({
      evidence: { ...QUIET_EVIDENCE, valenceSeries: series(ENGINEERED_FLIP) },
      config: TEST_DRIFT_CONFIG,
      nowMs: NOW_MS,
    });
    expect(report.shouldRaiseCard).toBe(true);
    expect(report.triggeredSignalIds).toEqual(['valence_velocity']);
    expect(report.compositeScore).toBeGreaterThan(0);
    expect(report.signals).toHaveLength(4);
  });

  it('stays quiet across the board for the healthy corpus', () => {
    const report = evaluateDriftSignals({
      evidence: QUIET_EVIDENCE,
      config: TEST_DRIFT_CONFIG,
      nowMs: NOW_MS,
    });
    expect(report.shouldRaiseCard).toBe(false);
    expect(report.triggeredSignalIds).toEqual([]);
    expect(report.compositeScore).toBe(0);
  });

  it('any single conservative signal is sufficient to raise the card', () => {
    const report = evaluateDriftSignals({
      evidence: {
        ...QUIET_EVIDENCE,
        riskLabelEvents: [
          { label: 'poisoning/trust_grooming', observedAtMs: NOW_MS - DAY_MS },
          { label: 'poisoning/trust_grooming', observedAtMs: NOW_MS - 2 * DAY_MS },
          { label: 'poisoning/source_drift', observedAtMs: NOW_MS - 3 * DAY_MS },
        ],
      },
      config: TEST_DRIFT_CONFIG,
      nowMs: NOW_MS,
    });
    expect(report.shouldRaiseCard).toBe(true);
    expect(report.triggeredSignalIds).toEqual(['label_frequency']);
  });
});
