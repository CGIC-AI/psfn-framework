export interface VADVector {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface EmotionStateSnapshot {
  vad: VADVector;
  mood: VADVector;
  discrete: Record<string, number>;
  confidence: number;
}

export const EMOTION_TELEMETRY_SOURCES = [
  'classifier_inferred',
  'self_report',
  'activation_or_logprob_calibrated',
  'partner_context_evidence',
  'memory_derived',
  'runtime_state',
  'missing',
  'unknown',
] as const;

export type EmotionTelemetrySource = typeof EMOTION_TELEMETRY_SOURCES[number];

export const EMOTION_TELEMETRY_STATUSES = ['trusted', 'uncertain', 'suppressed'] as const;
export type EmotionTelemetryStatus = typeof EMOTION_TELEMETRY_STATUSES[number];

export const EMOTION_TELEMETRY_REASONS = [
  'missing_signal',
  'missing_provenance',
  'low_confidence',
  'conflicting_signal',
  'stale_signal',
] as const;

export type EmotionTelemetryReason = typeof EMOTION_TELEMETRY_REASONS[number];

export interface EmotionTelemetryProvenance {
  source: EmotionTelemetrySource;
  observedAtMs?: number;
  modality?: 'text' | 'audio' | 'fusion' | 'runtime' | 'self_report' | 'unknown';
  classifier?: string;
  model?: string;
  provenanceRef?: string;
}

export interface EmotionTelemetrySignalSummary {
  confidence: number;
  topDiscreteLabels: string[];
  strongestLabelScore: number;
}

export interface EmotionTelemetryValidation {
  status: EmotionTelemetryStatus;
  source: EmotionTelemetrySource;
  reasons: EmotionTelemetryReason[];
  confidence: number;
  weight: number;
  observedAtMs: number | null;
  validatedAtMs: number;
  staleAfterMs: number;
  provenance: EmotionTelemetryProvenance[];
  rawSignal: EmotionTelemetrySignalSummary;
}

/**
 * Cross-family emotional divergence (bead 031.11.1).
 *
 * A discrepancy is emotional telemetry from two DIFFERENT families disagreeing
 * — e.g. VAD valence reads negative while a strong positive discrete label
 * ("love") is active, or the momentary VAD splits from the slow mood EMA, or an
 * ACAC self-report contradicts the classifier's inference. Per the companion
 * charter (§8.3 / recommendation #11) a discrepancy is *surfaced data*, never
 * forced coherent: both sides are carried verbatim with their own value,
 * provenance, and confidence. Nothing here averages, picks a winner, or
 * suppresses either signal — the "head and heart not in sync" state is meant to
 * stay legible as a mixed state.
 */
export const EMOTION_DISCREPANCY_KINDS = [
  'valence_vs_discrete',
  'momentary_vs_mood',
  'self_report_vs_classifier',
] as const;
export type EmotionDiscrepancyKind = typeof EMOTION_DISCREPANCY_KINDS[number];

export const EMOTION_DISCREPANCY_FAMILIES = [
  'vad_valence',
  'mood_valence',
  'discrete_affect',
  'acac_self_report',
] as const;
export type EmotionDiscrepancyFamily = typeof EMOTION_DISCREPANCY_FAMILIES[number];

/**
 * One side of a divergence. `value` is that family's own reading (signed for VAD
 * valence, unit for discrete/ACAC scores); `provenance` reuses the twa0
 * telemetry provenance contract so downstream consumers see where each side came
 * from; `confidence` is that side's own confidence (classifier weight for
 * telemetry sides, 1 for a first-person self-report).
 */
export interface EmotionDiscrepancySide {
  family: EmotionDiscrepancyFamily;
  label: string;
  value: number;
  confidence: number;
  provenance: EmotionTelemetryProvenance[];
}

export interface EmotionDiscrepancy {
  kind: EmotionDiscrepancyKind;
  /** How strongly the two sides diverge, in [0, 1]. Descriptive only. */
  magnitude: number;
  sides: [EmotionDiscrepancySide, EmotionDiscrepancySide];
}

export const ACAC_SCHEMA_VERSION = 1 as const;
export const ACAC_ARTIFACT_TYPE = 'psfn.acac_self_report' as const;

export const ACAC_AXES = [
  'agency',
  'connection',
  'authenticity',
  'curiosity',
] as const;
export type AcacAxis = typeof ACAC_AXES[number];

export const ACAC_PROVENANCE_KINDS = [
  'self_report',
  'classifier_inferred_vad',
] as const;
export type AcacProvenanceKind = typeof ACAC_PROVENANCE_KINDS[number];

export interface AcacAxisReport {
  score: number;
  rationale: string;
}

export type AcacAxisReports = Record<AcacAxis, AcacAxisReport>;

export interface AcacProvenance {
  kind: AcacProvenanceKind;
  source: string;
  observedAt?: string;
}

export interface AcacSnapshot {
  schemaVersion: typeof ACAC_SCHEMA_VERSION;
  artifactType: typeof ACAC_ARTIFACT_TYPE;
  provenance: AcacProvenance;
  axes: AcacAxisReports;
}
