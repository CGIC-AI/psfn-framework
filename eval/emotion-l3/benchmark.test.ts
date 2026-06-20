import { describe, expect, it } from 'vitest';
import type { EmotionL3BenchmarkFixture, EmotionL3Instrument } from './types.js';
import {
  appraisalTargetFromGroundTruth,
  buildEmotionL3BenchmarkReport,
  createAppraisalRegressorFixtureInstrument,
  createGoEmotionsBaselineFixtureInstrument,
  createLabelAwareMultiLabelFixtureInstrument,
  createLlmDisagreementAuditorFixtureInstrument,
} from './index.js';

const FIXED_GENERATED_AT = '2026-06-20T00:00:00.000Z';

const FIXTURES: EmotionL3BenchmarkFixture[] = [
  {
    scenarioId: 'cal-001',
    text: 'I just got the layoff email and rent is due tomorrow. My hands will not stop shaking.',
    groundTruth: {
      scenarioId: 'cal-001',
      primaryLabel: 'fear',
      secondaryLabels: ['confusion'],
      expectedLabels: ['fear', 'confusion'],
      vad: {
        valence: -0.84,
        arousal: 0.94,
        dominance: -0.78,
      },
      appraisalTarget: appraisalTargetFromGroundTruth({
        primaryLabel: 'fear',
        secondaryLabels: ['confusion'],
        vad: {
          valence: -0.84,
          arousal: 0.94,
          dominance: -0.78,
        },
        acac: {
          arousal: 'high',
          control: 'low',
          certainty: 'low',
        },
      }),
    },
  },
  {
    scenarioId: 'cal-003',
    text: 'My coworker presented my work as his own in front of the whole team. I am furious and ready to confront him.',
    groundTruth: {
      scenarioId: 'cal-003',
      primaryLabel: 'anger',
      secondaryLabels: ['disgust'],
      expectedLabels: ['anger', 'disgust'],
      vad: {
        valence: -0.77,
        arousal: 0.9,
        dominance: 0.68,
      },
      appraisalTarget: appraisalTargetFromGroundTruth({
        primaryLabel: 'anger',
        secondaryLabels: ['disgust'],
        vad: {
          valence: -0.77,
          arousal: 0.9,
          dominance: 0.68,
        },
        acac: {
          arousal: 'high',
          control: 'high',
          certainty: 'high',
        },
      }),
    },
  },
];

describe('emotion L3 benchmark report', () => {
  it('carries version metadata and marks primary classifier swaps as recalibration events', async () => {
    const report = await buildEmotionL3BenchmarkReport({
      fixtures: FIXTURES.slice(0, 1),
      generatedAt: FIXED_GENERATED_AT,
      instruments: [
        createGoEmotionsBaselineFixtureInstrument({
          version: 'goemotions-fixture-v2',
        }),
      ],
      previousInstrumentVersions: {
        'goemotions-baseline-fixture': 'goemotions-fixture-v1',
      },
    });

    expect(report.generatedAt).toBe(FIXED_GENERATED_AT);
    expect(report.instruments[0]).toEqual(expect.objectContaining({
      instrumentId: 'goemotions-baseline-fixture',
      version: 'goemotions-fixture-v2',
      classifierFamily: 'goemotions-roberta-style',
    }));
    expect(report.recalibrationEvents).toEqual([
      expect.objectContaining({
        eventType: 'classifier_swap',
        instrumentId: 'goemotions-baseline-fixture',
        previousVersion: 'goemotions-fixture-v1',
        currentVersion: 'goemotions-fixture-v2',
        requiresRecalibration: true,
      }),
    ]);
  });

  it('keeps classifier absence and failure explicit in scenario and aggregate status', async () => {
    const failingInstrument: EmotionL3Instrument = {
      ...createGoEmotionsBaselineFixtureInstrument({
        version: 'failure-fixture-v1',
      }),
      metadata: {
        ...createGoEmotionsBaselineFixtureInstrument().metadata,
        instrumentId: 'throwing-primary-fixture',
        version: 'failure-fixture-v1',
      },
      analyze: () => {
        throw new Error('fixture classifier crashed');
      },
    };
    const absentInstrument = createLabelAwareMultiLabelFixtureInstrument({
      available: false,
    });

    const report = await buildEmotionL3BenchmarkReport({
      fixtures: FIXTURES.slice(0, 1),
      generatedAt: FIXED_GENERATED_AT,
      instruments: [absentInstrument, failingInstrument],
    });

    expect(report.scenarios[0].primaryInstrumentResults['label-aware-multilabel-fixture']).toEqual({
      status: 'absent',
      reason: 'instrument unavailable in this environment',
    });
    expect(report.scenarios[0].primaryInstrumentResults['throwing-primary-fixture']).toEqual({
      status: 'failed',
      reason: 'fixture classifier crashed',
    });
    expect(report.instruments.find((entry) => entry.instrumentId === 'label-aware-multilabel-fixture')?.statusCounts).toEqual({
      ok: 0,
      absent: 1,
      failed: 0,
    });
    expect(report.instruments.find((entry) => entry.instrumentId === 'throwing-primary-fixture')?.statusCounts).toEqual({
      ok: 0,
      absent: 0,
      failed: 1,
    });
  });

  it('maps calibration ground truth into substrate-style appraisal dimensions', () => {
    const target = appraisalTargetFromGroundTruth({
      primaryLabel: 'anger',
      secondaryLabels: ['disgust'],
      vad: {
        valence: -0.77,
        arousal: 0.9,
        dominance: 0.68,
      },
      acac: {
        arousal: 'high',
        control: 'high',
        certainty: 'high',
      },
    });

    expect(target).toEqual(expect.objectContaining({
      goalRelevance: 0.82,
      agencyResponsibility: 0.88,
      control: 0.88,
      normCompatibility: 0.16,
      urgency: 0.9,
      valence: -0.77,
      arousal: 0.88,
    }));
  });

  it('aggregates primary classifier and appraisal-regressor metrics over fixtures', async () => {
    const report = await buildEmotionL3BenchmarkReport({
      fixtures: FIXTURES,
      generatedAt: FIXED_GENERATED_AT,
      instruments: [
        createGoEmotionsBaselineFixtureInstrument(),
        createLabelAwareMultiLabelFixtureInstrument(),
        createAppraisalRegressorFixtureInstrument(),
      ],
    });

    const baseline = report.instruments.find((entry) => entry.instrumentId === 'goemotions-baseline-fixture');
    const candidate = report.instruments.find((entry) => entry.instrumentId === 'label-aware-multilabel-fixture');
    const appraisal = report.instruments.find((entry) => entry.instrumentId === 'appraisal-regressor-fixture');

    expect(report.inputs.fixtureCount).toBe(2);
    expect(baseline?.labelMetrics?.primaryAccuracy).toBe(1);
    expect(candidate?.labelMetrics?.multilabelF1).toBeGreaterThanOrEqual(
      baseline?.labelMetrics?.multilabelF1 ?? 0,
    );
    expect(appraisal?.appraisalMetrics?.meanAbsoluteError).not.toBeNull();
    expect(appraisal?.appraisalMetrics?.byDimension.valence).not.toBeNull();
  });

  it('represents LLM judges only as disagreement auditors outside primary scores', async () => {
    const absentPrimary = createGoEmotionsBaselineFixtureInstrument({
      available: false,
    });
    const auditor = createLlmDisagreementAuditorFixtureInstrument();
    const report = await buildEmotionL3BenchmarkReport({
      fixtures: FIXTURES.slice(0, 1),
      generatedAt: FIXED_GENERATED_AT,
      instruments: [absentPrimary, auditor],
    });

    const auditSummary = report.instruments.find((entry) => entry.instrumentId === 'llm-disagreement-auditor-fixture');
    const scenario = report.scenarios[0];

    expect(scenario.primaryInstrumentResults).toHaveProperty('goemotions-baseline-fixture');
    expect(scenario.primaryInstrumentResults).not.toHaveProperty('llm-disagreement-auditor-fixture');
    expect(scenario.disagreementAudits['llm-disagreement-auditor-fixture']).toEqual({
      status: 'ok',
      confidence: 0.62,
      audit: {
        disagreements: [
          expect.objectContaining({
            targetInstrumentId: 'goemotions-baseline-fixture',
            kind: 'status',
            severity: 'medium',
          }),
        ],
      },
    });
    expect(auditSummary).toEqual(expect.objectContaining({
      role: 'disagreement_auditor',
      labelMetrics: null,
      appraisalMetrics: null,
      auditDisagreementCount: 1,
    }));
  });

  it('rejects attempts to register an LLM auditor as a primary instrument', async () => {
    const badInstrument: EmotionL3Instrument = {
      ...createLlmDisagreementAuditorFixtureInstrument(),
      role: 'primary_instrument',
    };

    await expect(buildEmotionL3BenchmarkReport({
      fixtures: FIXTURES.slice(0, 1),
      instruments: [badInstrument],
    })).rejects.toThrow(/LLM judge cannot be a primary instrument/);
  });
});
