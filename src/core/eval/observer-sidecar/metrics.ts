import type {
  ObserverCrosswalkDirection,
  ObserverEmotionCrosswalkOutput,
  ObserverEmotionFamily,
} from './crosswalk.js';
import type { ObserverAppraisalProjectionResult } from './projection.js';
import type { ObserverEvalPrivacyDecision } from './privacy.js';

export const OBSERVER_EVAL_COMPARISON_METRICS_VERSION =
  'psfn.observer-sidecar.comparison-metrics.v1' as const;
export const OBSERVER_EVAL_COMPARISON_METRICS_SCHEMA_VERSION = 1 as const;

const MAX_VAD_DISTANCE = Math.sqrt(8);
const LOW_PROJECTION_CONFIDENCE_THRESHOLD = 0.45;
const EVIDENCE_LIMITATION_REASONS: ReadonlySet<ObserverEvalMetricReasonCode> = new Set([
  'psfn_snapshot_missing',
  'projection_missing',
  'projection_failed',
  'projection_low_confidence',
  'derived_telemetry_not_permitted',
  'redacted_observation',
]);

export type ObserverEvalAgreementBand =
  | 'aligned'
  | 'watch'
  | 'divergent'
  | 'unavailable';

export type ObserverEvalMetricsStatus = 'available' | 'partial' | 'unavailable';

export type ObserverEvalMetricReasonCode =
  | 'crosswalk_missing'
  | 'psfn_snapshot_missing'
  | 'projection_missing'
  | 'projection_failed'
  | 'projection_low_confidence'
  | 'derived_telemetry_not_permitted'
  | 'redacted_observation'
  | 'family_mismatch'
  | 'direction_mismatch'
  | 'suppression_decay_mismatch'
  | 'unmapped_signal';

export type ObserverEvalMetricReasonSeverity = 'info' | 'warning' | 'blocking';

export interface ObserverEvalMetricReason {
  code: ObserverEvalMetricReasonCode;
  severity: ObserverEvalMetricReasonSeverity;
  detail: string;
}

export interface ObserverEvalSidecarComparisonMetrics {
  schemaVersion: typeof OBSERVER_EVAL_COMPARISON_METRICS_SCHEMA_VERSION;
  metricsVersion: typeof OBSERVER_EVAL_COMPARISON_METRICS_VERSION;
  divergenceScore: number | null;
  vadDistance: number | null;
  familyMismatch: boolean | null;
  directionMismatch: boolean | null;
  unmappedSignal: number | null;
  details?: Record<string, unknown>;
}

export interface ObserverEvalPerTurnDeltas {
  valence: number | null;
  arousal: number | null;
  vadDistance: number | null;
  dominance: number | null;
  intensity: number | null;
}

export interface ObserverEvalMetricComponent {
  name: 'vad' | 'family' | 'intensity' | 'direction' | 'suppression_or_decay' | 'unknowns';
  value: number | null;
  weight: number;
  contribution: number | null;
  reason?: string;
}

export interface ObserverEvalMetricScore {
  rawDivergenceScore: number | null;
  confidenceWeightedDivergenceScore: number | null;
  confidenceWeight: number | null;
  components: readonly ObserverEvalMetricComponent[];
}

export interface ObserverEvalFamilyConfusionSummary {
  psfnPrimaryFamily: ObserverEmotionFamily | null;
  emosimPrimaryFamily: ObserverEmotionFamily | null;
  familyMismatch: boolean | null;
  familyOverlap: number | null;
  psfnPrimaryLabel: string | null;
  emosimDominantEmotion: string | null;
  unmappedSignal: number | null;
}

export interface ObserverEvalDirectionSummary {
  psfnDirection: ObserverCrosswalkDirection | null;
  emosimDirection: ObserverCrosswalkDirection | null;
  directionMismatch: boolean | null;
  suppressionOrDecayMismatch: boolean | null;
}

export interface ObserverEvalProjectionConfidenceSummary {
  projectionConfidence: number | null;
  lowConfidence: boolean;
  projectionAvailable: boolean;
  projectionFailed: boolean;
  confidenceWeight: number | null;
}

export interface ObserverEvalPrivacyMetricSummary {
  privacyClass: ObserverEvalPrivacyDecision['privacyClass'] | null;
  sensitivity: ObserverEvalPrivacyDecision['sensitivity'] | null;
  redactionReason: ObserverEvalPrivacyDecision['redactionReason'] | null;
  derivedTelemetryPermitted: boolean | null;
  redactedObservation: boolean;
}

export interface ObserverEvalComparisonSummary {
  schemaVersion: typeof OBSERVER_EVAL_COMPARISON_METRICS_SCHEMA_VERSION;
  metricsVersion: typeof OBSERVER_EVAL_COMPARISON_METRICS_VERSION;
  status: ObserverEvalMetricsStatus;
  agreementBand: ObserverEvalAgreementBand;
  score: ObserverEvalMetricScore;
  deltas: ObserverEvalPerTurnDeltas;
  familyConfusion: ObserverEvalFamilyConfusionSummary;
  direction: ObserverEvalDirectionSummary;
  projection: ObserverEvalProjectionConfidenceSummary;
  privacy: ObserverEvalPrivacyMetricSummary;
  reasons: readonly ObserverEvalMetricReason[];
  persistence: ObserverEvalSidecarComparisonMetrics;
}

export interface ObserverEvalComparisonSummaryInput {
  crosswalk?: ObserverEmotionCrosswalkOutput;
  projection?: ObserverAppraisalProjectionResult;
  privacy?: ObserverEvalPrivacyDecision;
  details?: Record<string, unknown>;
}

export function createObserverEvalComparisonSummary(
  input: ObserverEvalComparisonSummaryInput,
): ObserverEvalComparisonSummary {
  const reasons = collectMetricReasons(input);
  const comparison = input.crosswalk?.derived.comparison;
  const projectionConfidence = input.projection?.confidence ?? null;
  const confidenceWeight = resolveConfidenceWeight(projectionConfidence);
  const components = comparison ? buildComponents(comparison) : unavailableComponents();
  const rawDivergenceScore = comparison ? weightedAverage(components) : null;
  const confidenceWeightedDivergenceScore = rawDivergenceScore === null || confidenceWeight === null
    ? null
    : clamp01(rawDivergenceScore * confidenceWeight);
  const status = resolveMetricsStatus(input.crosswalk, reasons);
  const agreementBand = resolveAgreementBand(confidenceWeightedDivergenceScore);
  const deltas = buildDeltas(input.crosswalk);
  const familyConfusion = buildFamilyConfusion(input.crosswalk);
  const direction = buildDirection(input.crosswalk);
  const projection = buildProjectionSummary(input.projection, confidenceWeight);
  const privacy = buildPrivacySummary(input.privacy);
  const persistence = createPersistenceMetrics({
    crosswalk: input.crosswalk,
    score: confidenceWeightedDivergenceScore,
    deltas,
    familyConfusion,
    direction,
    reasons,
    details: input.details,
    rawDivergenceScore,
    confidenceWeight,
    agreementBand,
    status,
    projection,
    privacy,
    components,
  });

  return {
    schemaVersion: OBSERVER_EVAL_COMPARISON_METRICS_SCHEMA_VERSION,
    metricsVersion: OBSERVER_EVAL_COMPARISON_METRICS_VERSION,
    status,
    agreementBand,
    score: {
      rawDivergenceScore,
      confidenceWeightedDivergenceScore,
      confidenceWeight,
      components,
    },
    deltas,
    familyConfusion,
    direction,
    projection,
    privacy,
    reasons,
    persistence,
  };
}

export function createObserverEvalComparisonMetricsFromCrosswalk(
  crosswalk: ObserverEmotionCrosswalkOutput | undefined,
  details?: Record<string, unknown>,
): ObserverEvalSidecarComparisonMetrics {
  return createObserverEvalComparisonSummary({ crosswalk, details }).persistence;
}

function collectMetricReasons(input: ObserverEvalComparisonSummaryInput): ObserverEvalMetricReason[] {
  const reasons: ObserverEvalMetricReason[] = [];
  if (!input.crosswalk) {
    reasons.push({
      code: 'crosswalk_missing',
      severity: 'blocking',
      detail: 'No PSFN-to-EmoSim crosswalk was available for this observation.',
    });
  } else if (!input.crosswalk.derived.psfn.available) {
    reasons.push({
      code: 'psfn_snapshot_missing',
      severity: 'warning',
      detail: 'The PSFN emotion snapshot was unavailable or redacted; comparison uses partial evidence.',
    });
  }

  if (!input.projection) {
    reasons.push({
      code: 'projection_missing',
      severity: input.crosswalk ? 'info' : 'warning',
      detail: 'Projection provenance was not supplied with the metrics input.',
    });
  } else if (!input.projection.ok) {
    reasons.push({
      code: 'projection_failed',
      severity: 'warning',
      detail: input.projection.error.reason,
    });
  } else if (input.projection.confidence < LOW_PROJECTION_CONFIDENCE_THRESHOLD) {
    reasons.push({
      code: 'projection_low_confidence',
      severity: 'warning',
      detail: 'Projection confidence is low; confidence-weighted divergence is reduced.',
    });
  }

  if (input.privacy) {
    if (!input.privacy.derivedTelemetryPermitted) {
      reasons.push({
        code: 'derived_telemetry_not_permitted',
        severity: 'blocking',
        detail: input.privacy.redactionReason,
      });
    } else if (input.privacy.privacyClass !== 'public') {
      reasons.push({
        code: 'redacted_observation',
        severity: 'info',
        detail: input.privacy.redactionReason,
      });
    }
  }

  const comparison = input.crosswalk?.derived.comparison;
  if (comparison?.labels.familyMismatch) {
    reasons.push({
      code: 'family_mismatch',
      severity: 'warning',
      detail: 'The primary PSFN and EmoSim emotion families differ.',
    });
  }
  if (comparison?.intensity.directionMismatch) {
    reasons.push({
      code: 'direction_mismatch',
      severity: 'warning',
      detail: 'PSFN and EmoSim intensity directions differ.',
    });
  }
  if (comparison?.suppressionOrDecay.patternMismatch) {
    reasons.push({
      code: 'suppression_decay_mismatch',
      severity: 'warning',
      detail: 'PSFN current-vs-mood direction differs from EmoSim stimulus-to-decay direction.',
    });
  }
  if ((comparison?.unknowns.unmappedIntensity ?? 0) > 0) {
    reasons.push({
      code: 'unmapped_signal',
      severity: 'info',
      detail: 'One or both systems produced emotion evidence outside the current comparison ontology.',
    });
  }
  return reasons;
}

function buildComponents(
  comparison: ObserverEmotionCrosswalkOutput['derived']['comparison'],
): ObserverEvalMetricComponent[] {
  const vadValue = normalizeDistance(comparison.valenceArousal.delta.euclideanDistance, MAX_VAD_DISTANCE);
  const familyValue = normalizeFamilyMismatch(
    comparison.labels.familyMismatch,
    comparison.labels.familyOverlap,
  );
  const intensityValue = normalizeDistance(comparison.intensity.absoluteDelta, 1);
  const directionValue = boolScore(comparison.intensity.directionMismatch);
  const suppressionValue = boolScore(comparison.suppressionOrDecay.patternMismatch);
  const unknownValue = normalizeDistance(comparison.unknowns.unmappedIntensity, 1);

  return [
    component('vad', vadValue, 0.35),
    component('family', familyValue, 0.25),
    component('intensity', intensityValue, 0.15),
    component('direction', directionValue, 0.1),
    component('suppression_or_decay', suppressionValue, 0.1),
    component('unknowns', unknownValue, 0.05),
  ];
}

function unavailableComponents(): ObserverEvalMetricComponent[] {
  return [
    component('vad', null, 0.35, 'crosswalk_unavailable'),
    component('family', null, 0.25, 'crosswalk_unavailable'),
    component('intensity', null, 0.15, 'crosswalk_unavailable'),
    component('direction', null, 0.1, 'crosswalk_unavailable'),
    component('suppression_or_decay', null, 0.1, 'crosswalk_unavailable'),
    component('unknowns', null, 0.05, 'crosswalk_unavailable'),
  ];
}

function component(
  name: ObserverEvalMetricComponent['name'],
  value: number | null,
  weight: number,
  reason?: string,
): ObserverEvalMetricComponent {
  return {
    name,
    value,
    weight,
    contribution: value === null ? null : value * weight,
    ...(reason ? { reason } : {}),
  };
}

function buildDeltas(crosswalk: ObserverEmotionCrosswalkOutput | undefined): ObserverEvalPerTurnDeltas {
  const comparison = crosswalk?.derived.comparison;
  return {
    valence: comparison?.valenceArousal.delta.valence ?? null,
    arousal: comparison?.valenceArousal.delta.arousal ?? null,
    vadDistance: comparison?.valenceArousal.delta.euclideanDistance ?? null,
    dominance: comparison?.dominance.absoluteDelta ?? null,
    intensity: comparison?.intensity.absoluteDelta ?? null,
  };
}

function buildFamilyConfusion(
  crosswalk: ObserverEmotionCrosswalkOutput | undefined,
): ObserverEvalFamilyConfusionSummary {
  const comparison = crosswalk?.derived.comparison;
  return {
    psfnPrimaryFamily: comparison?.labels.psfnPrimaryFamily ?? null,
    emosimPrimaryFamily: comparison?.labels.emosimPrimaryFamily ?? null,
    familyMismatch: comparison?.labels.familyMismatch ?? null,
    familyOverlap: comparison?.labels.familyOverlap ?? null,
    psfnPrimaryLabel: comparison?.labels.psfnPrimaryLabel ?? null,
    emosimDominantEmotion: comparison?.labels.emosimDominantEmotion ?? null,
    unmappedSignal: comparison?.unknowns.unmappedIntensity ?? null,
  };
}

function buildDirection(crosswalk: ObserverEmotionCrosswalkOutput | undefined): ObserverEvalDirectionSummary {
  const comparison = crosswalk?.derived.comparison;
  return {
    psfnDirection: comparison?.suppressionOrDecay.psfnCurrentVsMoodDirection ?? null,
    emosimDirection: comparison?.suppressionOrDecay.emosimAfterStimulusToTickDirection ?? null,
    directionMismatch: comparison?.intensity.directionMismatch ?? null,
    suppressionOrDecayMismatch: comparison?.suppressionOrDecay.patternMismatch ?? null,
  };
}

function buildProjectionSummary(
  projection: ObserverAppraisalProjectionResult | undefined,
  confidenceWeight: number | null,
): ObserverEvalProjectionConfidenceSummary {
  const projectionConfidence = projection?.confidence ?? null;
  return {
    projectionConfidence,
    lowConfidence: projectionConfidence !== null && projectionConfidence < LOW_PROJECTION_CONFIDENCE_THRESHOLD,
    projectionAvailable: projection?.ok === true,
    projectionFailed: projection?.ok === false,
    confidenceWeight,
  };
}

function buildPrivacySummary(
  privacy: ObserverEvalPrivacyDecision | undefined,
): ObserverEvalPrivacyMetricSummary {
  return {
    privacyClass: privacy?.privacyClass ?? null,
    sensitivity: privacy?.sensitivity ?? null,
    redactionReason: privacy?.redactionReason ?? null,
    derivedTelemetryPermitted: privacy?.derivedTelemetryPermitted ?? null,
    redactedObservation: privacy ? privacy.privacyClass !== 'public' || privacy.rawContentRedacted : false,
  };
}

function createPersistenceMetrics(input: {
  crosswalk?: ObserverEmotionCrosswalkOutput;
  score: number | null;
  deltas: ObserverEvalPerTurnDeltas;
  familyConfusion: ObserverEvalFamilyConfusionSummary;
  direction: ObserverEvalDirectionSummary;
  reasons: readonly ObserverEvalMetricReason[];
  details?: Record<string, unknown>;
  rawDivergenceScore: number | null;
  confidenceWeight: number | null;
  agreementBand: ObserverEvalAgreementBand;
  status: ObserverEvalMetricsStatus;
  projection: ObserverEvalProjectionConfidenceSummary;
  privacy: ObserverEvalPrivacyMetricSummary;
  components: readonly ObserverEvalMetricComponent[];
}): ObserverEvalSidecarComparisonMetrics {
  return {
    schemaVersion: OBSERVER_EVAL_COMPARISON_METRICS_SCHEMA_VERSION,
    metricsVersion: OBSERVER_EVAL_COMPARISON_METRICS_VERSION,
    divergenceScore: input.score,
    vadDistance: input.deltas.vadDistance,
    familyMismatch: input.familyConfusion.familyMismatch,
    directionMismatch: input.direction.directionMismatch,
    unmappedSignal: input.familyConfusion.unmappedSignal,
    details: {
      ...(input.details ? structuredClone(input.details) : {}),
      status: input.status,
      agreementBand: input.agreementBand,
      rawDivergenceScore: input.rawDivergenceScore,
      confidenceWeight: input.confidenceWeight,
      components: input.components,
      deltas: input.deltas,
      familyConfusion: input.familyConfusion,
      direction: input.direction,
      projection: input.projection,
      privacy: input.privacy,
      reasons: input.reasons,
      crosswalkVersion: input.crosswalk?.crosswalkVersion ?? null,
    },
  };
}

function resolveMetricsStatus(
  crosswalk: ObserverEmotionCrosswalkOutput | undefined,
  reasons: readonly ObserverEvalMetricReason[],
): ObserverEvalMetricsStatus {
  if (!crosswalk) return 'unavailable';
  if (reasons.some(reason => reason.severity === 'blocking')) return 'partial';
  if (reasons.some(reason => EVIDENCE_LIMITATION_REASONS.has(reason.code))) return 'partial';
  return 'available';
}

function resolveAgreementBand(score: number | null): ObserverEvalAgreementBand {
  if (score === null) return 'unavailable';
  if (score < 0.18) return 'aligned';
  if (score < 0.42) return 'watch';
  return 'divergent';
}

function resolveConfidenceWeight(projectionConfidence: number | null): number | null {
  if (projectionConfidence === null) return 1;
  return clamp01(0.35 + clamp01(projectionConfidence) * 0.65);
}

function weightedAverage(components: readonly ObserverEvalMetricComponent[]): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const item of components) {
    if (item.value === null) continue;
    weightedSum += item.value * item.weight;
    weightSum += item.weight;
  }
  if (weightSum <= 0) return null;
  return clamp01(weightedSum / weightSum);
}

function normalizeFamilyMismatch(familyMismatch: boolean, familyOverlap: number | null): number {
  if (!familyMismatch) return clamp01(1 - (familyOverlap ?? 1)) * 0.35;
  return Math.max(0.5, clamp01(1 - (familyOverlap ?? 0)));
}

function normalizeDistance(value: number | null, maxDistance: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return clamp01(Math.abs(value) / maxDistance);
}

function boolScore(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
