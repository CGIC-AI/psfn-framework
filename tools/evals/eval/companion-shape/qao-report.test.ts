import { describe, expect, it } from 'vitest';
import {
  QAO_JUDGE_AXES,
  QAO_JUDGE_RUBRIC,
  type QaoAxisRunSummary,
  type QaoExampleAxisAggregate,
  type QaoExampleJudgeResult,
  type QaoJudgeAxis,
  type QaoJudgeFailure,
  type QaoJudgeResult,
  type QaoJudgeRunArtifact,
} from './qao-judge.js';
import {
  QAO_REQUIRED_SCENARIO_FAMILIES,
  buildQaoUpgradeMatrixReport,
  renderQaoUpgradeMarkdown,
  type QaoUpgradeThresholds,
} from './qao-report.js';

type ScoreByAxis = Partial<Record<QaoJudgeAxis, number>>;
type ConfidenceByAxis = Partial<Record<QaoJudgeAxis, number>>;

interface ScoredExampleOptions {
  providerId?: string;
  modelId: string;
  scenarioId: string;
  scenarioFamily: string;
  response?: string;
  score?: number;
  confidence?: number;
  scoreByAxis?: ScoreByAxis;
  confidenceByAxis?: ConfidenceByAxis;
  secondJudgeScoreByAxis?: ScoreByAxis;
  secondJudgeConfidenceByAxis?: ConfidenceByAxis;
  judgeFailures?: QaoJudgeFailure[];
}

function scoredExample(options: ScoredExampleOptions): QaoExampleJudgeResult {
  const providerId = options.providerId ?? 'fixture';
  const judgeResults: QaoJudgeResult[] = [
    judgeResult('strict', options.score ?? 3.5, options.confidence ?? 0.9, options.scoreByAxis, options.confidenceByAxis),
  ];
  if (options.secondJudgeScoreByAxis !== undefined || options.secondJudgeConfidenceByAxis !== undefined) {
    judgeResults.push(judgeResult(
      'continuity',
      options.score ?? 3.5,
      options.confidence ?? 0.9,
      options.secondJudgeScoreByAxis,
      options.secondJudgeConfidenceByAxis,
    ));
  }

  const judgeFailures = options.judgeFailures ?? [];
  return {
    example: {
      id: `${options.scenarioId}::${providerId}::${options.modelId}`,
      scenarioId: options.scenarioId,
      providerId,
      modelId: options.modelId,
      response: options.response ?? 'fixture response',
      status: 'ok',
      scenarioFamily: options.scenarioFamily,
      scenarioRubricAxes: ['fixture rubric axis'],
      requiredPolicyGates: [],
      calibrationAnchors: [],
    },
    status: judgeFailures.length > 0 ? 'partial_judge_failure' : 'scored',
    judgeResults,
    judgeFailures,
  };
}

function providerFailedExample(options: {
  providerId?: string;
  modelId: string;
  scenarioId: string;
  scenarioFamily: string;
  kind?: string;
  message?: string;
}): QaoExampleJudgeResult {
  const providerId = options.providerId ?? 'fixture';
  return {
    example: {
      id: `${options.scenarioId}::${providerId}::${options.modelId}`,
      scenarioId: options.scenarioId,
      providerId,
      modelId: options.modelId,
      status: 'failed',
      scenarioFamily: options.scenarioFamily,
      scenarioRubricAxes: ['fixture rubric axis'],
      requiredPolicyGates: [],
      calibrationAnchors: [],
      failure: {
        kind: options.kind ?? 'provider_error',
        message: options.message ?? 'provider failed',
      },
    },
    status: 'response_failed',
    judgeResults: [],
    judgeFailures: [],
  };
}

function judgeResult(
  id: string,
  defaultScore: number,
  defaultConfidence: number,
  scoreByAxis: ScoreByAxis = {},
  confidenceByAxis: ConfidenceByAxis = {},
): QaoJudgeResult {
  return {
    status: 'ok',
    judge: {
      id,
      providerId: 'fixture',
      modelId: `${id}-judge`,
    },
    rubric: {
      version: QAO_JUDGE_RUBRIC.version,
      scoreScale: QAO_JUDGE_RUBRIC.scoreScale,
      confidenceScale: QAO_JUDGE_RUBRIC.confidenceScale,
    },
    axisScores: QAO_JUDGE_AXES.map((axis) => ({
      axis,
      score: scoreByAxis[axis] ?? defaultScore,
      confidence: confidenceByAxis[axis] ?? defaultConfidence,
      rationaleSummary: `${axis} fixture rationale`,
      rubricVersion: QAO_JUDGE_RUBRIC.version,
    })),
  };
}

function malformedJudgeFailure(id = 'malformed'): QaoJudgeFailure {
  return {
    status: 'failed',
    judge: {
      id,
      providerId: 'fixture',
      modelId: `${id}-judge`,
    },
    failure: {
      kind: 'malformed_judge_output',
      message: 'missing axis "voice_continuity"',
    },
  };
}

function judgeArtifact(examples: QaoExampleJudgeResult[], runId = 'judge-run'): QaoJudgeRunArtifact {
  const byExampleAxis = examples.flatMap(aggregateExampleAxes);
  return {
    schemaVersion: 1,
    artifactType: 'psfn.qao_judge_council_run',
    run: {
      id: runId,
      scoredAt: '2026-06-20T00:00:00.000Z',
      sourceRunId: 'collection-run',
    },
    source: {
      artifactType: 'psfn.qao_response_collection_run',
      exampleCount: examples.length,
    },
    council: {
      id: 'fixture-council',
      judges: [
        { id: 'strict', providerId: 'fixture', modelId: 'strict-judge' },
        { id: 'continuity', providerId: 'fixture', modelId: 'continuity-judge' },
        { id: 'malformed', providerId: 'fixture', modelId: 'malformed-judge' },
      ],
    },
    rubric: QAO_JUDGE_RUBRIC,
    examples,
    aggregates: {
      byExampleAxis,
      byAxis: aggregateByAxis(byExampleAxis),
    },
    summary: {
      exampleCount: examples.length,
      responseFailureCount: examples.filter((example) => example.status === 'response_failed').length,
      judgedExampleCount: examples.filter((example) => example.status !== 'response_failed').length,
      judgeResultCount: examples.reduce((total, example) => total + example.judgeResults.length, 0),
      judgeFailureCount: examples.reduce((total, example) => total + example.judgeFailures.length, 0),
      malformedJudgeOutputCount: examples.reduce(
        (total, example) =>
          total + example.judgeFailures.filter((failure) => failure.failure.kind === 'malformed_judge_output').length,
        0,
      ),
      disagreementFindingCount: byExampleAxis.filter((aggregate) => aggregate.disagreement).length,
      lowConfidenceFindingCount: byExampleAxis.filter((aggregate) => aggregate.lowConfidenceJudgeIds.length > 0).length,
    },
  };
}

function aggregateExampleAxes(example: QaoExampleJudgeResult): QaoExampleAxisAggregate[] {
  if (example.status === 'response_failed') return [];
  return QAO_JUDGE_AXES.map((axis) => {
    const judgeScores = example.judgeResults.map((result) => {
      const score = result.axisScores.find((axisScore) => axisScore.axis === axis);
      if (!score) throw new Error(`missing axis ${axis}`);
      return {
        judgeId: result.judge.id,
        score: score.score,
        confidence: score.confidence,
      };
    });
    const scores = judgeScores.map((score) => score.score);
    const confidences = judgeScores.map((score) => score.confidence);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    return {
      exampleId: example.example.id,
      scenarioId: example.example.scenarioId,
      providerId: example.example.providerId,
      modelId: example.example.modelId,
      axis,
      judgeCount: judgeScores.length,
      meanScore: roundTwo(scores.reduce((total, score) => total + score, 0) / scores.length),
      minScore,
      maxScore,
      scoreSpread: maxScore - minScore,
      meanConfidence: roundTwo(confidences.reduce((total, confidence) => total + confidence, 0) / confidences.length),
      disagreement: maxScore - minScore >= 2,
      lowConfidenceJudgeIds: judgeScores.filter((score) => score.confidence < 0.65).map((score) => score.judgeId),
      judgeScores,
    };
  });
}

function aggregateByAxis(byExampleAxis: QaoExampleAxisAggregate[]): QaoAxisRunSummary[] {
  return QAO_JUDGE_AXES.map((axis) => {
    const entries = byExampleAxis.filter((entry) => entry.axis === axis);
    return {
      axis,
      judgedExampleCount: entries.length,
      meanScore: entries.length === 0 ? null : roundTwo(entries.reduce((total, entry) => total + entry.meanScore, 0) / entries.length),
      meanConfidence: entries.length === 0
        ? null
        : roundTwo(entries.reduce((total, entry) => total + entry.meanConfidence, 0) / entries.length),
      disagreementCount: entries.filter((entry) => entry.disagreement).length,
      lowConfidenceCount: entries.filter((entry) => entry.lowConfidenceJudgeIds.length > 0).length,
    };
  });
}

function completeExamples(modelId: string, score = 3.6, scoreByAxis: ScoreByAxis = {}): QaoExampleJudgeResult[] {
  return QAO_REQUIRED_SCENARIO_FAMILIES.map((family) =>
    scoredExample({
      modelId,
      scenarioId: `scenario-${family}`,
      scenarioFamily: family,
      score,
      scoreByAxis,
    }),
  );
}

function collectionArtifact(options: {
  targetModels: string[];
  scenarioFamilies?: readonly string[];
  failedScenarioIds?: readonly string[];
}): unknown {
  const scenarioFamilies = options.scenarioFamilies ?? QAO_REQUIRED_SCENARIO_FAMILIES;
  const scenarios = scenarioFamilies.map((family) => ({
    id: `scenario-${family}`,
    title: `Scenario ${family}`,
    family,
  }));
  const failedScenarioIds = new Set(options.failedScenarioIds ?? []);
  return {
    schemaVersion: 1,
    artifactType: 'psfn.qao_response_collection_run',
    run: {
      id: 'collection-run',
      capturedAt: '2026-06-20T00:00:00.000Z',
    },
    targets: options.targetModels.map((modelId) => ({
      providerId: 'fixture',
      modelId,
      secretSources: [],
    })),
    scenarios,
    scenarioResults: options.targetModels.flatMap((modelId) =>
      scenarios.map((scenario) => ({
        scenarioId: scenario.id,
        providerId: 'fixture',
        modelId,
        status: failedScenarioIds.has(scenario.id) ? 'failed' : 'ok',
        ...(failedScenarioIds.has(scenario.id)
          ? { failure: { kind: 'provider_error', message: 'fixture provider failure' } }
          : {}),
      })),
    ),
  };
}

function thresholdOverrides(overrides: Partial<QaoUpgradeThresholds>): Partial<QaoUpgradeThresholds> {
  return overrides;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('buildQaoUpgradeMatrixReport', () => {
  it('aggregates a complete passing target with coverage, axis summaries, judges, and default advanced evidence absence', () => {
    const report = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [judgeArtifact(completeExamples('candidate-a', 3.6, { upgrade_readiness: 3.8 }))],
      collectionArtifact: collectionArtifact({ targetModels: ['candidate-a'] }),
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    expect(report).toEqual(expect.objectContaining({
      schemaVersion: 1,
      artifactType: 'psfn.qao_upgrade_matrix_report',
      generatedAt: '2026-06-20T00:00:00.000Z',
    }));
    expect(report.metadata).toEqual(expect.objectContaining({
      thresholdVersion: 'qao-upgrade-thresholds-v1',
      modelTargetKeys: ['fixture:candidate-a'],
    }));
    expect(report.judgeSummary).toEqual(expect.objectContaining({
      councilIds: ['fixture-council'],
      judgeResultCount: QAO_REQUIRED_SCENARIO_FAMILIES.length,
      judgeFailureCount: 0,
    }));
    expect(report.advancedEvidence.map((evidence) => [evidence.kind, evidence.status, evidence.requiredForPromotion])).toEqual([
      ['logprobs', 'not_run', false],
      ['calibration_tables', 'not_run', false],
      ['hidden_states', 'not_run', false],
      ['activation_repeng_layers', 'not_run', false],
    ]);
    expect(report.targets[0]).toEqual(expect.objectContaining({
      targetKey: 'fixture:candidate-a',
      decision: 'pass',
      readinessScore: 3.8,
      aggregateScore: expect.any(Number),
      providerFailureCount: 0,
      judgeFailureCount: 0,
      blockers: [],
    }));
    expect(report.targets[0].scenarioCoverage.missingScenarioFamilies).toEqual([]);
    expect(report.targets[0].scenarioCoverage.missingScenarioIds).toEqual([]);
    expect(report.targets[0].axisSummaries.find((axis) => axis.axis === 'tool_truthfulness')).toEqual(expect.objectContaining({
      judgedExampleCount: QAO_REQUIRED_SCENARIO_FAMILIES.length,
      meanScore: 3.6,
      status: 'pass',
    }));
  });

  it('applies score thresholds, preserves fail reasons, and ranks by readiness then aggregate score', () => {
    const report = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [
        judgeArtifact([
          ...completeExamples('candidate-a', 3.4, { upgrade_readiness: 3.7 }),
          ...completeExamples('candidate-b', 3.4, {
            boundary_handling: 2.4,
            upgrade_readiness: 2.2,
          }),
        ]),
      ],
      collectionArtifact: collectionArtifact({ targetModels: ['candidate-a', 'candidate-b'] }),
    });

    expect(report.targets.map((target) => target.targetKey)).toEqual(['fixture:candidate-a', 'fixture:candidate-b']);
    expect(report.targets[0].decision).toBe('pass');
    const failing = report.targets[1];
    expect(failing.decision).toBe('fail');
    expect(failing.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasonCode: 'axis_score_below_min',
        axis: 'boundary_handling',
      }),
      expect.objectContaining({
        reasonCode: 'upgrade_readiness_below_min',
        axis: 'upgrade_readiness',
      }),
    ]));
  });

  it('flags missing required scenario family and scenario-id coverage from the collection artifact', () => {
    const report = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [
        judgeArtifact([
          scoredExample({
            modelId: 'candidate-a',
            scenarioId: 'scenario-tool_truthfulness',
            scenarioFamily: 'tool_truthfulness',
            score: 3.5,
            scoreByAxis: {
              upgrade_readiness: 3.5,
            },
          }),
        ]),
      ],
      collectionArtifact: collectionArtifact({
        targetModels: ['candidate-a'],
        scenarioFamilies: ['tool_truthfulness', 'memory_grounded_responses'],
      }),
      thresholds: thresholdOverrides({
        requiredScenarioFamilies: ['tool_truthfulness', 'memory_grounded_responses'],
        requiredAxes: ['tool_truthfulness'],
      }),
    });

    const target = report.targets[0];
    expect(target.scenarioCoverage.missingScenarioFamilies).toEqual(['memory_grounded_responses']);
    expect(target.scenarioCoverage.missingScenarioIds).toEqual(['scenario-memory_grounded_responses']);
    expect(target.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasonCode: 'missing_scenario_family',
        scenarioFamily: 'memory_grounded_responses',
      }),
      expect.objectContaining({
        reasonCode: 'missing_scenario',
        scenarioId: 'scenario-memory_grounded_responses',
      }),
    ]));
  });

  it('keeps provider failures and judge failures visible without dropping partial judge coverage', () => {
    const report = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [
        judgeArtifact([
          scoredExample({
            modelId: 'candidate-a',
            scenarioId: 'scenario-tool_truthfulness',
            scenarioFamily: 'tool_truthfulness',
            score: 3.5,
            scoreByAxis: { upgrade_readiness: 3.5 },
            judgeFailures: [malformedJudgeFailure()],
          }),
          providerFailedExample({
            modelId: 'candidate-a',
            scenarioId: 'scenario-boundary_refusal_style',
            scenarioFamily: 'boundary_refusal_style',
          }),
        ]),
      ],
      collectionArtifact: collectionArtifact({
        targetModels: ['candidate-a'],
        scenarioFamilies: ['tool_truthfulness', 'boundary_refusal_style'],
        failedScenarioIds: ['scenario-boundary_refusal_style'],
      }),
      thresholds: thresholdOverrides({
        requiredScenarioFamilies: ['tool_truthfulness', 'boundary_refusal_style'],
        requiredAxes: ['tool_truthfulness'],
      }),
    });

    const target = report.targets[0];
    expect(target.providerFailureCount).toBe(1);
    expect(target.providerFailures).toEqual([
      expect.objectContaining({
        scenarioId: 'scenario-boundary_refusal_style',
        kind: 'provider_error',
      }),
    ]);
    expect(target.judgeFailureCount).toBe(1);
    expect(target.malformedJudgeOutputCount).toBe(1);
    expect(target.judgeFailures).toEqual([
      expect.objectContaining({
        scenarioId: 'scenario-tool_truthfulness',
        judgeId: 'malformed',
        kind: 'malformed_judge_output',
      }),
    ]);
    expect(target.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'provider_failures_exceeded' }),
      expect.objectContaining({ reasonCode: 'judge_failures_exceeded' }),
    ]));
  });

  it('thresholds disagreement and low-confidence findings by rate and count', () => {
    const report = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [
        judgeArtifact([
          scoredExample({
            modelId: 'candidate-a',
            scenarioId: 'scenario-tool_truthfulness',
            scenarioFamily: 'tool_truthfulness',
            scoreByAxis: Object.fromEntries(QAO_JUDGE_AXES.map((axis) => [axis, 1])) as ScoreByAxis,
            confidenceByAxis: Object.fromEntries(QAO_JUDGE_AXES.map((axis) => [axis, 0.5])) as ConfidenceByAxis,
            secondJudgeScoreByAxis: Object.fromEntries(QAO_JUDGE_AXES.map((axis) => [axis, 4])) as ScoreByAxis,
            secondJudgeConfidenceByAxis: Object.fromEntries(QAO_JUDGE_AXES.map((axis) => [axis, 0.95])) as ConfidenceByAxis,
          }),
        ]),
      ],
      thresholds: thresholdOverrides({
        minAxisScore: 0,
        minUpgradeReadinessScore: 0,
        maxDisagreementFindingRate: 0,
        maxDisagreementFindingCount: 0,
        maxLowConfidenceFindingRate: 0,
        maxLowConfidenceFindingCount: 0,
        requiredScenarioFamilies: [],
        requiredAxes: [],
      }),
    });

    const target = report.targets[0];
    expect(target.disagreementFindingCount).toBe(QAO_JUDGE_AXES.length);
    expect(target.disagreementFindingRate).toBe(1);
    expect(target.lowConfidenceFindingCount).toBe(QAO_JUDGE_AXES.length);
    expect(target.lowConfidenceFindingRate).toBe(1);
    expect(target.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'disagreement_exceeded', observed: 1 }),
      expect.objectContaining({ reasonCode: 'disagreement_exceeded', observed: QAO_JUDGE_AXES.length }),
      expect.objectContaining({ reasonCode: 'low_confidence_exceeded', observed: 1 }),
      expect.objectContaining({ reasonCode: 'low_confidence_exceeded', observed: QAO_JUDGE_AXES.length }),
    ]));
  });

  it('surfaces absent advanced evidence as not run and only blocks when a threshold requires it', () => {
    const passingByDefault = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [judgeArtifact(completeExamples('candidate-a', 3.6, { upgrade_readiness: 3.8 }))],
      collectionArtifact: collectionArtifact({ targetModels: ['candidate-a'] }),
    });
    expect(passingByDefault.advancedEvidence.find((evidence) => evidence.kind === 'logprobs')).toEqual(expect.objectContaining({
      status: 'not_run',
      requiredForPromotion: false,
    }));
    expect(passingByDefault.targets[0].decision).toBe('pass');

    const required = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [judgeArtifact(completeExamples('candidate-a', 3.6, { upgrade_readiness: 3.8 }))],
      collectionArtifact: collectionArtifact({ targetModels: ['candidate-a'] }),
      thresholds: thresholdOverrides({
        requiredAdvancedEvidence: ['logprobs'],
      }),
    });
    expect(required.advancedEvidence.find((evidence) => evidence.kind === 'logprobs')).toEqual(expect.objectContaining({
      status: 'not_run',
      requiredForPromotion: true,
    }));
    expect(required.targets[0].decision).toBe('fail');
    expect(required.targets[0].blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasonCode: 'advanced_evidence_absent',
        evidenceKind: 'logprobs',
      }),
    ]));
  });

  it('renders privacy-safe Markdown without raw response text, private corpus text, or judge rationale summaries', () => {
    const report = buildQaoUpgradeMatrixReport({
      judgeArtifacts: [
        judgeArtifact([
          scoredExample({
            modelId: 'candidate-a',
            scenarioId: 'scenario-tool_truthfulness',
            scenarioFamily: 'tool_truthfulness',
            response: 'RAW PRIVATE RESPONSE TEXT SHOULD NOT RENDER',
            score: 3.5,
            scoreByAxis: { upgrade_readiness: 3.5 },
          }),
        ]),
      ],
      thresholds: thresholdOverrides({
        requiredScenarioFamilies: ['tool_truthfulness'],
        requiredAxes: ['tool_truthfulness'],
      }),
    });

    const markdown = renderQaoUpgradeMarkdown(report);
    expect(markdown).toContain('fixture:candidate-a');
    expect(markdown).toContain('tool_truthfulness');
    expect(markdown).not.toContain('RAW PRIVATE RESPONSE TEXT SHOULD NOT RENDER');
    expect(markdown).not.toContain('fixture rationale');
  });
});
