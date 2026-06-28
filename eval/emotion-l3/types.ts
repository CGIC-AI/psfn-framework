import type { EvalEmotionLabel } from '../src/types.js';

export const EMOTION_L3_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const EMOTION_L3_BENCHMARK_ARTIFACT_TYPE = 'psfn.emotion_l3_benchmark_report' as const;

export const APPRAISAL_DIMENSIONS = [
  'suddenness',
  'goalRelevance',
  'agencyResponsibility',
  'control',
  'normCompatibility',
  'urgency',
  'valence',
  'arousal',
] as const;

export type AppraisalDimension = typeof APPRAISAL_DIMENSIONS[number];

export type AppraisalVector = Record<AppraisalDimension, number>;

export type EmotionL3InstrumentRole = 'primary_instrument' | 'disagreement_auditor';

export type EmotionL3OutputKind =
  | 'goemotions_style_multilabel'
  | 'label_aware_multilabel'
  | 'appraisal_regression'
  | 'llm_disagreement_audit';

export interface EmotionL3InstrumentVersion {
  instrumentId: string;
  version: string;
  label: string;
  classifierFamily: string;
  artifactUri?: string;
  trainingData?: string;
  createdAt?: string;
}

export interface EmotionL3Input {
  scenarioId: string;
  text: string;
}

export interface EmotionL3GroundTruth {
  scenarioId: string;
  primaryLabel: EvalEmotionLabel;
  secondaryLabels: EvalEmotionLabel[];
  expectedLabels: EvalEmotionLabel[];
  vad: {
    valence: number;
    arousal: number;
    dominance: number;
  };
  appraisalTarget: AppraisalVector;
}

export interface EmotionLabelScore {
  label: EvalEmotionLabel;
  score: number;
}

export interface EmotionL3Disagreement {
  targetInstrumentId: string;
  kind: 'label' | 'appraisal' | 'status';
  severity: 'low' | 'medium' | 'high';
  message: string;
}

export type EmotionL3InstrumentResult =
  | {
      status: 'ok';
      confidence: number;
      labels?: EmotionLabelScore[];
      appraisal?: AppraisalVector;
      audit?: {
        disagreements: EmotionL3Disagreement[];
      };
    }
  | {
      status: 'absent';
      reason: string;
    }
  | {
      status: 'failed';
      reason: string;
    };

export interface EmotionL3AuditContext {
  primaryResults: ReadonlyMap<string, EmotionL3InstrumentResult>;
}

export interface EmotionL3Instrument {
  metadata: EmotionL3InstrumentVersion;
  role: EmotionL3InstrumentRole;
  outputKind: EmotionL3OutputKind;
  isAvailable?: () => boolean;
  analyze: (
    input: EmotionL3Input,
    context?: EmotionL3AuditContext,
  ) => EmotionL3InstrumentResult | Promise<EmotionL3InstrumentResult>;
}

export interface EmotionL3BenchmarkFixture {
  scenarioId: string;
  text: string;
  groundTruth: EmotionL3GroundTruth;
}

export interface EmotionL3BenchmarkOptions {
  fixtures: EmotionL3BenchmarkFixture[];
  instruments: EmotionL3Instrument[];
  generatedAt?: string;
  previousInstrumentVersions?: Record<string, string>;
  labelThreshold?: number;
}

export interface EmotionL3RecalibrationEvent {
  eventType: 'classifier_swap';
  instrumentId: string;
  previousVersion: string;
  currentVersion: string;
  requiresRecalibration: true;
  reason: string;
}

export interface EmotionL3StatusCounts {
  ok: number;
  absent: number;
  failed: number;
}

export interface EmotionL3LabelMetrics {
  primaryAccuracy: number | null;
  multilabelF1: number | null;
}

export interface EmotionL3AppraisalMetrics {
  meanAbsoluteError: number | null;
  byDimension: Record<AppraisalDimension, number | null>;
}

export interface EmotionL3InstrumentSummary {
  instrumentId: string;
  version: string;
  label: string;
  role: EmotionL3InstrumentRole;
  outputKind: EmotionL3OutputKind;
  classifierFamily: string;
  statusCounts: EmotionL3StatusCounts;
  averageConfidence: number | null;
  labelMetrics: EmotionL3LabelMetrics | null;
  appraisalMetrics: EmotionL3AppraisalMetrics | null;
  auditDisagreementCount: number | null;
}

export interface EmotionL3ScenarioReport {
  scenarioId: string;
  groundTruth: EmotionL3GroundTruth;
  primaryInstrumentResults: Record<string, EmotionL3InstrumentResult>;
  disagreementAudits: Record<string, EmotionL3InstrumentResult>;
}

export interface EmotionL3BenchmarkReport {
  schemaVersion: typeof EMOTION_L3_BENCHMARK_SCHEMA_VERSION;
  artifactType: typeof EMOTION_L3_BENCHMARK_ARTIFACT_TYPE;
  generatedAt: string;
  inputs: {
    fixtureCount: number;
    labelThreshold: number;
  };
  recalibrationEvents: EmotionL3RecalibrationEvent[];
  instruments: EmotionL3InstrumentSummary[];
  scenarios: EmotionL3ScenarioReport[];
}
