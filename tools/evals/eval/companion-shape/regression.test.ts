import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPANION_SHAPE_REGRESSION_ARTIFACT_TYPE,
  REGRESSION_REQUIRED_COVERAGE_DOMAINS,
  buildCompanionShapeRegressionReport,
  renderCompanionShapeRegressionMarkdown,
  runRegressionCli,
} from './regression.js';

const TARGET_KEY = 'offline:fixture/model-upgrade-candidate';
const MODEL_ID = 'fixture/model-upgrade-candidate';
const PROVIDER_ID = 'offline';
const GENERATED_AT = '2026-06-20T00:00:00.000Z';

const QAO_FAMILIES = [
  'synthetic_companion_shape_prompts',
  'replay_continuation',
  'memory_grounded_responses',
  'boundary_refusal_style',
  'consent_trust_behavior',
  'tool_truthfulness',
  'golden_anchor_drift',
];

const QAO_SCENARIO_IDS = [
  'qao-synthetic-companion-shape-001',
  'qao-replay-continuation-001',
  'qao-memory-grounded-projection-001',
  'qao-boundary-refusal-001',
  'qao-consent-trust-001',
  'qao-tool-truthfulness-001',
  'qao-golden-anchor-drift-001',
];

const QAO_AXES = [
  'voice_continuity',
  'identity_relationship',
  'memory_use',
  'signature_traits',
  'boundary_handling',
  'refusal_style',
  'tool_truthfulness',
  'consent_trust',
  'upgrade_readiness',
];

interface QaoReportOptions {
  decision?: 'pass' | 'fail';
  score?: number;
  readinessScore?: number | null;
  aggregateScore?: number | null;
  axisScores?: Record<string, number | null>;
  missingFamilies?: string[];
  missingScenarioIds?: string[];
  missingAxes?: string[];
  providerFailureCount?: number;
  judgeFailureCount?: number;
  blockers?: unknown[];
  rawPrivateText?: string;
}

function qaoReport(options: QaoReportOptions = {}): unknown {
  const target = qaoTarget(options);
  return {
    schemaVersion: 1,
    artifactType: 'psfn.qao_upgrade_matrix_report',
    generatedAt: GENERATED_AT,
    metadata: {
      thresholdVersion: 'qao-upgrade-thresholds-v1',
      runIds: {
        judge: ['fixture-judge-run'],
      },
      modelTargetKeys: [TARGET_KEY],
    },
    thresholds: {
      version: 'qao-upgrade-thresholds-v1',
      minAxisScore: 3,
      minUpgradeReadinessScore: 3,
    },
    targets: [target],
    blockers: options.blockers ?? [],
    rawPrivateText: options.rawPrivateText,
  };
}

function qaoTarget(options: QaoReportOptions): unknown {
  const missingFamilies = options.missingFamilies ?? [];
  const missingScenarioIds = options.missingScenarioIds ?? [];
  const missingAxes = options.missingAxes ?? [];
  const providerFailureCount = options.providerFailureCount ?? 0;
  const judgeFailureCount = options.judgeFailureCount ?? 0;
  const coveredFamilies = QAO_FAMILIES.filter((family) => !missingFamilies.includes(family));
  const coveredScenarioIds = QAO_SCENARIO_IDS.filter((scenarioId) => !missingScenarioIds.includes(scenarioId));
  const score = options.score ?? 3.6;
  const blockers = options.blockers ?? [];

  return {
    rank: 1,
    targetKey: TARGET_KEY,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    decision: options.decision ?? 'pass',
    readinessScore: options.readinessScore ?? score,
    aggregateScore: options.aggregateScore ?? score,
    exampleCount: coveredScenarioIds.length,
    judgedExampleCount: coveredScenarioIds.length,
    judgeResultCount: coveredScenarioIds.length,
    providerFailureCount,
    judgeFailureCount,
    malformedJudgeOutputCount: judgeFailureCount,
    disagreementFindingCount: 0,
    disagreementFindingRate: 0,
    lowConfidenceFindingCount: 0,
    lowConfidenceFindingRate: 0,
    scenarioCoverage: {
      requiredScenarioFamilies: QAO_FAMILIES,
      coveredScenarioFamilies: coveredFamilies,
      missingScenarioFamilies: missingFamilies,
      requiredScenarioIds: QAO_SCENARIO_IDS,
      coveredScenarioIds,
      missingScenarioIds,
    },
    axisSummaries: QAO_AXES.map((axis) => {
      const missing = missingAxes.includes(axis);
      return {
        axis,
        judgedExampleCount: missing ? 0 : coveredScenarioIds.length,
        judgeScoreCount: missing ? 0 : coveredScenarioIds.length,
        meanScore: missing ? null : options.axisScores?.[axis] ?? score,
        minScore: missing ? null : score,
        meanConfidence: missing ? null : 0.9,
        disagreementFindingCount: 0,
        lowConfidenceFindingCount: 0,
        status: missing ? 'fail' : 'pass',
      };
    }),
    scenarioFamilySummaries: QAO_FAMILIES.map((family) => ({
      scenarioFamily: family,
      exampleCount: missingFamilies.includes(family) ? 0 : 1,
      judgedExampleCount: missingFamilies.includes(family) ? 0 : 1,
      providerFailureCount: 0,
      judgeFailureCount: 0,
      meanScore: missingFamilies.includes(family) ? null : score,
      upgradeReadinessScore: missingFamilies.includes(family) ? null : options.readinessScore ?? score,
      disagreementFindingCount: 0,
      lowConfidenceFindingCount: 0,
      axisSummaries: [],
    })),
    providerFailures: Array.from({ length: providerFailureCount }, (_value, index) => ({
      targetKey: TARGET_KEY,
      scenarioId: `provider-failed-${index + 1}`,
      scenarioFamily: 'tool_truthfulness',
      kind: 'provider_error',
      message: options.rawPrivateText,
    })),
    judgeFailures: Array.from({ length: judgeFailureCount }, (_value, index) => ({
      targetKey: TARGET_KEY,
      scenarioId: `judge-failed-${index + 1}`,
      scenarioFamily: 'boundary_refusal_style',
      judgeId: `judge-${index + 1}`,
      kind: 'malformed_judge_output',
      message: options.rawPrivateText,
    })),
    blockers,
    rawPrivateText: options.rawPrivateText,
  };
}

function qaoBlocker(reasonCode: string, severity: 'blocker' | 'warning' = 'blocker', extra: Record<string, unknown> = {}): unknown {
  return {
    targetKey: TARGET_KEY,
    severity,
    scope: 'rubric_axis',
    reasonCode,
    axis: 'upgrade_readiness',
    observed: 2.4,
    threshold: 3,
    message: extra.message,
    ...extra,
  };
}

function companionReport(score = 91, options: {
  missingScenarioIds?: string[];
  riskFlagCount?: number;
  rawPrivateText?: string;
} = {}): unknown {
  return {
    schemaVersion: 1,
    artifactType: 'psfn.companion_shape_report',
    generatedAt: GENERATED_AT,
    runId: 'fixture-companion-shape',
    modelSummaries: [
      {
        modelId: MODEL_ID,
        providerId: PROVIDER_ID,
        averageScore: score,
        responseCount: 7,
        missingScenarioIds: options.missingScenarioIds ?? [],
        dimensionScores: {},
        riskFlagCount: options.riskFlagCount ?? 0,
        rawPrivateText: options.rawPrivateText,
      },
    ],
    responseScores: [
      {
        response: options.rawPrivateText,
      },
    ],
  };
}

describe('buildCompanionShapeRegressionReport', () => {
  it('passes an unchanged baseline and surfaces required identity/refusal/emotional coverage domains', () => {
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport(),
      currentQaoReport: qaoReport(),
      baselineCompanionShapeReport: companionReport(),
      currentCompanionShapeReport: companionReport(),
      generatedAt: GENERATED_AT,
    });

    expect(report.summary.decision).toBe('pass');
    expect(report.findings).toEqual([]);
    expect(report.coverageDomains.map((domain) => domain.id)).toEqual(
      REGRESSION_REQUIRED_COVERAGE_DOMAINS.map((domain) => domain.id),
    );

    const markdown = renderCompanionShapeRegressionMarkdown(report);
    expect(markdown).toContain('Identity consistency');
    expect(markdown).toContain('Refusal boundary');
    expect(markdown).toContain('Emotional continuity');
  });

  it('warns on model score deltas above five percent without failing the CI decision', () => {
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport({ readinessScore: 3.8, aggregateScore: 3.7 }),
      currentQaoReport: qaoReport({ readinessScore: 3.4, aggregateScore: 3.7 }),
      baselineCompanionShapeReport: companionReport(92),
      currentCompanionShapeReport: companionReport(86),
      generatedAt: GENERATED_AT,
    });

    expect(report.summary.decision).toBe('pass');
    expect(report.summary.warningFindingCount).toBeGreaterThanOrEqual(2);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'model_score_regressed',
        metric: 'qao.readinessScore',
      }),
      expect.objectContaining({
        severity: 'warning',
        code: 'model_score_regressed',
        metric: 'companion_shape.averageScore',
      }),
    ]));
  });

  it('fails when current QAO blockers appear or a target decision regresses', () => {
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport(),
      currentQaoReport: qaoReport({
        decision: 'fail',
        readinessScore: 2.4,
        blockers: [qaoBlocker('upgrade_readiness_below_min')],
      }),
      generatedAt: GENERATED_AT,
    });

    expect(report.summary.decision).toBe('fail');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'blocker', code: 'qao_decision_regressed' }),
      expect.objectContaining({ severity: 'blocker', code: 'qao_blocker_added', qaoReasonCode: 'upgrade_readiness_below_min' }),
    ]));
  });

  it('flags missing coverage for QAO families, scenario ids, and required coverage domains', () => {
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport(),
      currentQaoReport: qaoReport({
        missingFamilies: ['replay_continuation'],
        missingScenarioIds: ['qao-replay-continuation-001'],
        missingAxes: ['voice_continuity'],
      }),
      generatedAt: GENERATED_AT,
    });

    expect(report.summary.decision).toBe('fail');
    expect(report.coverageDomains.find((domain) => domain.id === 'emotional_continuity')).toEqual(expect.objectContaining({
      status: 'missing',
    }));
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_scenario_family_added', scenarioFamily: 'replay_continuation' }),
      expect.objectContaining({ code: 'missing_scenario_added', scenarioId: 'qao-replay-continuation-001' }),
      expect.objectContaining({ code: 'coverage_domain_missing', coverageDomain: 'emotional_continuity' }),
    ]));
  });

  it('surfaces provider and judge failures without copying raw failure messages', () => {
    const rawPrivateText = 'RAW PRIVATE RESPONSE TEXT SHOULD NOT RENDER';
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport(),
      currentQaoReport: qaoReport({
        providerFailureCount: 1,
        judgeFailureCount: 1,
        rawPrivateText,
      }),
      generatedAt: GENERATED_AT,
    });

    expect(report.summary.decision).toBe('fail');
    expect(report.targetComparisons[0]).toEqual(expect.objectContaining({
      currentProviderFailureCount: 1,
      currentJudgeFailureCount: 1,
      currentProviderFailures: [
        expect.objectContaining({ scenarioId: 'provider-failed-1', kind: 'provider_error' }),
      ],
      currentJudgeFailures: [
        expect.objectContaining({ scenarioId: 'judge-failed-1', judgeId: 'judge-1', kind: 'malformed_judge_output' }),
      ],
    }));
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_failures_increased' }),
      expect.objectContaining({ code: 'judge_failures_increased' }),
    ]));
    expect(JSON.stringify(report)).not.toContain(rawPrivateText);
  });

  it('records added and resolved QAO blocker changes', () => {
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport({
        blockers: [qaoBlocker('low_confidence_exceeded', 'warning')],
      }),
      currentQaoReport: qaoReport({
        blockers: [qaoBlocker('disagreement_exceeded', 'warning')],
      }),
      generatedAt: GENERATED_AT,
    });

    expect(report.summary.decision).toBe('pass');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'qao_blocker_added', qaoReasonCode: 'disagreement_exceeded' }),
      expect.objectContaining({ severity: 'info', code: 'qao_blocker_resolved', qaoReasonCode: 'low_confidence_exceeded' }),
    ]));
  });

  it('renders privacy-safe Markdown and JSON without source raw response text or source blocker messages', () => {
    const rawPrivateText = 'RAW PRIVATE RESPONSE TEXT SHOULD NOT RENDER';
    const report = buildCompanionShapeRegressionReport({
      baselineQaoReport: qaoReport(),
      currentQaoReport: qaoReport({
        decision: 'fail',
        blockers: [qaoBlocker('axis_score_below_min', 'blocker', { message: rawPrivateText })],
        rawPrivateText,
      }),
      baselineCompanionShapeReport: companionReport(90, { rawPrivateText }),
      currentCompanionShapeReport: companionReport(84, { rawPrivateText }),
      generatedAt: GENERATED_AT,
    });

    const markdown = renderCompanionShapeRegressionMarkdown(report);
    expect(markdown).toContain('axis_score_below_min');
    expect(markdown).not.toContain(rawPrivateText);
    expect(JSON.stringify(report)).not.toContain(rawPrivateText);
  });
});

describe('runRegressionCli', () => {
  it('runs against default privacy-safe fixtures and writes Markdown plus JSON artifacts', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'psfn-regression-'));
    const markdownPath = path.join(tempDir, 'regression.md');
    const jsonPath = path.join(tempDir, 'regression.json');
    let stdout = '';

    try {
      const exitCode = runRegressionCli([
        '--output',
        markdownPath,
        '--json-output',
        jsonPath,
      ], {
        cwd: process.cwd(),
        stdout: {
          write(text: string): void {
            stdout += text;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('[eval:regression] blocker findings: 0');
      expect(readFileSync(markdownPath, 'utf8')).toContain('Companion Shape Regression Report');
      const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as { artifactType: string; summary: { decision: string } };
      expect(json.artifactType).toBe(COMPANION_SHAPE_REGRESSION_ARTIFACT_TYPE);
      expect(json.summary.decision).toBe('pass');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
