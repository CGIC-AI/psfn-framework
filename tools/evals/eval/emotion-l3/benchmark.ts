import type { EvalEmotionLabel } from '../src/types.js';
import {
  APPRAISAL_DIMENSIONS,
  EMOTION_L3_BENCHMARK_ARTIFACT_TYPE,
  EMOTION_L3_BENCHMARK_SCHEMA_VERSION,
  type AppraisalDimension,
  type EmotionL3AppraisalMetrics,
  type EmotionL3BenchmarkOptions,
  type EmotionL3BenchmarkReport,
  type EmotionL3Instrument,
  type EmotionL3InstrumentResult,
  type EmotionL3InstrumentSummary,
  type EmotionL3LabelMetrics,
  type EmotionL3RecalibrationEvent,
  type EmotionL3ScenarioReport,
  type EmotionL3StatusCounts,
} from './types.js';

interface InstrumentAccumulator {
  instrument: EmotionL3Instrument;
  statusCounts: EmotionL3StatusCounts;
  confidenceValues: number[];
  primaryCorrect: number;
  primaryScored: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  appraisalErrors: Record<AppraisalDimension, number[]>;
  auditDisagreementCount: number;
}

const DEFAULT_LABEL_THRESHOLD = 0.5;

export async function buildEmotionL3BenchmarkReport(
  options: EmotionL3BenchmarkOptions,
): Promise<EmotionL3BenchmarkReport> {
  if (options.fixtures.length === 0) {
    throw new Error('fixtures must contain at least one calibration fixture');
  }
  if (options.instruments.length === 0) {
    throw new Error('instruments must contain at least one L3 instrument');
  }

  const labelThreshold = options.labelThreshold ?? DEFAULT_LABEL_THRESHOLD;
  const instruments = options.instruments.map(validateInstrument);
  const accumulators = new Map<string, InstrumentAccumulator>(
    instruments.map((instrument) => [
      instrument.metadata.instrumentId,
      createAccumulator(instrument),
    ]),
  );
  const scenarios: EmotionL3ScenarioReport[] = [];

  for (const fixture of options.fixtures) {
    const primaryInstrumentResults: Record<string, EmotionL3InstrumentResult> = {};
    const disagreementAudits: Record<string, EmotionL3InstrumentResult> = {};
    const primaryContext = new Map<string, EmotionL3InstrumentResult>();

    for (const instrument of instruments.filter((entry) => entry.role === 'primary_instrument')) {
      const result = await runInstrument(instrument, fixture);
      primaryInstrumentResults[instrument.metadata.instrumentId] = result;
      primaryContext.set(instrument.metadata.instrumentId, result);
      updateAccumulator(
        getAccumulator(accumulators, instrument),
        result,
        fixture.groundTruth.expectedLabels,
        fixture.groundTruth.primaryLabel,
        fixture.groundTruth.appraisalTarget,
        labelThreshold,
      );
    }

    for (const instrument of instruments.filter((entry) => entry.role === 'disagreement_auditor')) {
      const result = await runInstrument(instrument, fixture, {
        primaryResults: primaryContext,
      });
      disagreementAudits[instrument.metadata.instrumentId] = result;
      updateAccumulator(
        getAccumulator(accumulators, instrument),
        result,
        fixture.groundTruth.expectedLabels,
        fixture.groundTruth.primaryLabel,
        fixture.groundTruth.appraisalTarget,
        labelThreshold,
      );
    }

    scenarios.push({
      scenarioId: fixture.scenarioId,
      groundTruth: fixture.groundTruth,
      primaryInstrumentResults,
      disagreementAudits,
    });
  }

  return {
    schemaVersion: EMOTION_L3_BENCHMARK_SCHEMA_VERSION,
    artifactType: EMOTION_L3_BENCHMARK_ARTIFACT_TYPE,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    inputs: {
      fixtureCount: options.fixtures.length,
      labelThreshold,
    },
    recalibrationEvents: detectRecalibrationEvents(
      instruments,
      options.previousInstrumentVersions ?? {},
    ),
    instruments: instruments.map((instrument) =>
      summarizeAccumulator(getAccumulator(accumulators, instrument)),
    ),
    scenarios,
  };
}

function validateInstrument(instrument: EmotionL3Instrument): EmotionL3Instrument {
  const { metadata } = instrument;
  if (metadata.instrumentId.trim().length === 0) {
    throw new Error('instrument metadata must include a non-empty instrumentId');
  }
  if (metadata.version.trim().length === 0) {
    throw new Error(`${metadata.instrumentId} metadata must include a non-empty version`);
  }
  if (metadata.classifierFamily.trim().length === 0) {
    throw new Error(`${metadata.instrumentId} metadata must include classifierFamily`);
  }
  if (
    instrument.role === 'disagreement_auditor'
    && instrument.outputKind !== 'llm_disagreement_audit'
  ) {
    throw new Error(`${metadata.instrumentId} auditors must use llm_disagreement_audit output`);
  }
  if (
    instrument.role === 'primary_instrument'
    && instrument.outputKind === 'llm_disagreement_audit'
  ) {
    throw new Error(`${metadata.instrumentId} LLM judge cannot be a primary instrument`);
  }
  return instrument;
}

async function runInstrument(
  instrument: EmotionL3Instrument,
  fixture: {
    scenarioId: string;
    text: string;
  },
  context?: Parameters<EmotionL3Instrument['analyze']>[1],
): Promise<EmotionL3InstrumentResult> {
  if (instrument.isAvailable !== undefined && !instrument.isAvailable()) {
    return {
      status: 'absent',
      reason: 'instrument unavailable in this environment',
    };
  }

  try {
    return normalizeInstrumentResult(
      await instrument.analyze({
        scenarioId: fixture.scenarioId,
        text: fixture.text,
      }, context),
      instrument.metadata.instrumentId,
    );
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeInstrumentResult(
  result: EmotionL3InstrumentResult,
  instrumentId: string,
): EmotionL3InstrumentResult {
  if (result.status !== 'ok') {
    if (result.reason.trim().length === 0) {
      throw new Error(`${instrumentId} returned ${result.status} without a reason`);
    }
    return result;
  }

  if (!isUnitScore(result.confidence)) {
    throw new Error(`${instrumentId} confidence must be a finite number from 0 to 1`);
  }
  if (result.labels !== undefined) {
    for (const score of result.labels) {
      if (!isUnitScore(score.score)) {
        throw new Error(`${instrumentId} label scores must be finite numbers from 0 to 1`);
      }
    }
  }
  if (result.appraisal !== undefined) {
    for (const dimension of APPRAISAL_DIMENSIONS) {
      const score = result.appraisal[dimension];
      const min = dimension === 'valence' ? -1 : 0;
      if (!Number.isFinite(score) || score < min || score > 1) {
        throw new Error(`${instrumentId} appraisal.${dimension} is out of range`);
      }
    }
  }
  return result;
}

function updateAccumulator(
  accumulator: InstrumentAccumulator,
  result: EmotionL3InstrumentResult,
  expectedLabels: readonly EvalEmotionLabel[],
  primaryLabel: EvalEmotionLabel,
  appraisalTarget: Record<AppraisalDimension, number>,
  labelThreshold: number,
): void {
  accumulator.statusCounts[result.status] += 1;
  if (result.status !== 'ok') {
    return;
  }

  accumulator.confidenceValues.push(result.confidence);
  accumulator.auditDisagreementCount += result.audit?.disagreements.length ?? 0;

  if (accumulator.instrument.role === 'disagreement_auditor') {
    return;
  }

  if (result.labels !== undefined) {
    const labels = result.labels.filter((score) => score.score >= labelThreshold);
    const predicted = new Set(labels.map((score) => score.label));
    const expected = new Set(expectedLabels);
    const topLabel = result.labels[0]?.label;
    accumulator.primaryScored += 1;
    if (topLabel === primaryLabel) {
      accumulator.primaryCorrect += 1;
    }

    for (const label of predicted) {
      if (expected.has(label)) {
        accumulator.truePositive += 1;
      } else {
        accumulator.falsePositive += 1;
      }
    }
    for (const label of expected) {
      if (!predicted.has(label)) {
        accumulator.falseNegative += 1;
      }
    }
  }

  if (result.appraisal !== undefined) {
    for (const dimension of APPRAISAL_DIMENSIONS) {
      accumulator.appraisalErrors[dimension].push(
        Math.abs(result.appraisal[dimension] - appraisalTarget[dimension]),
      );
    }
  }
}

function summarizeAccumulator(
  accumulator: InstrumentAccumulator,
): EmotionL3InstrumentSummary {
  return {
    instrumentId: accumulator.instrument.metadata.instrumentId,
    version: accumulator.instrument.metadata.version,
    label: accumulator.instrument.metadata.label,
    role: accumulator.instrument.role,
    outputKind: accumulator.instrument.outputKind,
    classifierFamily: accumulator.instrument.metadata.classifierFamily,
    statusCounts: accumulator.statusCounts,
    averageConfidence: meanOrNull(accumulator.confidenceValues),
    labelMetrics: accumulator.instrument.role === 'primary_instrument'
      ? labelMetrics(accumulator)
      : null,
    appraisalMetrics: accumulator.instrument.role === 'primary_instrument'
      ? appraisalMetrics(accumulator)
      : null,
    auditDisagreementCount: accumulator.instrument.role === 'disagreement_auditor'
      ? accumulator.auditDisagreementCount
      : null,
  };
}

function labelMetrics(accumulator: InstrumentAccumulator): EmotionL3LabelMetrics | null {
  if (
    accumulator.instrument.outputKind !== 'goemotions_style_multilabel'
    && accumulator.instrument.outputKind !== 'label_aware_multilabel'
  ) {
    return null;
  }

  return {
    primaryAccuracy: accumulator.primaryScored === 0
      ? null
      : round(accumulator.primaryCorrect / accumulator.primaryScored),
    multilabelF1: f1(
      accumulator.truePositive,
      accumulator.falsePositive,
      accumulator.falseNegative,
    ),
  };
}

function appraisalMetrics(
  accumulator: InstrumentAccumulator,
): EmotionL3AppraisalMetrics | null {
  if (accumulator.instrument.outputKind !== 'appraisal_regression') {
    return null;
  }

  const byDimension = Object.fromEntries(
    APPRAISAL_DIMENSIONS.map((dimension) => [
      dimension,
      meanOrNull(accumulator.appraisalErrors[dimension]),
    ]),
  ) as Record<AppraisalDimension, number | null>;
  const allErrors = APPRAISAL_DIMENSIONS.flatMap(
    (dimension) => accumulator.appraisalErrors[dimension],
  );

  return {
    meanAbsoluteError: meanOrNull(allErrors),
    byDimension,
  };
}

function detectRecalibrationEvents(
  instruments: readonly EmotionL3Instrument[],
  previousVersions: Record<string, string>,
): EmotionL3RecalibrationEvent[] {
  return instruments
    .filter((instrument) => instrument.role === 'primary_instrument')
    .flatMap((instrument) => {
      const previousVersion = previousVersions[instrument.metadata.instrumentId];
      if (
        previousVersion === undefined
        || previousVersion === instrument.metadata.version
      ) {
        return [];
      }
      return [{
        eventType: 'classifier_swap' as const,
        instrumentId: instrument.metadata.instrumentId,
        previousVersion,
        currentVersion: instrument.metadata.version,
        requiresRecalibration: true as const,
        reason: 'Primary L3 instrument version changed; downstream calibration tables must be regenerated.',
      }];
    });
}

function createAccumulator(instrument: EmotionL3Instrument): InstrumentAccumulator {
  return {
    instrument,
    statusCounts: {
      ok: 0,
      absent: 0,
      failed: 0,
    },
    confidenceValues: [],
    primaryCorrect: 0,
    primaryScored: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    appraisalErrors: Object.fromEntries(
      APPRAISAL_DIMENSIONS.map((dimension) => [dimension, []]),
    ) as Record<AppraisalDimension, number[]>,
    auditDisagreementCount: 0,
  };
}

function getAccumulator(
  accumulators: ReadonlyMap<string, InstrumentAccumulator>,
  instrument: EmotionL3Instrument,
): InstrumentAccumulator {
  const accumulator = accumulators.get(instrument.metadata.instrumentId);
  if (accumulator === undefined) {
    throw new Error(`missing accumulator for ${instrument.metadata.instrumentId}`);
  }
  return accumulator;
}

function f1(truePositive: number, falsePositive: number, falseNegative: number): number | null {
  const denominator = (2 * truePositive) + falsePositive + falseNegative;
  if (denominator === 0) {
    return null;
  }
  return round((2 * truePositive) / denominator);
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isUnitScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
