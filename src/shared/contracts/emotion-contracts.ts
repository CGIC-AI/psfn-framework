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
