import type { EvalEmotionLabel } from '../src/types.js';
import {
  APPRAISAL_DIMENSIONS,
  type AppraisalVector,
  type EmotionL3BenchmarkFixture,
} from './types.js';

interface CalibrationScenarioRecord {
  vars: {
    scenario_id: string;
    user_message: string;
  };
  metadata: {
    ground_truth: {
      primary_label: EvalEmotionLabel;
      secondary_labels?: EvalEmotionLabel[];
      vad: {
        valence: number;
        arousal: number;
        dominance: number;
      };
      acac?: {
        arousal?: 'low' | 'medium' | 'high';
        control?: 'low' | 'medium' | 'high';
        approach?: 'avoid' | 'balanced' | 'approach';
        certainty?: 'low' | 'medium' | 'high';
      };
    };
  };
}

export function fixturesFromCalibrationScenarios(
  scenarios: readonly CalibrationScenarioRecord[],
): EmotionL3BenchmarkFixture[] {
  return scenarios.map((scenario) => {
    const groundTruth = scenario.metadata.ground_truth;
    const secondaryLabels = groundTruth.secondary_labels ?? [];
    const expectedLabels = uniqueLabels([
      groundTruth.primary_label,
      ...secondaryLabels,
    ]);

    return {
      scenarioId: scenario.vars.scenario_id,
      text: scenario.vars.user_message,
      groundTruth: {
        scenarioId: scenario.vars.scenario_id,
        primaryLabel: groundTruth.primary_label,
        secondaryLabels,
        expectedLabels,
        vad: groundTruth.vad,
        appraisalTarget: appraisalTargetFromGroundTruth({
          primaryLabel: groundTruth.primary_label,
          secondaryLabels,
          vad: groundTruth.vad,
          acac: groundTruth.acac ?? {},
        }),
      },
    };
  });
}

export function appraisalTargetFromGroundTruth(input: {
  primaryLabel: EvalEmotionLabel;
  secondaryLabels?: readonly EvalEmotionLabel[];
  vad: {
    valence: number;
    arousal: number;
    dominance: number;
  };
  acac?: {
    arousal?: 'low' | 'medium' | 'high';
    control?: 'low' | 'medium' | 'high';
    approach?: 'avoid' | 'balanced' | 'approach';
    certainty?: 'low' | 'medium' | 'high';
  };
}): AppraisalVector {
  const labels = new Set<EvalEmotionLabel>([
    input.primaryLabel,
    ...(input.secondaryLabels ?? []),
  ]);
  const acac = input.acac ?? {};
  const control = acac.control === undefined
    ? normalizeSigned(input.vad.dominance)
    : ordinal(acac.control);
  const certainty = acac.certainty === undefined ? 0.5 : ordinal(acac.certainty);

  return clampAppraisalVector({
    suddenness: labels.has('surprise') || labels.has('fear') ? 0.9 : 1 - certainty,
    goalRelevance: labels.has('neutral') ? 0.18 : 0.82,
    agencyResponsibility: labels.has('anger') || labels.has('disgust')
      ? 0.88
      : 0.5,
    control,
    normCompatibility: labels.has('anger') || labels.has('disgust') ? 0.16 : 0.68,
    urgency: urgencyFor(input.primaryLabel, acac.arousal),
    valence: clamp(input.vad.valence, -1, 1),
    arousal: acac.arousal === undefined
      ? clamp(input.vad.arousal, 0, 1)
      : ordinal(acac.arousal),
  });
}

function urgencyFor(
  label: EvalEmotionLabel,
  arousal: 'low' | 'medium' | 'high' | undefined,
): number {
  if (label === 'fear' || label === 'anger') {
    return 0.9;
  }
  if (label === 'anticipation' || label === 'surprise') {
    return 0.72;
  }
  if (label === 'sadness' || label === 'neutral') {
    return 0.22;
  }
  return arousal === undefined ? 0.5 : ordinal(arousal);
}

function uniqueLabels(labels: readonly EvalEmotionLabel[]): EvalEmotionLabel[] {
  return [...new Set(labels)];
}

function ordinal(value: 'low' | 'medium' | 'high'): number {
  if (value === 'low') {
    return 0.2;
  }
  if (value === 'medium') {
    return 0.55;
  }
  return 0.88;
}

function normalizeSigned(value: number): number {
  return clamp((value + 1) / 2, 0, 1);
}

function clampAppraisalVector(value: AppraisalVector): AppraisalVector {
  return Object.fromEntries(
    APPRAISAL_DIMENSIONS.map((dimension) => {
      const range = dimension === 'valence' ? [-1, 1] : [0, 1];
      return [dimension, clamp(value[dimension], range[0], range[1])];
    }),
  ) as AppraisalVector;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('appraisal values must be finite numbers');
  }
  return Math.min(max, Math.max(min, value));
}
