// ── Cross-family emotional divergence detector ──
// psfn-framework-031.11.1 (child 1/2 of 031.11).
//
// The runtime already detects INTRA-discrete conflict (one classifier emitting
// both a positive and a negative label at once — detectConflictingDiscreteSignals
// in telemetry-validation.ts). This module detects CROSS-family divergence: when
// telemetry from two DIFFERENT families disagrees. Three shapes are surfaced:
//
//   1. valence_vs_discrete       — VAD valence points one way while a strong
//                                  discrete label ("love", "anger") points the
//                                  other ("low valence + high love").
//   2. momentary_vs_mood         — the momentary VAD valence splits from the slow
//                                  mood EMA (head vs settled baseline).
//   3. self_report_vs_classifier — an ACAC self-report (e.g. connection) reads
//                                  high while the classifier's VAD valence reads
//                                  low (or vice versa).
//
// Charter §8.3 / recommendation #11: a discrepancy is SURFACED DATA, never
// forced coherent. Both sides are carried verbatim with their own value,
// provenance, and confidence. This module never averages the two, never picks a
// winner, and never drops either signal — the "head and heart not in sync" state
// stays legible as a mixed state.
//
// Trust gating (twa0): every telemetry-derived side is gated on the emotion
// telemetry validation status being `trusted`. When the emotion signal is
// `uncertain` or `suppressed` its VAD is scaled down and its discrete
// distribution is emptied by validateEmotionTelemetry, so a divergence built on
// it would be a conclusion drawn from an untrusted input — those are suppressed
// wholesale here rather than surfaced.

import { clampUnit } from '../../shared/utils/numeric.js';
import type { EmotionStateSnapshot } from './state.js';
import type { AcacSnapshot } from './acac.js';
import { discreteAffectPolarity } from './telemetry-validation.js';
import type {
  EmotionDiscrepancy,
  EmotionTelemetryProvenance,
  EmotionTelemetryValidation,
} from '../../shared/contracts/emotion-contracts.js';

/**
 * Divergence thresholds. Kept as one frozen object (not scattered scalars) so
 * every "how far apart counts as diverging" decision lives in one justified
 * place. Callers may override any subset for tests; production uses the defaults.
 */
export interface EmotionDiscrepancyThresholds {
  /**
   * Minimum |VAD valence| for the valence side of a valence_vs_discrete split to
   * count. 0.2 keeps near-neutral valence (noise around zero) from manufacturing
   * a "divergence" against every incidental discrete label.
   */
  minValenceMagnitude: number;
  /**
   * Minimum score for an opposing discrete label to count against the valence
   * sign. 0.4 is above the intra-discrete conflict floor (0.35) — an opposing
   * affect must be clearly present, not a trace.
   */
  minOpposingDiscreteScore: number;
  /**
   * Minimum |momentary valence − mood valence| for a momentary_vs_mood split.
   * 0.4 on the [-1, 1] axis is a fifth of the full range: a genuinely large gap
   * between the in-the-moment reading and the settled EMA, not ordinary drift.
   */
  minMoodValenceGap: number;
  /** ACAC axis score at/above which a self-report reads "high". */
  selfReportHigh: number;
  /** ACAC axis score at/below which a self-report reads "low". */
  selfReportLow: number;
  /**
   * Minimum |VAD valence| for the classifier side of a self_report_vs_classifier
   * split. Same neutral-band rationale as minValenceMagnitude.
   */
  minClassifierValenceMagnitude: number;
}

export const DEFAULT_EMOTION_DISCREPANCY_THRESHOLDS: EmotionDiscrepancyThresholds = Object.freeze({
  minValenceMagnitude: 0.2,
  minOpposingDiscreteScore: 0.4,
  minMoodValenceGap: 0.4,
  selfReportHigh: 0.6,
  selfReportLow: 0.35,
  minClassifierValenceMagnitude: 0.2,
});

export interface DetectEmotionDiscrepanciesInput {
  /**
   * The RAW normalized emotion snapshot for the turn (pre validation weighting).
   * Divergence is computed from the raw reading, then gated on trust below.
   */
  snapshot: EmotionStateSnapshot;
  /** twa0 validation for the emotion snapshot: gates whether telemetry sides surface. */
  validation: EmotionTelemetryValidation;
  /** ACAC self-report for the turn, when present. */
  acac?: AcacSnapshot | undefined;
  thresholds?: Partial<EmotionDiscrepancyThresholds>;
}

/**
 * Detect cross-family emotional divergences. Returns an empty array when nothing
 * diverges (no descriptor is surfaced) or when the emotion telemetry is not
 * trusted (a discrepancy built on a suppressed signal is itself suppressed).
 */
export function detectEmotionDiscrepancies(
  input: DetectEmotionDiscrepanciesInput,
): EmotionDiscrepancy[] {
  const thresholds: EmotionDiscrepancyThresholds = {
    ...DEFAULT_EMOTION_DISCREPANCY_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };

  // Trust gate: telemetry sides only surface when the emotion signal is trusted.
  // uncertain/suppressed signals have already had their discrete emptied and VAD
  // scaled by validateEmotionTelemetry, so any divergence off them would be a
  // conclusion from an untrusted input.
  const telemetryTrusted = input.validation.status === 'trusted';
  if (!telemetryTrusted) {
    return [];
  }

  const telemetryProvenance = cloneProvenance(input.validation.provenance);
  const telemetryConfidence = clampUnit(input.validation.confidence);
  const discrepancies: EmotionDiscrepancy[] = [];

  const valenceVsDiscrete = detectValenceVsDiscrete(
    input.snapshot,
    thresholds,
    telemetryConfidence,
    telemetryProvenance,
  );
  if (valenceVsDiscrete) discrepancies.push(valenceVsDiscrete);

  const momentaryVsMood = detectMomentaryVsMood(
    input.snapshot,
    thresholds,
    telemetryConfidence,
    telemetryProvenance,
  );
  if (momentaryVsMood) discrepancies.push(momentaryVsMood);

  if (input.acac) {
    const selfReportVsClassifier = detectSelfReportVsClassifier(
      input.snapshot,
      input.acac,
      thresholds,
      telemetryConfidence,
      telemetryProvenance,
    );
    if (selfReportVsClassifier) discrepancies.push(selfReportVsClassifier);
  }

  return discrepancies;
}

function detectValenceVsDiscrete(
  snapshot: EmotionStateSnapshot,
  thresholds: EmotionDiscrepancyThresholds,
  telemetryConfidence: number,
  telemetryProvenance: EmotionTelemetryProvenance[],
): EmotionDiscrepancy | null {
  const valence = snapshot.vad.valence;
  if (Math.abs(valence) < thresholds.minValenceMagnitude) return null;
  const opposingPolarity = valence < 0 ? 'positive' : 'negative';

  let strongestLabel: string | null = null;
  let strongestScore = 0;
  for (const [label, score] of Object.entries(snapshot.discrete)) {
    if (score < thresholds.minOpposingDiscreteScore) continue;
    if (discreteAffectPolarity(label) !== opposingPolarity) continue;
    if (score > strongestScore) {
      strongestScore = score;
      strongestLabel = label;
    }
  }
  if (!strongestLabel) return null;

  return {
    kind: 'valence_vs_discrete',
    magnitude: roundUnit((Math.abs(valence) + strongestScore) / 2),
    sides: [
      {
        family: 'vad_valence',
        label: 'valence',
        value: roundSigned(valence),
        confidence: telemetryConfidence,
        provenance: cloneProvenance(telemetryProvenance),
      },
      {
        family: 'discrete_affect',
        label: strongestLabel,
        value: roundUnit(strongestScore),
        confidence: telemetryConfidence,
        provenance: cloneProvenance(telemetryProvenance),
      },
    ],
  };
}

function detectMomentaryVsMood(
  snapshot: EmotionStateSnapshot,
  thresholds: EmotionDiscrepancyThresholds,
  telemetryConfidence: number,
  telemetryProvenance: EmotionTelemetryProvenance[],
): EmotionDiscrepancy | null {
  const momentary = snapshot.vad.valence;
  const mood = snapshot.mood.valence;
  const gap = Math.abs(momentary - mood);
  if (gap < thresholds.minMoodValenceGap) return null;

  return {
    kind: 'momentary_vs_mood',
    magnitude: roundUnit(clampUnit(gap)),
    sides: [
      {
        family: 'vad_valence',
        label: 'momentary_valence',
        value: roundSigned(momentary),
        confidence: telemetryConfidence,
        provenance: cloneProvenance(telemetryProvenance),
      },
      {
        family: 'mood_valence',
        label: 'mood_valence',
        value: roundSigned(mood),
        confidence: telemetryConfidence,
        provenance: cloneProvenance(telemetryProvenance),
      },
    ],
  };
}

function detectSelfReportVsClassifier(
  snapshot: EmotionStateSnapshot,
  acac: AcacSnapshot,
  thresholds: EmotionDiscrepancyThresholds,
  telemetryConfidence: number,
  telemetryProvenance: EmotionTelemetryProvenance[],
): EmotionDiscrepancy | null {
  // Connection is the ACAC axis most directly comparable to affective valence —
  // it is the "warmth / love / felt bond" axis the charter's "low valence
  // alongside high love" example is about. A self-report of strong connection
  // against a negatively-valenced classifier reading (or the reverse) is the
  // head/heart split we surface.
  const connection = acac.axes.connection.score;
  const valence = snapshot.vad.valence;
  if (Math.abs(valence) < thresholds.minClassifierValenceMagnitude) return null;

  const reportsHighConnection = connection >= thresholds.selfReportHigh;
  const reportsLowConnection = connection <= thresholds.selfReportLow;
  const classifierNegative = valence <= -thresholds.minClassifierValenceMagnitude;
  const classifierPositive = valence >= thresholds.minClassifierValenceMagnitude;

  const diverges = (reportsHighConnection && classifierNegative)
    || (reportsLowConnection && classifierPositive);
  if (!diverges) return null;

  // Compare in a shared [0, 1] space (valence mapped from [-1, 1]) for magnitude
  // only; both sides keep their own native value below.
  const valenceUnit = clampUnit((valence + 1) / 2);
  return {
    kind: 'self_report_vs_classifier',
    magnitude: roundUnit(clampUnit(Math.abs(connection - valenceUnit))),
    sides: [
      {
        family: 'acac_self_report',
        label: 'connection',
        value: roundUnit(connection),
        // A first-person self-report is not a probabilistic inference; its
        // provenance kind (self_report) already marks its epistemic status, so
        // its own confidence is full.
        confidence: 1,
        provenance: acacProvenance(acac),
      },
      {
        family: 'vad_valence',
        label: 'valence',
        value: roundSigned(valence),
        confidence: telemetryConfidence,
        provenance: cloneProvenance(telemetryProvenance),
      },
    ],
  };
}

function acacProvenance(acac: AcacSnapshot): EmotionTelemetryProvenance[] {
  const observedAtMs = acac.provenance.observedAt
    ? Date.parse(acac.provenance.observedAt)
    : undefined;
  return [{
    source: 'self_report',
    modality: 'self_report',
    ...(observedAtMs !== undefined && Number.isFinite(observedAtMs) && observedAtMs >= 0
      ? { observedAtMs }
      : {}),
    provenanceRef: `acac:${acac.provenance.source}`,
  }];
}

function cloneProvenance(
  provenance: readonly EmotionTelemetryProvenance[],
): EmotionTelemetryProvenance[] {
  return provenance.map(entry => ({ ...entry }));
}

function roundSigned(value: number): number {
  return roundDecimal(Math.max(-1, Math.min(1, value)));
}

function roundUnit(value: number): number {
  return roundDecimal(clampUnit(value));
}

function roundDecimal(value: number, precision = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
