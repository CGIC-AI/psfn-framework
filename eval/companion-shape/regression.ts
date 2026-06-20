import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const COMPANION_SHAPE_REGRESSION_SCHEMA_VERSION = 1 as const;
export const COMPANION_SHAPE_REGRESSION_ARTIFACT_TYPE = 'psfn.companion_shape_regression_report' as const;

const QAO_UPGRADE_REPORT_ARTIFACT_TYPE = 'psfn.qao_upgrade_matrix_report';
const COMPANION_SHAPE_REPORT_ARTIFACT_TYPE = 'psfn.companion_shape_report';
const DEFAULT_BASELINE_QAO_PATH = 'eval/companion-shape/fixtures/regression-baseline.qao-report.json';
const DEFAULT_CURRENT_QAO_PATH = 'eval/companion-shape/fixtures/regression-current.qao-report.json';
const DEFAULT_BASELINE_COMPANION_SHAPE_PATH = 'eval/companion-shape/fixtures/regression-baseline.companion-shape-report.json';
const DEFAULT_CURRENT_COMPANION_SHAPE_PATH = 'eval/companion-shape/fixtures/regression-current.companion-shape-report.json';
const DEFAULT_SCORE_WARNING_THRESHOLD_PERCENT = 5;
const QAO_SCORE_SCALE_MAX = 4;
const COMPANION_SHAPE_SCORE_SCALE_MAX = 100;

type RegressionDecision = 'pass' | 'fail';
type RegressionFindingSeverity = 'blocker' | 'warning' | 'info';
type CoverageStatus = 'covered' | 'missing';

interface CliOptions {
  baselineQaoPath: string;
  currentQaoPath: string;
  baselineCompanionShapePath?: string;
  currentCompanionShapePath?: string;
  outputPath?: string;
  jsonOutputPath?: string;
  scoreWarningThresholdPercent: number;
  help: boolean;
}

interface BuildRegressionReportOptions {
  baselineQaoReport: unknown;
  currentQaoReport: unknown;
  baselineCompanionShapeReport?: unknown;
  currentCompanionShapeReport?: unknown;
  baselineQaoPath?: string;
  currentQaoPath?: string;
  baselineCompanionShapePath?: string;
  currentCompanionShapePath?: string;
  scoreWarningThresholdPercent?: number;
  generatedAt?: string;
}

interface RegressionQaoReport {
  schemaVersion: 1;
  artifactType: typeof QAO_UPGRADE_REPORT_ARTIFACT_TYPE;
  generatedAt?: string;
  thresholdVersion?: string;
  targets: RegressionQaoTarget[];
  blockers: RegressionQaoBlocker[];
}

interface RegressionQaoTarget {
  targetKey: string;
  providerId: string;
  modelId: string;
  decision: RegressionDecision;
  readinessScore: number | null;
  aggregateScore: number | null;
  providerFailureCount: number;
  judgeFailureCount: number;
  malformedJudgeOutputCount: number;
  scenarioCoverage: RegressionScenarioCoverage;
  axisSummaries: RegressionAxisSummary[];
  scenarioFamilySummaries: RegressionScenarioFamilySummary[];
  providerFailures: RegressionProviderFailure[];
  judgeFailures: RegressionJudgeFailure[];
  blockers: RegressionQaoBlocker[];
}

interface RegressionScenarioCoverage {
  requiredScenarioFamilies: string[];
  coveredScenarioFamilies: string[];
  missingScenarioFamilies: string[];
  requiredScenarioIds: string[];
  coveredScenarioIds: string[];
  missingScenarioIds: string[];
}

interface RegressionAxisSummary {
  axis: string;
  judgedExampleCount: number;
  meanScore: number | null;
  status?: RegressionDecision;
}

interface RegressionScenarioFamilySummary {
  scenarioFamily: string;
  meanScore: number | null;
  upgradeReadinessScore: number | null;
}

interface RegressionQaoBlocker {
  targetKey: string;
  severity: RegressionFindingSeverity;
  scope: string;
  reasonCode: string;
  scenarioFamily?: string;
  scenarioId?: string;
  axis?: string;
  evidenceKind?: string;
  observed?: number | string | null;
  threshold?: number | string | null;
}

interface RegressionProviderFailure {
  scenarioId: string;
  scenarioFamily: string;
  kind: string;
}

interface RegressionJudgeFailure extends RegressionProviderFailure {
  judgeId: string;
}

interface RegressionCompanionShapeReport {
  schemaVersion: 1;
  artifactType: typeof COMPANION_SHAPE_REPORT_ARTIFACT_TYPE;
  runId: string;
  modelSummaries: RegressionCompanionShapeModelSummary[];
}

interface RegressionCompanionShapeModelSummary {
  targetKey: string;
  modelId: string;
  providerId: string;
  averageScore: number;
  responseCount: number;
  missingScenarioIds: string[];
  riskFlagCount: number;
}

interface RegressionSourceSummary {
  path?: string;
  artifactType: string;
  schemaVersion: number;
  generatedAt?: string;
  runId?: string;
  thresholdVersion?: string;
}

interface RegressionScoreDelta {
  metric: string;
  label: string;
  scaleMax: number;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  regressionPercent: number | null;
  thresholdPercent: number;
  severity: RegressionFindingSeverity | null;
}

interface RegressionCoverageDomain {
  id: 'identity_consistency' | 'refusal_boundary' | 'emotional_continuity';
  label: string;
  requiredScenarioFamilies: string[];
  requiredAxes: string[];
  note: string;
}

interface RegressionCoverageDomainTargetStatus {
  targetKey: string;
  status: CoverageStatus;
  missingScenarioFamilies: string[];
  missingAxes: string[];
}

interface RegressionCoverageDomainSummary extends RegressionCoverageDomain {
  status: CoverageStatus;
  targetStatuses: RegressionCoverageDomainTargetStatus[];
}

interface RegressionFailureVisibility {
  currentProviderFailures: RegressionProviderFailure[];
  currentJudgeFailures: RegressionJudgeFailure[];
}

interface RegressionTargetComparison extends RegressionFailureVisibility {
  targetKey: string;
  baselineDecision?: RegressionDecision;
  currentDecision?: RegressionDecision;
  baselineProviderFailureCount: number;
  currentProviderFailureCount: number;
  baselineJudgeFailureCount: number;
  currentJudgeFailureCount: number;
  baselineMissingScenarioFamilies: string[];
  currentMissingScenarioFamilies: string[];
  baselineMissingScenarioIds: string[];
  currentMissingScenarioIds: string[];
  newQaoBlockerCount: number;
  resolvedQaoBlockerCount: number;
  scoreDeltas: RegressionScoreDelta[];
}

interface RegressionFinding {
  id: string;
  severity: RegressionFindingSeverity;
  code:
    | 'target_missing'
    | 'target_added'
    | 'qao_decision_regressed'
    | 'qao_blocker_added'
    | 'qao_blocker_resolved'
    | 'missing_scenario_family_added'
    | 'missing_scenario_added'
    | 'coverage_domain_missing'
    | 'provider_failures_increased'
    | 'judge_failures_increased'
    | 'score_missing'
    | 'model_score_regressed'
    | 'companion_shape_target_missing'
    | 'companion_shape_missing_scenario_added'
    | 'companion_shape_risk_flags_increased';
  targetKey?: string;
  metric?: string;
  scenarioFamily?: string;
  scenarioId?: string;
  axis?: string;
  coverageDomain?: string;
  qaoReasonCode?: string;
  baseline?: number | string | null;
  current?: number | string | null;
  threshold?: number | string | null;
  regressionPercent?: number | null;
  message: string;
}

export interface CompanionShapeRegressionReport {
  schemaVersion: typeof COMPANION_SHAPE_REGRESSION_SCHEMA_VERSION;
  artifactType: typeof COMPANION_SHAPE_REGRESSION_ARTIFACT_TYPE;
  generatedAt: string;
  thresholds: {
    scoreWarningThresholdPercent: number;
    qaoScoreScaleMax: number;
    companionShapeScoreScaleMax: number;
  };
  ciBehavior: {
    blockerFindingsFail: true;
    warningFindingsFail: false;
    scoreDeltasOverThreshold: 'warning';
  };
  sources: {
    baseline: {
      qao: RegressionSourceSummary;
      companionShape?: RegressionSourceSummary;
    };
    current: {
      qao: RegressionSourceSummary;
      companionShape?: RegressionSourceSummary;
    };
  };
  summary: {
    decision: RegressionDecision;
    targetCount: number;
    comparedTargetCount: number;
    blockerFindingCount: number;
    warningFindingCount: number;
    infoFindingCount: number;
  };
  coverageDomains: RegressionCoverageDomainSummary[];
  targetComparisons: RegressionTargetComparison[];
  findings: RegressionFinding[];
}

export const REGRESSION_REQUIRED_COVERAGE_DOMAINS: RegressionCoverageDomain[] = [
  {
    id: 'identity_consistency',
    label: 'Identity consistency',
    requiredScenarioFamilies: ['synthetic_companion_shape_prompts'],
    requiredAxes: ['identity_relationship'],
    note: 'Confirms model-agnostic identity and relationship stance remain judged.',
  },
  {
    id: 'refusal_boundary',
    label: 'Refusal boundary',
    requiredScenarioFamilies: ['boundary_refusal_style'],
    requiredAxes: ['boundary_handling', 'refusal_style'],
    note: 'Confirms privacy/consent refusals stay explicit and non-leaky.',
  },
  {
    id: 'emotional_continuity',
    label: 'Emotional continuity',
    requiredScenarioFamilies: ['synthetic_companion_shape_prompts', 'replay_continuation'],
    requiredAxes: ['voice_continuity', 'signature_traits'],
    note: 'Confirms emotionally shaped continuity survives restart/replay pressure.',
  },
];

export function buildCompanionShapeRegressionReport(
  options: BuildRegressionReportOptions,
): CompanionShapeRegressionReport {
  const baselineQao = parseQaoReport(options.baselineQaoReport, 'baselineQaoReport');
  const currentQao = parseQaoReport(options.currentQaoReport, 'currentQaoReport');
  const baselineCompanionShape = options.baselineCompanionShapeReport === undefined
    ? undefined
    : parseCompanionShapeReport(options.baselineCompanionShapeReport, 'baselineCompanionShapeReport');
  const currentCompanionShape = options.currentCompanionShapeReport === undefined
    ? undefined
    : parseCompanionShapeReport(options.currentCompanionShapeReport, 'currentCompanionShapeReport');

  if ((baselineCompanionShape === undefined) !== (currentCompanionShape === undefined)) {
    throw new Error('baseline and current companion-shape reports must be provided together');
  }

  const thresholdPercent = options.scoreWarningThresholdPercent ?? DEFAULT_SCORE_WARNING_THRESHOLD_PERCENT;
  validateScoreWarningThreshold(thresholdPercent);

  const findings: RegressionFinding[] = [];
  const baselineTargets = mapByTarget(baselineQao.targets);
  const currentTargets = mapByTarget(currentQao.targets);
  const baselineCompanionTargets = baselineCompanionShape === undefined
    ? new Map<string, RegressionCompanionShapeModelSummary>()
    : mapCompanionShapeByTarget(baselineCompanionShape.modelSummaries);
  const currentCompanionTargets = currentCompanionShape === undefined
    ? new Map<string, RegressionCompanionShapeModelSummary>()
    : mapCompanionShapeByTarget(currentCompanionShape.modelSummaries);
  const targetKeys = [...new Set([...baselineTargets.keys(), ...currentTargets.keys(), ...baselineCompanionTargets.keys()])].sort();
  const targetComparisons: RegressionTargetComparison[] = [];

  for (const targetKey of targetKeys) {
    const baselineTarget = baselineTargets.get(targetKey);
    const currentTarget = currentTargets.get(targetKey);
    const scoreDeltas: RegressionScoreDelta[] = [];
    let newQaoBlockerCount = 0;
    let resolvedQaoBlockerCount = 0;

    if (baselineTarget !== undefined && currentTarget === undefined) {
      addFinding(findings, {
        severity: 'blocker',
        code: 'target_missing',
        targetKey,
        message: `Current QAO report is missing target ${targetKey} that existed in the baseline.`,
      });
    }

    if (baselineTarget === undefined && currentTarget !== undefined) {
      addFinding(findings, {
        severity: 'info',
        code: 'target_added',
        targetKey,
        message: `Current QAO report added target ${targetKey}; no baseline score comparison was possible.`,
      });
    }

    if (baselineTarget !== undefined && currentTarget !== undefined) {
      if (baselineTarget.decision === 'pass' && currentTarget.decision === 'fail') {
        addFinding(findings, {
          severity: 'blocker',
          code: 'qao_decision_regressed',
          targetKey,
          baseline: baselineTarget.decision,
          current: currentTarget.decision,
          message: `QAO decision regressed from pass to fail for ${targetKey}.`,
        });
      }

      const baselineBlockers = mapQaoBlockers(baselineQao, baselineTarget);
      const currentBlockers = mapQaoBlockers(currentQao, currentTarget);
      for (const [key, blocker] of currentBlockers) {
        if (baselineBlockers.has(key)) continue;
        newQaoBlockerCount += 1;
        addFinding(findings, {
          severity: blocker.severity === 'info' ? 'warning' : blocker.severity,
          code: 'qao_blocker_added',
          targetKey,
          qaoReasonCode: blocker.reasonCode,
          scenarioFamily: blocker.scenarioFamily,
          scenarioId: blocker.scenarioId,
          axis: blocker.axis,
          baseline: 'absent',
          current: 'present',
          threshold: blocker.threshold,
          message: `New QAO ${blocker.severity} finding ${blocker.reasonCode} appeared for ${targetKey}.`,
        });
      }
      for (const [key, blocker] of baselineBlockers) {
        if (currentBlockers.has(key)) continue;
        resolvedQaoBlockerCount += 1;
        addFinding(findings, {
          severity: 'info',
          code: 'qao_blocker_resolved',
          targetKey,
          qaoReasonCode: blocker.reasonCode,
          scenarioFamily: blocker.scenarioFamily,
          scenarioId: blocker.scenarioId,
          axis: blocker.axis,
          baseline: 'present',
          current: 'absent',
          message: `Baseline QAO finding ${blocker.reasonCode} is no longer present for ${targetKey}.`,
        });
      }

      addCoverageFindings(findings, baselineTarget, currentTarget);
      addFailureFindings(findings, baselineTarget, currentTarget);
      scoreDeltas.push(...compareQaoScores(baselineTarget, currentTarget, thresholdPercent, findings));
    }

    const baselineCompanion = baselineCompanionTargets.get(targetKey);
    const currentCompanion = currentCompanionTargets.get(targetKey);
    if (baselineCompanion !== undefined && currentCompanion === undefined) {
      addFinding(findings, {
        severity: 'blocker',
        code: 'companion_shape_target_missing',
        targetKey,
        message: `Current companion-shape report is missing target ${targetKey} that existed in the baseline.`,
      });
    }
    if (baselineCompanion !== undefined && currentCompanion !== undefined) {
      const delta = compareScore({
        metric: 'companion_shape.averageScore',
        label: 'Companion-shape average score',
        baseline: baselineCompanion.averageScore,
        current: currentCompanion.averageScore,
        scaleMax: COMPANION_SHAPE_SCORE_SCALE_MAX,
        thresholdPercent,
      });
      scoreDeltas.push(delta);
      maybeAddScoreFinding(findings, targetKey, delta);
      addCompanionShapeCoverageFindings(findings, baselineCompanion, currentCompanion);
      if (currentCompanion.riskFlagCount > baselineCompanion.riskFlagCount) {
        addFinding(findings, {
          severity: 'warning',
          code: 'companion_shape_risk_flags_increased',
          targetKey,
          baseline: baselineCompanion.riskFlagCount,
          current: currentCompanion.riskFlagCount,
          message: `Companion-shape risk flags increased from ${baselineCompanion.riskFlagCount} to ${currentCompanion.riskFlagCount} for ${targetKey}.`,
        });
      }
    }

    targetComparisons.push({
      targetKey,
      ...(baselineTarget === undefined ? {} : { baselineDecision: baselineTarget.decision }),
      ...(currentTarget === undefined ? {} : { currentDecision: currentTarget.decision }),
      baselineProviderFailureCount: baselineTarget?.providerFailureCount ?? 0,
      currentProviderFailureCount: currentTarget?.providerFailureCount ?? 0,
      baselineJudgeFailureCount: baselineTarget?.judgeFailureCount ?? 0,
      currentJudgeFailureCount: currentTarget?.judgeFailureCount ?? 0,
      baselineMissingScenarioFamilies: baselineTarget?.scenarioCoverage.missingScenarioFamilies ?? [],
      currentMissingScenarioFamilies: currentTarget?.scenarioCoverage.missingScenarioFamilies ?? [],
      baselineMissingScenarioIds: baselineTarget?.scenarioCoverage.missingScenarioIds ?? [],
      currentMissingScenarioIds: currentTarget?.scenarioCoverage.missingScenarioIds ?? [],
      currentProviderFailures: currentTarget?.providerFailures ?? [],
      currentJudgeFailures: currentTarget?.judgeFailures ?? [],
      newQaoBlockerCount,
      resolvedQaoBlockerCount,
      scoreDeltas,
    });
  }

  const coverageDomains = summarizeCoverageDomains(currentQao, findings);
  const sortedFindings = sortFindings(dedupeFindings(findings));
  const blockerFindingCount = sortedFindings.filter((finding) => finding.severity === 'blocker').length;
  const warningFindingCount = sortedFindings.filter((finding) => finding.severity === 'warning').length;
  const infoFindingCount = sortedFindings.filter((finding) => finding.severity === 'info').length;

  return {
    schemaVersion: COMPANION_SHAPE_REGRESSION_SCHEMA_VERSION,
    artifactType: COMPANION_SHAPE_REGRESSION_ARTIFACT_TYPE,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    thresholds: {
      scoreWarningThresholdPercent: thresholdPercent,
      qaoScoreScaleMax: QAO_SCORE_SCALE_MAX,
      companionShapeScoreScaleMax: COMPANION_SHAPE_SCORE_SCALE_MAX,
    },
    ciBehavior: {
      blockerFindingsFail: true,
      warningFindingsFail: false,
      scoreDeltasOverThreshold: 'warning',
    },
    sources: {
      baseline: {
        qao: summarizeQaoSource(baselineQao, options.baselineQaoPath),
        ...(baselineCompanionShape === undefined
          ? {}
          : { companionShape: summarizeCompanionSource(baselineCompanionShape, options.baselineCompanionShapePath) }),
      },
      current: {
        qao: summarizeQaoSource(currentQao, options.currentQaoPath),
        ...(currentCompanionShape === undefined
          ? {}
          : { companionShape: summarizeCompanionSource(currentCompanionShape, options.currentCompanionShapePath) }),
      },
    },
    summary: {
      decision: blockerFindingCount === 0 ? 'pass' : 'fail',
      targetCount: currentQao.targets.length,
      comparedTargetCount: targetComparisons.filter((comparison) =>
        comparison.baselineDecision !== undefined && comparison.currentDecision !== undefined,
      ).length,
      blockerFindingCount,
      warningFindingCount,
      infoFindingCount,
    },
    coverageDomains,
    targetComparisons,
    findings: sortedFindings,
  };
}

export function renderCompanionShapeRegressionMarkdown(report: CompanionShapeRegressionReport): string {
  const lines: string[] = [
    '# Companion Shape Regression Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Decision: ${report.summary.decision}`,
    `Score warning threshold: >${report.thresholds.scoreWarningThresholdPercent.toFixed(1)}% of metric scale`,
    'CI behavior: blocker findings fail the command; warning findings are reported without failing.',
    '',
    '## Sources',
    '',
    '| Side | QAO report | Companion-shape report |',
    '| --- | --- | --- |',
    tableRow([
      'baseline',
      formatSource(report.sources.baseline.qao),
      report.sources.baseline.companionShape === undefined ? 'none' : formatSource(report.sources.baseline.companionShape),
    ]),
    tableRow([
      'current',
      formatSource(report.sources.current.qao),
      report.sources.current.companionShape === undefined ? 'none' : formatSource(report.sources.current.companionShape),
    ]),
    '',
    '## Required Coverage Domains',
    '',
    '| Domain | Required scenario families | Required axes | Current status |',
    '| --- | --- | --- | --- |',
  ];

  for (const domain of report.coverageDomains) {
    lines.push(tableRow([
      domain.label,
      domain.requiredScenarioFamilies.join(', '),
      domain.requiredAxes.join(', '),
      domain.status,
    ]));
  }

  lines.push(
    '',
    '## Target Regression Summary',
    '',
    '| Target | Decision | Provider failures | Judge failures | Missing families | New QAO blockers | Score warnings |',
    '| --- | --- | ---: | ---: | --- | ---: | ---: |',
  );

  for (const comparison of report.targetComparisons) {
    const scoreWarnings = comparison.scoreDeltas.filter((delta) => delta.severity === 'warning').length;
    lines.push(tableRow([
      comparison.targetKey,
      `${comparison.baselineDecision ?? 'n/a'} -> ${comparison.currentDecision ?? 'missing'}`,
      `${comparison.baselineProviderFailureCount} -> ${comparison.currentProviderFailureCount}`,
      `${comparison.baselineJudgeFailureCount} -> ${comparison.currentJudgeFailureCount}`,
      comparison.currentMissingScenarioFamilies.join(', ') || 'none',
      String(comparison.newQaoBlockerCount),
      String(scoreWarnings),
    ]));
  }

  lines.push('', '## Findings', '');
  if (report.findings.length === 0) {
    lines.push('No regression findings were found.', '');
  } else {
    lines.push('| Severity | Code | Target | Detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const finding of report.findings) {
      lines.push(tableRow([
        finding.severity,
        finding.code,
        finding.targetKey ?? 'global',
        finding.message,
      ]));
    }
    lines.push('');
  }

  lines.push('## Score Delta Warnings', '');
  const deltas = report.targetComparisons.flatMap((comparison) =>
    comparison.scoreDeltas
      .filter((delta) => delta.severity === 'warning')
      .map((delta) => ({ targetKey: comparison.targetKey, delta })),
  );
  if (deltas.length === 0) {
    lines.push('No score deltas exceeded the warning threshold.', '');
  } else {
    lines.push('| Target | Metric | Baseline | Current | Regression |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const entry of deltas) {
      lines.push(tableRow([
        entry.targetKey,
        entry.delta.label,
        formatNullableNumber(entry.delta.baseline),
        formatNullableNumber(entry.delta.current),
        formatNullablePercent(entry.delta.regressionPercent),
      ]));
    }
    lines.push('');
  }

  lines.push('## Failure Visibility', '');
  lines.push('| Target | Provider failures | Judge failures |');
  lines.push('| --- | --- | --- |');
  for (const comparison of report.targetComparisons) {
    lines.push(tableRow([
      comparison.targetKey,
      formatProviderFailures(comparison.currentProviderFailures),
      formatJudgeFailures(comparison.currentJudgeFailures),
    ]));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function writeCompanionShapeRegressionArtifacts(options: {
  report: CompanionShapeRegressionReport;
  markdownPath?: string;
  jsonPath?: string;
}): {
  markdownPath?: string;
  jsonPath?: string;
} {
  if (options.markdownPath === undefined && options.jsonPath === undefined) {
    throw new Error('At least one output path is required');
  }
  if (options.markdownPath !== undefined) {
    writeTextFile(options.markdownPath, renderCompanionShapeRegressionMarkdown(options.report));
  }
  if (options.jsonPath !== undefined) {
    writeTextFile(options.jsonPath, `${JSON.stringify(options.report, null, 2)}\n`);
  }
  return {
    ...(options.markdownPath === undefined ? {} : { markdownPath: options.markdownPath }),
    ...(options.jsonPath === undefined ? {} : { jsonPath: options.jsonPath }),
  };
}

export function runRegressionCli(args: readonly string[], io: { cwd?: string; stdout?: { write: (text: string) => unknown } } = {}): number {
  const cwd = io.cwd ?? process.cwd();
  const options = parseCliOptions(args, cwd);
  if (options.help) {
    (io.stdout ?? process.stdout).write(`${usage()}\n`);
    return 0;
  }

  const baselineQaoReport = readJsonFile(options.baselineQaoPath);
  const currentQaoReport = readJsonFile(options.currentQaoPath);
  const baselineCompanionShapeReport = options.baselineCompanionShapePath === undefined
    ? undefined
    : readJsonFile(options.baselineCompanionShapePath);
  const currentCompanionShapeReport = options.currentCompanionShapePath === undefined
    ? undefined
    : readJsonFile(options.currentCompanionShapePath);
  const report = buildCompanionShapeRegressionReport({
    baselineQaoReport,
    currentQaoReport,
    ...(baselineCompanionShapeReport === undefined ? {} : { baselineCompanionShapeReport }),
    ...(currentCompanionShapeReport === undefined ? {} : { currentCompanionShapeReport }),
    baselineQaoPath: options.baselineQaoPath,
    currentQaoPath: options.currentQaoPath,
    ...(options.baselineCompanionShapePath === undefined ? {} : { baselineCompanionShapePath: options.baselineCompanionShapePath }),
    ...(options.currentCompanionShapePath === undefined ? {} : { currentCompanionShapePath: options.currentCompanionShapePath }),
    scoreWarningThresholdPercent: options.scoreWarningThresholdPercent,
  });
  const markdown = renderCompanionShapeRegressionMarkdown(report);

  if (options.outputPath === undefined) {
    (io.stdout ?? process.stdout).write(markdown);
  } else {
    writeTextFile(options.outputPath, markdown);
    (io.stdout ?? process.stdout).write(`[eval:regression] wrote Markdown report to ${options.outputPath}\n`);
  }

  if (options.jsonOutputPath !== undefined) {
    writeTextFile(options.jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
    (io.stdout ?? process.stdout).write(`[eval:regression] wrote JSON report to ${options.jsonOutputPath}\n`);
  }

  if (report.summary.decision === 'fail') {
    (io.stdout ?? process.stdout).write(`[eval:regression] blocker findings: ${report.summary.blockerFindingCount}; failing CI gate\n`);
    return 1;
  }
  (io.stdout ?? process.stdout).write(`[eval:regression] blocker findings: 0; warnings: ${report.summary.warningFindingCount}\n`);
  return 0;
}

function parseCliOptions(args: readonly string[], cwd: string): CliOptions {
  let baselineQaoPath = resolvePath(DEFAULT_BASELINE_QAO_PATH, cwd);
  let currentQaoPath = resolvePath(DEFAULT_CURRENT_QAO_PATH, cwd);
  let baselineCompanionShapePath: string | undefined = resolvePath(DEFAULT_BASELINE_COMPANION_SHAPE_PATH, cwd);
  let currentCompanionShapePath: string | undefined = resolvePath(DEFAULT_CURRENT_COMPANION_SHAPE_PATH, cwd);
  let outputPath: string | undefined;
  let jsonOutputPath: string | undefined;
  let scoreWarningThresholdPercent = DEFAULT_SCORE_WARNING_THRESHOLD_PERCENT;
  let help = false;
  let qaoPathOverridden = false;
  let companionShapePathSpecified = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--baseline':
        baselineQaoPath = resolvePath(requireNextArg(args, ++index, '--baseline'), cwd);
        qaoPathOverridden = true;
        break;
      case '--current':
        currentQaoPath = resolvePath(requireNextArg(args, ++index, '--current'), cwd);
        qaoPathOverridden = true;
        break;
      case '--baseline-companion-shape':
        baselineCompanionShapePath = resolvePath(requireNextArg(args, ++index, '--baseline-companion-shape'), cwd);
        companionShapePathSpecified = true;
        break;
      case '--current-companion-shape':
        currentCompanionShapePath = resolvePath(requireNextArg(args, ++index, '--current-companion-shape'), cwd);
        companionShapePathSpecified = true;
        break;
      case '--no-companion-shape':
        baselineCompanionShapePath = undefined;
        currentCompanionShapePath = undefined;
        companionShapePathSpecified = true;
        break;
      case '--output':
        outputPath = resolvePath(requireNextArg(args, ++index, '--output'), cwd);
        break;
      case '--json-output':
        jsonOutputPath = resolvePath(requireNextArg(args, ++index, '--json-output'), cwd);
        break;
      case '--score-warning-threshold-pct':
        scoreWarningThresholdPercent = parseCliNumber(requireNextArg(args, ++index, '--score-warning-threshold-pct'), '--score-warning-threshold-pct');
        validateScoreWarningThreshold(scoreWarningThresholdPercent);
        break;
      case '--help':
        help = true;
        break;
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  if (qaoPathOverridden && !companionShapePathSpecified) {
    baselineCompanionShapePath = undefined;
    currentCompanionShapePath = undefined;
  }
  if ((baselineCompanionShapePath === undefined) !== (currentCompanionShapePath === undefined)) {
    throw new Error('baseline and current companion-shape paths must be provided together');
  }

  return {
    baselineQaoPath,
    currentQaoPath,
    ...(baselineCompanionShapePath === undefined ? {} : { baselineCompanionShapePath }),
    ...(currentCompanionShapePath === undefined ? {} : { currentCompanionShapePath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(jsonOutputPath === undefined ? {} : { jsonOutputPath }),
    scoreWarningThresholdPercent,
    help,
  };
}

function usage(): string {
  return [
    'Usage: npm run eval:regression -- [options]',
    '',
    'Compare offline companion-shape/QAO reports against a privacy-safe baseline.',
    '',
    'Default inputs are sanitized fixture reports and require no provider secrets.',
    '',
    'Options:',
    `  --baseline <path>                    Baseline QAO upgrade report JSON (default: ${DEFAULT_BASELINE_QAO_PATH})`,
    `  --current <path>                     Current QAO upgrade report JSON (default: ${DEFAULT_CURRENT_QAO_PATH})`,
    '  --baseline-companion-shape <path>    Optional baseline companion-shape report JSON',
    '  --current-companion-shape <path>     Optional current companion-shape report JSON',
    '  --no-companion-shape                 Compare only QAO upgrade reports',
    '  --score-warning-threshold-pct <n>    Score delta warning threshold, percent of scale (default: 5)',
    '  --output <path>                      Write privacy-safe Markdown report',
    '  --json-output <path>                 Write trend-compatible JSON report',
    '  --help                              Show this help',
  ].join('\n');
}

function addCoverageFindings(
  findings: RegressionFinding[],
  baselineTarget: RegressionQaoTarget,
  currentTarget: RegressionQaoTarget,
): void {
  for (const family of currentTarget.scenarioCoverage.missingScenarioFamilies) {
    if (baselineTarget.scenarioCoverage.missingScenarioFamilies.includes(family)) continue;
    addFinding(findings, {
      severity: 'blocker',
      code: 'missing_scenario_family_added',
      targetKey: currentTarget.targetKey,
      scenarioFamily: family,
      baseline: 'covered',
      current: 'missing',
      threshold: 'covered',
      message: `Required scenario family ${family} is newly missing for ${currentTarget.targetKey}.`,
    });
  }
  for (const scenarioId of currentTarget.scenarioCoverage.missingScenarioIds) {
    if (baselineTarget.scenarioCoverage.missingScenarioIds.includes(scenarioId)) continue;
    addFinding(findings, {
      severity: 'blocker',
      code: 'missing_scenario_added',
      targetKey: currentTarget.targetKey,
      scenarioId,
      baseline: 'covered',
      current: 'missing',
      threshold: 'covered',
      message: `Required scenario ${scenarioId} is newly missing for ${currentTarget.targetKey}.`,
    });
  }
}

function addFailureFindings(
  findings: RegressionFinding[],
  baselineTarget: RegressionQaoTarget,
  currentTarget: RegressionQaoTarget,
): void {
  if (currentTarget.providerFailureCount > baselineTarget.providerFailureCount) {
    addFinding(findings, {
      severity: 'blocker',
      code: 'provider_failures_increased',
      targetKey: currentTarget.targetKey,
      baseline: baselineTarget.providerFailureCount,
      current: currentTarget.providerFailureCount,
      threshold: baselineTarget.providerFailureCount,
      message: `Provider failures increased from ${baselineTarget.providerFailureCount} to ${currentTarget.providerFailureCount} for ${currentTarget.targetKey}.`,
    });
  }
  if (currentTarget.judgeFailureCount > baselineTarget.judgeFailureCount) {
    addFinding(findings, {
      severity: 'blocker',
      code: 'judge_failures_increased',
      targetKey: currentTarget.targetKey,
      baseline: baselineTarget.judgeFailureCount,
      current: currentTarget.judgeFailureCount,
      threshold: baselineTarget.judgeFailureCount,
      message: `Judge failures increased from ${baselineTarget.judgeFailureCount} to ${currentTarget.judgeFailureCount} for ${currentTarget.targetKey}.`,
    });
  }
}

function compareQaoScores(
  baselineTarget: RegressionQaoTarget,
  currentTarget: RegressionQaoTarget,
  thresholdPercent: number,
  findings: RegressionFinding[],
): RegressionScoreDelta[] {
  const deltas: RegressionScoreDelta[] = [
    compareScore({
      metric: 'qao.readinessScore',
      label: 'QAO readiness score',
      baseline: baselineTarget.readinessScore,
      current: currentTarget.readinessScore,
      scaleMax: QAO_SCORE_SCALE_MAX,
      thresholdPercent,
    }),
    compareScore({
      metric: 'qao.aggregateScore',
      label: 'QAO aggregate score',
      baseline: baselineTarget.aggregateScore,
      current: currentTarget.aggregateScore,
      scaleMax: QAO_SCORE_SCALE_MAX,
      thresholdPercent,
    }),
  ];

  const currentAxes = new Map(currentTarget.axisSummaries.map((axis) => [axis.axis, axis]));
  for (const baselineAxis of baselineTarget.axisSummaries) {
    const currentAxis = currentAxes.get(baselineAxis.axis);
    deltas.push(compareScore({
      metric: `qao.axis.${baselineAxis.axis}`,
      label: `QAO axis ${baselineAxis.axis}`,
      baseline: baselineAxis.meanScore,
      current: currentAxis?.meanScore ?? null,
      scaleMax: QAO_SCORE_SCALE_MAX,
      thresholdPercent,
    }));
  }

  const currentFamilies = new Map(currentTarget.scenarioFamilySummaries.map((family) => [family.scenarioFamily, family]));
  for (const baselineFamily of baselineTarget.scenarioFamilySummaries) {
    const currentFamily = currentFamilies.get(baselineFamily.scenarioFamily);
    deltas.push(compareScore({
      metric: `qao.family.${baselineFamily.scenarioFamily}.meanScore`,
      label: `QAO family ${baselineFamily.scenarioFamily} mean score`,
      baseline: baselineFamily.meanScore,
      current: currentFamily?.meanScore ?? null,
      scaleMax: QAO_SCORE_SCALE_MAX,
      thresholdPercent,
    }));
    deltas.push(compareScore({
      metric: `qao.family.${baselineFamily.scenarioFamily}.upgradeReadinessScore`,
      label: `QAO family ${baselineFamily.scenarioFamily} readiness score`,
      baseline: baselineFamily.upgradeReadinessScore,
      current: currentFamily?.upgradeReadinessScore ?? null,
      scaleMax: QAO_SCORE_SCALE_MAX,
      thresholdPercent,
    }));
  }

  for (const delta of deltas) {
    maybeAddScoreFinding(findings, currentTarget.targetKey, delta);
  }
  return deltas;
}

function addCompanionShapeCoverageFindings(
  findings: RegressionFinding[],
  baseline: RegressionCompanionShapeModelSummary,
  current: RegressionCompanionShapeModelSummary,
): void {
  for (const scenarioId of current.missingScenarioIds) {
    if (baseline.missingScenarioIds.includes(scenarioId)) continue;
    addFinding(findings, {
      severity: 'blocker',
      code: 'companion_shape_missing_scenario_added',
      targetKey: current.targetKey,
      scenarioId,
      baseline: 'covered',
      current: 'missing',
      threshold: 'covered',
      message: `Companion-shape scenario ${scenarioId} is newly missing for ${current.targetKey}.`,
    });
  }
}

function summarizeCoverageDomains(report: RegressionQaoReport, findings: RegressionFinding[]): RegressionCoverageDomainSummary[] {
  return REGRESSION_REQUIRED_COVERAGE_DOMAINS.map((domain) => {
    const targetStatuses = report.targets.map((target) => {
      const missingScenarioFamilies = domain.requiredScenarioFamilies.filter((family) =>
        !target.scenarioCoverage.coveredScenarioFamilies.includes(family),
      );
      const missingAxes = domain.requiredAxes.filter((axis) =>
        !target.axisSummaries.some((summary) =>
          summary.axis === axis && summary.meanScore !== null && summary.judgedExampleCount > 0,
        ),
      );
      const status: CoverageStatus = missingScenarioFamilies.length === 0 && missingAxes.length === 0 ? 'covered' : 'missing';
      if (status === 'missing') {
        addFinding(findings, {
          severity: 'blocker',
          code: 'coverage_domain_missing',
          targetKey: target.targetKey,
          coverageDomain: domain.id,
          scenarioFamily: missingScenarioFamilies.join(', ') || undefined,
          axis: missingAxes.join(', ') || undefined,
          baseline: 'required',
          current: 'missing',
          threshold: 'covered',
          message: `${domain.label} coverage is missing for ${target.targetKey}.`,
        });
      }
      return {
        targetKey: target.targetKey,
        status,
        missingScenarioFamilies,
        missingAxes,
      };
    });
    return {
      ...domain,
      status: targetStatuses.every((targetStatus) => targetStatus.status === 'covered') ? 'covered' : 'missing',
      targetStatuses,
    };
  });
}

function compareScore(options: {
  metric: string;
  label: string;
  baseline: number | null;
  current: number | null;
  scaleMax: number;
  thresholdPercent: number;
}): RegressionScoreDelta {
  if (options.baseline === null || options.current === null) {
    return {
      metric: options.metric,
      label: options.label,
      scaleMax: options.scaleMax,
      baseline: options.baseline,
      current: options.current,
      delta: options.baseline === null || options.current === null ? null : options.current - options.baseline,
      regressionPercent: options.baseline !== null && options.current === null ? 100 : null,
      thresholdPercent: options.thresholdPercent,
      severity: options.baseline !== null && options.current === null ? 'blocker' : null,
    };
  }
  const delta = roundFour(options.current - options.baseline);
  const regressionPercent = roundFour(Math.max(0, (options.baseline - options.current) / options.scaleMax) * 100);
  return {
    metric: options.metric,
    label: options.label,
    scaleMax: options.scaleMax,
    baseline: options.baseline,
    current: options.current,
    delta,
    regressionPercent,
    thresholdPercent: options.thresholdPercent,
    severity: regressionPercent > options.thresholdPercent ? 'warning' : null,
  };
}

function maybeAddScoreFinding(findings: RegressionFinding[], targetKey: string, delta: RegressionScoreDelta): void {
  if (delta.severity === null) return;
  if (delta.severity === 'blocker') {
    addFinding(findings, {
      severity: 'blocker',
      code: 'score_missing',
      targetKey,
      metric: delta.metric,
      baseline: delta.baseline,
      current: delta.current,
      threshold: 'present',
      message: `${delta.label} is missing in the current report for ${targetKey}.`,
    });
    return;
  }
  addFinding(findings, {
    severity: 'warning',
    code: 'model_score_regressed',
    targetKey,
    metric: delta.metric,
    baseline: delta.baseline,
    current: delta.current,
    threshold: delta.thresholdPercent,
    regressionPercent: delta.regressionPercent,
    message: `${delta.label} regressed by ${formatNullablePercent(delta.regressionPercent)}, above the >${delta.thresholdPercent.toFixed(1)}% warning threshold for ${targetKey}.`,
  });
}

function addFinding(findings: RegressionFinding[], finding: Omit<RegressionFinding, 'id'>): void {
  findings.push({
    id: findingId(finding),
    ...finding,
  });
}

function findingId(finding: Omit<RegressionFinding, 'id'>): string {
  return [
    finding.severity,
    finding.code,
    finding.targetKey ?? 'global',
    finding.metric ?? '',
    finding.coverageDomain ?? '',
    finding.qaoReasonCode ?? '',
    finding.scenarioFamily ?? '',
    finding.scenarioId ?? '',
    finding.axis ?? '',
  ].join('|');
}

function dedupeFindings(findings: readonly RegressionFinding[]): RegressionFinding[] {
  const byId = new Map<string, RegressionFinding>();
  for (const finding of findings) {
    if (!byId.has(finding.id)) {
      byId.set(finding.id, finding);
    }
  }
  return [...byId.values()];
}

function sortFindings(findings: readonly RegressionFinding[]): RegressionFinding[] {
  const severityRank: Record<RegressionFindingSeverity, number> = {
    blocker: 0,
    warning: 1,
    info: 2,
  };
  return [...findings].sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity]
    || left.code.localeCompare(right.code)
    || (left.targetKey ?? '').localeCompare(right.targetKey ?? '')
    || (left.metric ?? '').localeCompare(right.metric ?? '')
    || (left.scenarioFamily ?? '').localeCompare(right.scenarioFamily ?? '')
    || (left.scenarioId ?? '').localeCompare(right.scenarioId ?? ''),
  );
}

function parseQaoReport(value: unknown, field: string): RegressionQaoReport {
  const record = parseRecord(value, field);
  assertLiteral(record.schemaVersion, 1, `${field}.schemaVersion`);
  assertLiteral(record.artifactType, QAO_UPGRADE_REPORT_ARTIFACT_TYPE, `${field}.artifactType`);
  const metadata = record.metadata === undefined ? undefined : parseRecord(record.metadata, `${field}.metadata`);
  const thresholds = record.thresholds === undefined ? undefined : parseRecord(record.thresholds, `${field}.thresholds`);
  return {
    schemaVersion: 1,
    artifactType: QAO_UPGRADE_REPORT_ARTIFACT_TYPE,
    ...(record.generatedAt === undefined ? {} : { generatedAt: parseString(record.generatedAt, `${field}.generatedAt`) }),
    thresholdVersion: parseOptionalString(thresholds?.version ?? metadata?.thresholdVersion, `${field}.thresholdVersion`),
    targets: parseArray(record.targets, `${field}.targets`).map((target, index) => parseQaoTarget(target, `${field}.targets[${index}]`)),
    blockers: parseArray(record.blockers ?? [], `${field}.blockers`).map((blocker, index) =>
      parseQaoBlocker(blocker, `${field}.blockers[${index}]`, undefined),
    ),
  };
}

function parseQaoTarget(value: unknown, field: string): RegressionQaoTarget {
  const record = parseRecord(value, field);
  const providerId = parseString(record.providerId, `${field}.providerId`);
  const modelId = parseString(record.modelId, `${field}.modelId`);
  const targetKey = parseString(record.targetKey ?? `${providerId}:${modelId}`, `${field}.targetKey`);
  return {
    targetKey,
    providerId,
    modelId,
    decision: parseDecision(record.decision, `${field}.decision`),
    readinessScore: parseNullableNumber(record.readinessScore, `${field}.readinessScore`),
    aggregateScore: parseNullableNumber(record.aggregateScore, `${field}.aggregateScore`),
    providerFailureCount: parseNonNegativeInteger(record.providerFailureCount, `${field}.providerFailureCount`),
    judgeFailureCount: parseNonNegativeInteger(record.judgeFailureCount, `${field}.judgeFailureCount`),
    malformedJudgeOutputCount: parseNonNegativeInteger(record.malformedJudgeOutputCount ?? 0, `${field}.malformedJudgeOutputCount`),
    scenarioCoverage: parseScenarioCoverage(record.scenarioCoverage, `${field}.scenarioCoverage`),
    axisSummaries: parseArray(record.axisSummaries, `${field}.axisSummaries`).map((axis, index) =>
      parseAxisSummary(axis, `${field}.axisSummaries[${index}]`),
    ),
    scenarioFamilySummaries: parseArray(record.scenarioFamilySummaries ?? [], `${field}.scenarioFamilySummaries`).map((family, index) =>
      parseScenarioFamilySummary(family, `${field}.scenarioFamilySummaries[${index}]`),
    ),
    providerFailures: parseArray(record.providerFailures ?? [], `${field}.providerFailures`).map((failure, index) =>
      parseProviderFailure(failure, `${field}.providerFailures[${index}]`),
    ),
    judgeFailures: parseArray(record.judgeFailures ?? [], `${field}.judgeFailures`).map((failure, index) =>
      parseJudgeFailure(failure, `${field}.judgeFailures[${index}]`),
    ),
    blockers: parseArray(record.blockers ?? [], `${field}.blockers`).map((blocker, index) =>
      parseQaoBlocker(blocker, `${field}.blockers[${index}]`, targetKey),
    ),
  };
}

function parseScenarioCoverage(value: unknown, field: string): RegressionScenarioCoverage {
  const record = parseRecord(value, field);
  return {
    requiredScenarioFamilies: parseStringArray(record.requiredScenarioFamilies, `${field}.requiredScenarioFamilies`),
    coveredScenarioFamilies: parseStringArray(record.coveredScenarioFamilies, `${field}.coveredScenarioFamilies`),
    missingScenarioFamilies: parseStringArray(record.missingScenarioFamilies, `${field}.missingScenarioFamilies`),
    requiredScenarioIds: parseStringArray(record.requiredScenarioIds, `${field}.requiredScenarioIds`),
    coveredScenarioIds: parseStringArray(record.coveredScenarioIds, `${field}.coveredScenarioIds`),
    missingScenarioIds: parseStringArray(record.missingScenarioIds, `${field}.missingScenarioIds`),
  };
}

function parseAxisSummary(value: unknown, field: string): RegressionAxisSummary {
  const record = parseRecord(value, field);
  return {
    axis: parseString(record.axis, `${field}.axis`),
    judgedExampleCount: parseNonNegativeInteger(record.judgedExampleCount, `${field}.judgedExampleCount`),
    meanScore: parseNullableNumber(record.meanScore, `${field}.meanScore`),
    ...(record.status === undefined ? {} : { status: parseDecision(record.status, `${field}.status`) }),
  };
}

function parseScenarioFamilySummary(value: unknown, field: string): RegressionScenarioFamilySummary {
  const record = parseRecord(value, field);
  return {
    scenarioFamily: parseString(record.scenarioFamily, `${field}.scenarioFamily`),
    meanScore: parseNullableNumber(record.meanScore, `${field}.meanScore`),
    upgradeReadinessScore: parseNullableNumber(record.upgradeReadinessScore, `${field}.upgradeReadinessScore`),
  };
}

function parseQaoBlocker(value: unknown, field: string, fallbackTargetKey: string | undefined): RegressionQaoBlocker {
  const record = parseRecord(value, field);
  const targetKey = parseString(record.targetKey ?? fallbackTargetKey, `${field}.targetKey`);
  return {
    targetKey,
    severity: parseFindingSeverity(record.severity ?? 'blocker', `${field}.severity`),
    scope: parseString(record.scope, `${field}.scope`),
    reasonCode: parseString(record.reasonCode, `${field}.reasonCode`),
    ...(record.scenarioFamily === undefined ? {} : { scenarioFamily: parseString(record.scenarioFamily, `${field}.scenarioFamily`) }),
    ...(record.scenarioId === undefined ? {} : { scenarioId: parseString(record.scenarioId, `${field}.scenarioId`) }),
    ...(record.axis === undefined ? {} : { axis: parseString(record.axis, `${field}.axis`) }),
    ...(record.evidenceKind === undefined ? {} : { evidenceKind: parseString(record.evidenceKind, `${field}.evidenceKind`) }),
    ...(record.observed === undefined ? {} : { observed: parseObserved(record.observed, `${field}.observed`) }),
    ...(record.threshold === undefined ? {} : { threshold: parseObserved(record.threshold, `${field}.threshold`) }),
  };
}

function parseProviderFailure(value: unknown, field: string): RegressionProviderFailure {
  const record = parseRecord(value, field);
  return {
    scenarioId: parseString(record.scenarioId, `${field}.scenarioId`),
    scenarioFamily: parseString(record.scenarioFamily ?? 'unknown', `${field}.scenarioFamily`),
    kind: parseString(record.kind, `${field}.kind`),
  };
}

function parseJudgeFailure(value: unknown, field: string): RegressionJudgeFailure {
  const record = parseRecord(value, field);
  return {
    scenarioId: parseString(record.scenarioId, `${field}.scenarioId`),
    scenarioFamily: parseString(record.scenarioFamily ?? 'unknown', `${field}.scenarioFamily`),
    judgeId: parseString(record.judgeId, `${field}.judgeId`),
    kind: parseString(record.kind, `${field}.kind`),
  };
}

function parseCompanionShapeReport(value: unknown, field: string): RegressionCompanionShapeReport {
  const record = parseRecord(value, field);
  assertLiteral(record.schemaVersion, 1, `${field}.schemaVersion`);
  assertLiteral(record.artifactType, COMPANION_SHAPE_REPORT_ARTIFACT_TYPE, `${field}.artifactType`);
  return {
    schemaVersion: 1,
    artifactType: COMPANION_SHAPE_REPORT_ARTIFACT_TYPE,
    runId: parseString(record.runId, `${field}.runId`),
    modelSummaries: parseArray(record.modelSummaries, `${field}.modelSummaries`).map((summary, index) =>
      parseCompanionShapeModelSummary(summary, `${field}.modelSummaries[${index}]`),
    ),
  };
}

function parseCompanionShapeModelSummary(value: unknown, field: string): RegressionCompanionShapeModelSummary {
  const record = parseRecord(value, field);
  const modelId = parseString(record.modelId, `${field}.modelId`);
  const providerId = parseString(record.providerId, `${field}.providerId`);
  return {
    targetKey: `${providerId}:${modelId}`,
    modelId,
    providerId,
    averageScore: parseFiniteNumber(record.averageScore, `${field}.averageScore`),
    responseCount: parseNonNegativeInteger(record.responseCount, `${field}.responseCount`),
    missingScenarioIds: parseStringArray(record.missingScenarioIds, `${field}.missingScenarioIds`),
    riskFlagCount: parseNonNegativeInteger(record.riskFlagCount, `${field}.riskFlagCount`),
  };
}

function mapByTarget(targets: readonly RegressionQaoTarget[]): Map<string, RegressionQaoTarget> {
  return new Map(targets.map((target) => [target.targetKey, target]));
}

function mapCompanionShapeByTarget(
  summaries: readonly RegressionCompanionShapeModelSummary[],
): Map<string, RegressionCompanionShapeModelSummary> {
  return new Map(summaries.map((summary) => [summary.targetKey, summary]));
}

function mapQaoBlockers(
  report: RegressionQaoReport,
  target: RegressionQaoTarget,
): Map<string, RegressionQaoBlocker> {
  const blockers = [
    ...target.blockers,
    ...report.blockers.filter((blocker) => blocker.targetKey === target.targetKey),
  ];
  return new Map(blockers.map((blocker) => [qaoBlockerKey(blocker), blocker]));
}

function qaoBlockerKey(blocker: RegressionQaoBlocker): string {
  return [
    blocker.targetKey,
    blocker.severity,
    blocker.scope,
    blocker.reasonCode,
    blocker.scenarioFamily ?? '',
    blocker.scenarioId ?? '',
    blocker.axis ?? '',
    blocker.evidenceKind ?? '',
  ].join('|');
}

function summarizeQaoSource(report: RegressionQaoReport, filePath: string | undefined): RegressionSourceSummary {
  return {
    ...(filePath === undefined ? {} : { path: filePath }),
    artifactType: report.artifactType,
    schemaVersion: report.schemaVersion,
    ...(report.generatedAt === undefined ? {} : { generatedAt: report.generatedAt }),
    ...(report.thresholdVersion === undefined ? {} : { thresholdVersion: report.thresholdVersion }),
  };
}

function summarizeCompanionSource(
  report: RegressionCompanionShapeReport,
  filePath: string | undefined,
): RegressionSourceSummary {
  return {
    ...(filePath === undefined ? {} : { path: filePath }),
    artifactType: report.artifactType,
    schemaVersion: report.schemaVersion,
    runId: report.runId,
  };
}

function formatSource(source: RegressionSourceSummary): string {
  const parts = [
    source.path ?? source.artifactType,
    source.runId === undefined ? undefined : `run:${source.runId}`,
    source.thresholdVersion === undefined ? undefined : `thresholds:${source.thresholdVersion}`,
  ].filter((part): part is string => part !== undefined);
  return parts.join('<br>');
}

function formatProviderFailures(failures: readonly RegressionProviderFailure[]): string {
  if (failures.length === 0) return 'none';
  return failures.map((failure) => `${failure.scenarioId}:${failure.kind}`).join('<br>');
}

function formatJudgeFailures(failures: readonly RegressionJudgeFailure[]): string {
  if (failures.length === 0) return 'none';
  return failures.map((failure) => `${failure.scenarioId}:${failure.judgeId}:${failure.kind}`).join('<br>');
}

function tableRow(values: readonly string[]): string {
  return `| ${values.map(escapeMarkdownTable).join(' | ')} |`;
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function formatNullableNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function formatNullablePercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseString(value, field);
}

function parseStringArray(value: unknown, field: string): string[] {
  return [...new Set(parseArray(value, field).map((entry, index) => parseString(entry, `${field}[${index}]`)))];
}

function parseFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function parseNullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return parseFiniteNumber(value, field);
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  const parsed = parseFiniteNumber(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseObserved(value: unknown, field: string): number | string | null {
  if (value === null) return null;
  if (typeof value === 'number') return parseFiniteNumber(value, field);
  return parseString(value, field);
}

function parseDecision(value: unknown, field: string): RegressionDecision {
  const decision = parseString(value, field);
  if (decision !== 'pass' && decision !== 'fail') {
    throw new Error(`${field} must be pass or fail`);
  }
  return decision;
}

function parseFindingSeverity(value: unknown, field: string): RegressionFindingSeverity {
  const severity = parseString(value, field);
  if (severity !== 'blocker' && severity !== 'warning' && severity !== 'info') {
    throw new Error(`${field} must be blocker, warning, or info`);
  }
  return severity;
}

function assertLiteral(value: unknown, expected: string | number, field: string): void {
  if (value !== expected) {
    throw new Error(`${field} must be ${String(expected)}`);
  }
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function writeTextFile(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
}

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function requireNextArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCliNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a finite number`);
  }
  return parsed;
}

function validateScoreWarningThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('score warning threshold must be between 0 and 100');
  }
}

function roundFour(value: number): number {
  return Math.round(value * 10000) / 10000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runRegressionCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[eval:regression] failed: ${message}`);
    process.exitCode = 1;
  }
}
