#!/usr/bin/env node

// Shakedown scorecard (Layer A) — see docs/shakedown.md.
//
// Aggregates the run JSONs and enforces two gates in code, not prose:
//
//  1. Non-green taxonomy. Every case status that is not 'ok' is a failure and
//     is bucketed into the enforced taxonomy (semantic_failure,
//     completed_after_abort, agent_busy, runtime_stale, matrix_aborted,
//     unproven_tool_claim, unledgered_charge, plus other_failure). Failures
//     count unless the operator records an explicit waiver.
//
//  2. Coverage cross-check. Every in-scope surface in the docs/shakedown.md
//     coverage appendix must map to >=1 executed case (via coverage-map.json)
//     or carry an explicit non-case disposition. A green scorecard whose
//     coverage rows are untouched is itself a failure — the Sprint-9 failure
//     mode.
//
// The process exits non-zero if either gate is red. Fail-closed config: input
// and output paths come from the env; there are no /mnt or previous-sprint
// defaults.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireEnv, optionalEnv, failClosedOnEnv } from './lib/env.mjs';
import { parseCoverageAppendix, slugifySurface } from './lib/coverage.mjs';

const HARNESS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_DOC_DEFAULT = join(HARNESS_DIR, '..', '..', 'docs', 'shakedown.md');
const COVERAGE_MAP_DEFAULT = join(HARNESS_DIR, 'coverage-map.json');

// The enforced non-green taxonomy. Keys are the canonical categories from
// docs/shakedown.md; values are the harness caseStatus vocabulary that maps to
// each. Any non-'ok' status not listed falls through to 'other_failure'.
const TAXONOMY = {
  semantic_failure: ['semantic_failure'],
  completed_after_abort: ['completed_after_fetch_abort', 'completed_after_http_error'],
  agent_busy: ['agent_busy', 'accepted_during_busy'],
  runtime_stale: ['runtime_stale'],
  matrix_aborted: ['matrix_aborted'],
  unproven_tool_claim: [
    'narration_without_execution',
    'tool_validation_error',
    'missing_expected_tools',
    'missing_turn_record',
  ],
  unledgered_charge: ['unledgered_charge'],
};

const STATUS_TO_CATEGORY = (() => {
  const map = new Map();
  for (const [category, statuses] of Object.entries(TAXONOMY)) {
    for (const status of statuses) map.set(status, category);
  }
  return map;
})();

function classifyTaxonomy(status) {
  if (status === 'ok') return null;
  return STATUS_TO_CATEGORY.get(status) ?? 'other_failure';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function coverageCaseIds(data) {
  return [...new Set(
    (Array.isArray(data?.coverageCaseIds) ? data.coverageCaseIds : [])
      .filter((caseId) => typeof caseId === 'string' && caseId.trim().length > 0)
      .map((caseId) => caseId.trim()),
  )];
}

// Fallback classifier for older/foreign artifacts that predate caseStatus.
function deriveCaseStatus(result) {
  if (typeof result?.caseStatus === 'string' && result.caseStatus.trim()) {
    return result.caseStatus.trim();
  }
  if (Array.isArray(result?.missingExpectedTools) && result.missingExpectedTools.length > 0) {
    return 'missing_expected_tools';
  }
  const responseStatus = toNumber(result?.response?.status);
  if (responseStatus !== null && responseStatus >= 400) {
    return 'http_error';
  }
  const turnStatus = result?.turnSummary?.status;
  if (typeof turnStatus === 'string' && turnStatus.trim() && turnStatus !== 'completed') {
    return turnStatus;
  }
  if (responseStatus !== null && responseStatus >= 200 && responseStatus < 300) {
    return 'ok';
  }
  return 'unknown';
}

function summarizeHarnessArtifact(path, data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const cases = results.map((result) => {
    const status = deriveCaseStatus(result);
    return {
      caseId: result.caseId ?? result.id ?? 'unknown',
      status,
      category: classifyTaxonomy(status),
      // A case that never ran (skipped by a matrix abort) is not "executed".
      executed: status !== 'matrix_aborted',
    };
  });
  const okCount = cases.filter((item) => item.status === 'ok').length;
  const failCases = cases.filter((item) => item.status !== 'ok');
  const toolCoverage = data?.toolCoverage ?? {};
  const turnMetrics = Array.isArray(data?.metrics?.turnMetrics) ? data.metrics.turnMetrics : [];
  const ttftValues = turnMetrics.map((entry) => toNumber(entry.ttftMs)).filter((value) => value !== null);
  const turnElapsedValues = turnMetrics.map((entry) => toNumber(entry.turnElapsedMs)).filter((value) => value !== null);
  const inputTokens = turnMetrics.map((entry) => toNumber(entry.inputTokens)).filter((value) => value !== null);
  const outputTokens = turnMetrics.map((entry) => toNumber(entry.outputTokens)).filter((value) => value !== null);

  return {
    kind: 'harness',
    path,
    file: basename(path),
    phase: data?.phase ?? null,
    harnessStatus: data?.harnessStatus ?? null,
    generatedAt: data?.generatedAt ?? null,
    coverageCaseIds: coverageCaseIds(data),
    coveragePassed: results.length > 0 && failCases.length === 0,
    caseCount: results.length,
    okCount,
    failCount: failCases.length,
    cases,
    failCases,
    tokenTotals: {
      input: inputTokens.reduce((sum, value) => sum + value, 0),
      output: outputTokens.reduce((sum, value) => sum + value, 0),
    },
    latency: {
      avgTtftMs: round(average(ttftValues)),
      avgTurnElapsedMs: round(average(turnElapsedValues)),
    },
    toolCoverage: {
      active: Array.isArray(toolCoverage.activeToolNames) ? toolCoverage.activeToolNames.length : 0,
      catalog: Array.isArray(toolCoverage.catalogToolNames) ? toolCoverage.catalogToolNames.length : 0,
      validated: Array.isArray(toolCoverage.validatedToolNames) ? toolCoverage.validatedToolNames.length : 0,
      covered: Array.isArray(toolCoverage.coveredToolNames) ? toolCoverage.coveredToolNames.length : 0,
    },
  };
}

function summarizeUiArtifact(path, data) {
  const pages = Array.isArray(data?.pages) ? data.pages : [];
  const failures = Array.isArray(data?.failures)
    ? data.failures
    : pages.filter((page) => !page?.ok).map((page) => page.name ?? 'unknown');
  const failCount = failures.length;
  return {
    kind: 'ui',
    path,
    file: basename(path),
    generatedAt: data?.generatedAt ?? null,
    coverageCaseIds: coverageCaseIds(data),
    coveragePassed: pages.length > 0 && failCount === 0,
    pageCount: pages.length,
    okCount: pages.filter((page) => page?.ok).length,
    failCount,
    failPages: failures,
  };
}

function summarizeLiveSweepArtifact(path, data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const isOk = (result) => {
    const status = toNumber(result?.response?.status);
    return status !== null && status >= 200 && status < 300;
  };
  const failCount = results.filter((result) => !isOk(result)).length;
  return {
    kind: 'live-sweep',
    path,
    file: basename(path),
    generatedAt: data?.generatedAt ?? null,
    coverageCaseIds: coverageCaseIds(data),
    coveragePassed: results.length > 0 && failCount === 0,
    caseCount: results.length,
    okCount: results.filter(isOk).length,
    failCount,
    failCases: results.filter((result) => !isOk(result)).map((result) => ({
      caseId: result.id ?? 'unknown',
      status: result?.response?.status ?? null,
    })),
  };
}

function summarizeCoverageArtifact(path, data) {
  const status = typeof data?.status === 'string' ? data.status.trim().toLowerCase() : null;
  const passed = data?.ok === true || ['ok', 'passed', 'success'].includes(status);
  return {
    kind: 'coverage',
    path,
    file: basename(path),
    generatedAt: data?.generatedAt ?? null,
    status,
    coverageCaseIds: coverageCaseIds(data),
    coveragePassed: passed,
    failCount: passed ? 0 : 1,
  };
}

function loadSummaries(paths) {
  const summaries = [];
  for (const path of paths) {
    const data = readJson(path);
    if (Array.isArray(data?.pages)) {
      summaries.push(summarizeUiArtifact(path, data));
      continue;
    }
    if (
      Array.isArray(data?.results)
      && (
        Array.isArray(data?.metrics?.turnMetrics)
        || typeof data?.phase === 'string'
        || typeof data?.harnessStatus === 'string'
        || data?.bootstrap
        || data?.initialStats
      )
    ) {
      summaries.push(summarizeHarnessArtifact(path, data));
      continue;
    }
    if (Array.isArray(data?.results)) {
      summaries.push(summarizeLiveSweepArtifact(path, data));
      continue;
    }
    if (coverageCaseIds(data).length > 0) {
      summaries.push(summarizeCoverageArtifact(path, data));
    }
  }
  return summaries;
}

function loadWaivers(waiverPath) {
  if (!waiverPath) return { cases: new Set(), surfaces: new Set(), raw: null };
  if (!existsSync(waiverPath)) {
    throw new Error(`Waivers file not found: ${waiverPath}`);
  }
  const raw = readJson(waiverPath);
  const cases = new Set(
    (Array.isArray(raw?.cases) ? raw.cases : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.caseId))
      .filter(Boolean),
  );
  const surfaces = new Set(
    (Array.isArray(raw?.surfaces) ? raw.surfaces : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.surface))
      .filter(Boolean)
      .map((value) => slugifySurface(value)),
  );
  return { cases, surfaces, raw };
}

function buildTaxonomyReport(harnessSummaries, waivers) {
  const categories = {};
  for (const category of [...Object.keys(TAXONOMY), 'other_failure']) {
    categories[category] = [];
  }
  let waivedCount = 0;
  for (const summary of harnessSummaries) {
    for (const item of summary.cases) {
      if (!item.category) continue;
      const waived = waivers.cases.has(item.caseId);
      if (waived) waivedCount += 1;
      categories[item.category].push({
        caseId: item.caseId,
        status: item.status,
        artifact: summary.file,
        waived,
      });
    }
  }
  const unwaivedFailures = Object.values(categories)
    .flat()
    .filter((entry) => !entry.waived);
  return {
    categories,
    totalFailures: Object.values(categories).flat().length,
    waivedCount,
    unwaivedFailureCount: unwaivedFailures.length,
    unwaivedFailures,
  };
}

function buildCoverageCrossCheck(docPath, coverageMapPath, executedCaseIds, waivers) {
  const surfaces = parseCoverageAppendix(docPath);
  const coverageMap = existsSync(coverageMapPath) ? readJson(coverageMapPath) : { surfaces: {} };
  const mapSurfaces = coverageMap?.surfaces ?? {};

  const rows = surfaces.map((surface) => {
    const mapping = mapSurfaces[surface.key] ?? null;
    const mappedCases = Array.isArray(mapping?.cases) ? mapping.cases : [];
    const executedMappedCases = mappedCases.filter((caseId) => executedCaseIds.has(caseId));
    const disposition = typeof mapping?.disposition === 'string' ? mapping.disposition : null;
    const validDisposition = ['manual', 'partner', 'waived'].includes(disposition);
    const waived = waivers.surfaces.has(surface.key);
    const covered = executedMappedCases.length > 0 || validDisposition || waived;
    return {
      key: surface.key,
      surface: surface.surface,
      lane: surface.lane,
      mappedCases,
      executedMappedCases,
      disposition,
      waived,
      covered,
      reason: covered
        ? (executedMappedCases.length > 0 ? 'executed_case' : (validDisposition ? `disposition:${disposition}` : 'waived'))
        : (!mapping || mappedCases.length === 0 ? 'no_cases_mapped' : 'mapped_cases_not_executed'),
    };
  });
  const uncovered = rows.filter((row) => !row.covered);
  return {
    surfaceCount: rows.length,
    coveredCount: rows.filter((row) => row.covered).length,
    uncoveredCount: uncovered.length,
    rows,
    uncovered,
  };
}

function aggregate(summaries, taxonomy, coverage) {
  const harness = summaries.filter((entry) => entry.kind === 'harness');
  const ui = summaries.filter((entry) => entry.kind === 'ui');
  const liveSweep = summaries.filter((entry) => entry.kind === 'live-sweep');
  const coverageArtifacts = summaries.filter((entry) => entry.kind === 'coverage');

  const totalHarnessCases = harness.reduce((sum, entry) => sum + entry.caseCount, 0);
  const totalHarnessOk = harness.reduce((sum, entry) => sum + entry.okCount, 0);
  const totalUiFail = ui.reduce((sum, entry) => sum + entry.failCount, 0);
  const totalLiveSweepFail = liveSweep.reduce((sum, entry) => sum + entry.failCount, 0);
  const totalCoverageArtifactFail = coverageArtifacts
    .reduce((sum, entry) => sum + entry.failCount, 0);

  const green = taxonomy.unwaivedFailureCount === 0
    && coverage.uncoveredCount === 0
    && totalUiFail === 0
    && totalLiveSweepFail === 0
    && totalCoverageArtifactFail === 0;

  return {
    generatedAt: new Date().toISOString(),
    green,
    verdict: green ? 'green' : 'red',
    failureReasons: [
      ...(taxonomy.unwaivedFailureCount > 0
        ? [`${taxonomy.unwaivedFailureCount} unwaived case failure(s)`] : []),
      ...(coverage.uncoveredCount > 0
        ? [`${coverage.uncoveredCount} uncovered coverage-appendix surface(s)`] : []),
      ...(totalUiFail > 0 ? [`${totalUiFail} Garden sweep page failure(s)`] : []),
      ...(totalLiveSweepFail > 0 ? [`${totalLiveSweepFail} live sweep failure(s)`] : []),
      ...(totalCoverageArtifactFail > 0
        ? [`${totalCoverageArtifactFail} external coverage artifact failure(s)`]
        : []),
    ],
    inputs: summaries.map((entry) => entry.path),
    harness: {
      artifactCount: harness.length,
      totalCases: totalHarnessCases,
      okCount: totalHarnessOk,
      failCount: totalHarnessCases - totalHarnessOk,
      passRate: totalHarnessCases > 0 ? round((totalHarnessOk / totalHarnessCases) * 100, 1) : null,
    },
    ui: {
      artifactCount: ui.length,
      totalPages: ui.reduce((sum, entry) => sum + entry.pageCount, 0),
      failCount: totalUiFail,
    },
    liveSweep: {
      artifactCount: liveSweep.length,
      totalCases: liveSweep.reduce((sum, entry) => sum + entry.caseCount, 0),
      failCount: liveSweep.reduce((sum, entry) => sum + entry.failCount, 0),
    },
    coverageArtifacts: {
      artifactCount: coverageArtifacts.length,
      failCount: totalCoverageArtifactFail,
    },
    taxonomy,
    coverage,
    summaries,
  };
}

function toMarkdown(scorecard) {
  const lines = [
    '# Shakedown Scorecard',
    '',
    `Generated: ${scorecard.generatedAt}`,
    '',
    `**Verdict: ${scorecard.verdict.toUpperCase()}**`,
    ...(scorecard.failureReasons.length > 0
      ? ['', ...scorecard.failureReasons.map((reason) => `- ${reason}`)]
      : ['', '- All case statuses green and every coverage surface accounted for.']),
    '',
    '## Case totals',
    '',
    `- Harness artifacts: ${scorecard.harness.artifactCount}`,
    `- Harness cases: ${scorecard.harness.okCount}/${scorecard.harness.totalCases} ok (${scorecard.harness.passRate ?? 'n/a'}%)`,
    `- Garden sweep pages failing: ${scorecard.ui.failCount}/${scorecard.ui.totalPages}`,
    `- Live sweep cases failing: ${scorecard.liveSweep.failCount}/${scorecard.liveSweep.totalCases}`,
    `- External coverage artifacts failing: ${scorecard.coverageArtifacts.failCount}/${scorecard.coverageArtifacts.artifactCount}`,
    '',
    '## Non-green taxonomy',
    '',
    `Unwaived failures: ${scorecard.taxonomy.unwaivedFailureCount} (waived: ${scorecard.taxonomy.waivedCount})`,
    '',
  ];
  for (const [category, entries] of Object.entries(scorecard.taxonomy.categories)) {
    if (entries.length === 0) continue;
    const rendered = entries
      .map((entry) => `${entry.caseId} (${entry.status}${entry.waived ? ', waived' : ''})`)
      .join(', ');
    lines.push(`- **${category}** [${entries.length}]: ${rendered}`);
  }
  if (scorecard.taxonomy.totalFailures === 0) {
    lines.push('- No non-green case statuses.');
  }

  lines.push('', '## Coverage cross-check (docs/shakedown.md appendix)', '');
  lines.push(`Surfaces covered: ${scorecard.coverage.coveredCount}/${scorecard.coverage.surfaceCount}`);
  lines.push('');
  lines.push('| Surface | Covered | By | Lane |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of scorecard.coverage.rows) {
    const by = row.covered
      ? (row.executedMappedCases.length > 0 ? row.executedMappedCases.join(', ') : row.reason)
      : row.reason;
    lines.push(`| ${row.surface} | ${row.covered ? 'yes' : 'NO'} | ${by} | ${row.lane} |`);
  }
  if (scorecard.coverage.uncoveredCount > 0) {
    lines.push('');
    lines.push(`**${scorecard.coverage.uncoveredCount} uncovered surface(s) — scorecard fails until each maps to an executed case or an explicit disposition.**`);
  }

  return `${lines.join('\n').trim()}\n`;
}

function main() {
  const inputsRaw = requireEnv('PSFN_SCORECARD_INPUTS', 'comma-separated run JSON paths');
  const jsonOut = requireEnv('PSFN_SCORECARD_JSON', 'scorecard JSON output path');
  const mdOut = requireEnv('PSFN_SCORECARD_MD', 'scorecard Markdown output path');
  const docPath = optionalEnv('PSFN_SHAKEDOWN_DOC') ?? REPO_DOC_DEFAULT;
  const coverageMapPath = optionalEnv('PSFN_COVERAGE_MAP') ?? COVERAGE_MAP_DEFAULT;
  const waiverPath = optionalEnv('PSFN_SCORECARD_WAIVERS');

  const candidates = inputsRaw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const inputs = candidates.filter((path, index) => candidates.indexOf(path) === index && existsSync(path));
  const missing = candidates.filter((path) => !existsSync(path));
  if (inputs.length === 0) {
    throw new Error(`No shakedown artifacts found for scorecard generation (checked: ${candidates.join(', ') || 'none'}).`);
  }

  const waivers = loadWaivers(waiverPath);
  const summaries = loadSummaries(inputs);
  const harnessSummaries = summaries.filter((entry) => entry.kind === 'harness');
  const executedCaseIds = new Set(
    [
      ...harnessSummaries.flatMap(
        (summary) => summary.cases.filter((item) => item.status === 'ok').map((item) => item.caseId),
      ),
      ...summaries
        .filter((summary) => summary.coveragePassed)
        .flatMap((summary) => summary.coverageCaseIds),
    ],
  );

  const taxonomy = buildTaxonomyReport(harnessSummaries, waivers);
  const coverage = buildCoverageCrossCheck(docPath, coverageMapPath, executedCaseIds, waivers);
  const scorecard = aggregate(summaries, taxonomy, coverage);
  scorecard.docPath = docPath;
  scorecard.coverageMapPath = coverageMapPath;
  scorecard.missingInputs = missing;

  writeFileSync(jsonOut, JSON.stringify(scorecard, null, 2));
  writeFileSync(mdOut, toMarkdown(scorecard));

  process.stdout.write(`${JSON.stringify({
    ok: scorecard.green,
    verdict: scorecard.verdict,
    failureReasons: scorecard.failureReasons,
    json: jsonOut,
    markdown: mdOut,
    inputs,
  }, null, 2)}\n`);

  if (!scorecard.green) {
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  failClosedOnEnv(error);
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
