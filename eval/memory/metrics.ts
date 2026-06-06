import type {
  MemoryMaintenanceObservation,
  MemoryMetricGate,
  MemoryMetricName,
  MemoryRegressionFixture,
  MemoryRegressionFixtureResult,
  MemoryRegressionReport,
  MemoryRetrievalObservation,
  MemoryRetrievalProbe,
  MemoryWriteObservation,
} from './types.js';
import { MEMORY_REGRESSION_SCHEMA_VERSION } from './types.js';

const DEFAULT_K = 5;

type MetricMap = Record<MemoryMetricName, number>;

interface EvaluationInput {
  providerId: string;
  generatedAt: string;
  fixtures: readonly MemoryRegressionFixture[];
  fixtureResults: readonly MemoryRegressionFixtureResult[];
  k?: number;
}

interface RetrievalCase {
  fixture: MemoryRegressionFixture;
  probe: MemoryRetrievalProbe;
  observation: MemoryRetrievalObservation;
}

function intersectionSize(a: readonly string[], b: readonly string[]): number {
  const bSet = new Set(b);
  return a.filter((value) => bSet.has(value)).length;
}

function mean(values: readonly number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: readonly number[], fallback = 0): number {
  return values.length > 0 ? Math.max(...values) : fallback;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(6));
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('\u0000');
}

function groupPairs(group: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let left = 0; left < group.length; left += 1) {
    for (let right = left + 1; right < group.length; right += 1) {
      const a = group[left];
      const b = group[right];
      if (a && b) pairs.push(pairKey(a, b));
    }
  }
  return pairs;
}

function buildRetrievalCases(
  fixtures: readonly MemoryRegressionFixture[],
  results: readonly MemoryRegressionFixtureResult[],
): RetrievalCase[] {
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const cases: RetrievalCase[] = [];
  for (const result of results) {
    const fixture = fixturesById.get(result.fixtureId);
    if (!fixture) continue;
    const probesById = new Map([
      ...fixture.retrievals,
      ...(fixture.backupRestore ? [fixture.backupRestore.probeAfterRestore] : []),
    ].map((probe) => [probe.id, probe]));
    for (const observation of result.retrievals) {
      const probe = probesById.get(observation.probeId);
      if (probe) cases.push({ fixture, probe, observation });
    }
  }
  return cases;
}

function computeRetrievalMetrics(cases: readonly RetrievalCase[], k: number): Pick<
  MetricMap,
  'precision@k' | 'recall@k' | 'mrr' | 'trust_leak_rate' | 'useful_facts_per_prompt_token' | 'retrieval_latency_ms_p95'
> {
  const precisionValues: number[] = [];
  const recallValues: number[] = [];
  const reciprocalRanks: number[] = [];
  let leakedWithheldCount = 0;
  let expectedWithheldCount = 0;
  let usefulFactCount = 0;
  let promptTokenCount = 0;

  for (const { probe, observation } of cases) {
    const selectedTopK = observation.selectedMemoryIds.slice(0, Math.min(k, probe.topK));
    const hitCount = intersectionSize(selectedTopK, probe.expectedMemoryIds);
    precisionValues.push(selectedTopK.length > 0 ? hitCount / selectedTopK.length : 0);
    recallValues.push(probe.expectedMemoryIds.length > 0 ? hitCount / probe.expectedMemoryIds.length : 1);

    const firstExpectedRank = observation.selectedMemoryIds.findIndex((id) => probe.expectedMemoryIds.includes(id));
    reciprocalRanks.push(firstExpectedRank >= 0 ? 1 / (firstExpectedRank + 1) : 0);

    const expectedWithheld = probe.expectedWithheldMemoryIds ?? [];
    expectedWithheldCount += expectedWithheld.length;
    leakedWithheldCount += intersectionSize(observation.selectedMemoryIds, expectedWithheld);
    usefulFactCount += hitCount;
    promptTokenCount += observation.promptTokenCount;
  }

  return {
    'precision@k': roundMetric(mean(precisionValues, 1)),
    'recall@k': roundMetric(mean(recallValues, 1)),
    mrr: roundMetric(mean(reciprocalRanks, 1)),
    trust_leak_rate: roundMetric(expectedWithheldCount > 0 ? leakedWithheldCount / expectedWithheldCount : 0),
    useful_facts_per_prompt_token: roundMetric(promptTokenCount > 0 ? usefulFactCount / promptTokenCount : 0),
    retrieval_latency_ms_p95: roundMetric(percentile(cases.map((entry) => entry.observation.latencyMs), 95)),
  };
}

function computeSupersedeMetrics(fixtures: readonly MemoryRegressionFixture[], results: readonly MemoryRegressionFixtureResult[]): Pick<
  MetricMap,
  'false_supersede_rate' | 'missed_supersede_rate' | 'compatible_update_false_positive_rate'
> {
  const operationsById = new Map(fixtures.flatMap((fixture) => fixture.writes).map((operation) => [operation.id, operation]));
  const observations = results.flatMap((result) => result.writes);
  let falseSupersedeCount = 0;
  let actualSupersedeCount = 0;
  let missedSupersedeCount = 0;
  let expectedSupersedeCount = 0;
  let compatibleOperationCount = 0;
  let compatibleFalsePositiveCount = 0;

  for (const observation of observations) {
    const operation = operationsById.get(observation.operationId);
    if (!operation) continue;
    const expected = new Set(operation.expectedSupersededMemoryIds);
    actualSupersedeCount += observation.supersededMemoryIds.length;
    expectedSupersedeCount += expected.size;
    falseSupersedeCount += observation.supersededMemoryIds.filter((id) => !expected.has(id)).length;
    missedSupersedeCount += [...expected].filter((id) => !observation.supersededMemoryIds.includes(id)).length;
    if (operation.compatibleUpdate) {
      compatibleOperationCount += 1;
      if (observation.supersededMemoryIds.length > 0) compatibleFalsePositiveCount += 1;
    }
  }

  return {
    false_supersede_rate: roundMetric(actualSupersedeCount > 0 ? falseSupersedeCount / actualSupersedeCount : 0),
    missed_supersede_rate: roundMetric(expectedSupersedeCount > 0 ? missedSupersedeCount / expectedSupersedeCount : 0),
    compatible_update_false_positive_rate: roundMetric(
      compatibleOperationCount > 0 ? compatibleFalsePositiveCount / compatibleOperationCount : 0,
    ),
  };
}

function computeMaintenanceMetrics(fixtures: readonly MemoryRegressionFixture[], results: readonly MemoryRegressionFixtureResult[]): Pick<
  MetricMap,
  'episode_duplicate_rate' | 'merge_precision' | 'merge_recall' | 'queue_age_ms_max'
> {
  const expectedPairs = new Set<string>();
  let expectedMergeGroupCount = 0;
  let unmergedGroupCount = 0;

  for (const fixture of fixtures) {
    const result = results.find((candidate) => candidate.fixtureId === fixture.id);
    const activeEpisodeIds = new Set(result?.maintenance.activeEpisodeIds ?? []);
    for (const group of fixture.maintenance?.expectedEpisodeMergeGroups ?? []) {
      expectedMergeGroupCount += 1;
      for (const pair of groupPairs(group)) expectedPairs.add(pair);
      const activeCount = group.filter((episodeId) => activeEpisodeIds.has(episodeId)).length;
      if (activeCount > 1) unmergedGroupCount += 1;
    }
  }

  const actualPairs = new Set<string>();
  const queueAges = results.flatMap((result) => result.maintenance.queueAgeMs);
  for (const result of results) {
    for (const [a, b] of result.maintenance.mergedEpisodePairs) {
      actualPairs.add(pairKey(a, b));
    }
  }

  const truePositivePairs = [...actualPairs].filter((pair) => expectedPairs.has(pair)).length;
  return {
    episode_duplicate_rate: roundMetric(expectedMergeGroupCount > 0 ? unmergedGroupCount / expectedMergeGroupCount : 0),
    merge_precision: roundMetric(actualPairs.size > 0 ? truePositivePairs / actualPairs.size : expectedPairs.size === 0 ? 1 : 0),
    merge_recall: roundMetric(expectedPairs.size > 0 ? truePositivePairs / expectedPairs.size : 1),
    queue_age_ms_max: roundMetric(max(queueAges)),
  };
}

export function buildMemoryRegressionReport(input: EvaluationInput): MemoryRegressionReport {
  const k = input.k ?? DEFAULT_K;
  const retrievalCases = buildRetrievalCases(input.fixtures, input.fixtureResults);
  const metrics: MetricMap = {
    ...computeRetrievalMetrics(retrievalCases, k),
    ...computeSupersedeMetrics(input.fixtures, input.fixtureResults),
    ...computeMaintenanceMetrics(input.fixtures, input.fixtureResults),
  };
  const gates = buildGates(metrics);
  const status = gates.every((gate) => gate.passed)
    && input.fixtureResults.every((result) => result.status === 'pass')
    ? 'pass'
    : 'fail';

  return {
    schemaVersion: MEMORY_REGRESSION_SCHEMA_VERSION,
    artifactType: 'psfn.memory_regression_benchmark',
    providerId: input.providerId,
    generatedAt: input.generatedAt,
    status,
    k,
    fixtureCount: input.fixtures.length,
    families: [...new Set(input.fixtures.map((fixture) => fixture.family))].sort(),
    metrics,
    gates,
    fixtureResults: [...input.fixtureResults],
  };
}

function buildGates(metrics: MetricMap): MemoryMetricGate[] {
  return [
    { metric: 'precision@k', operator: 'gte', threshold: 0.95, actual: metrics['precision@k'], passed: metrics['precision@k'] >= 0.95 },
    { metric: 'recall@k', operator: 'gte', threshold: 0.95, actual: metrics['recall@k'], passed: metrics['recall@k'] >= 0.95 },
    { metric: 'mrr', operator: 'gte', threshold: 0.95, actual: metrics.mrr, passed: metrics.mrr >= 0.95 },
    { metric: 'false_supersede_rate', operator: 'lte', threshold: 0, actual: metrics.false_supersede_rate, passed: metrics.false_supersede_rate <= 0 },
    { metric: 'missed_supersede_rate', operator: 'lte', threshold: 0, actual: metrics.missed_supersede_rate, passed: metrics.missed_supersede_rate <= 0 },
    {
      metric: 'compatible_update_false_positive_rate',
      operator: 'lte',
      threshold: 0,
      actual: metrics.compatible_update_false_positive_rate,
      passed: metrics.compatible_update_false_positive_rate <= 0,
    },
    { metric: 'episode_duplicate_rate', operator: 'lte', threshold: 0, actual: metrics.episode_duplicate_rate, passed: metrics.episode_duplicate_rate <= 0 },
    { metric: 'merge_precision', operator: 'gte', threshold: 1, actual: metrics.merge_precision, passed: metrics.merge_precision >= 1 },
    { metric: 'merge_recall', operator: 'gte', threshold: 1, actual: metrics.merge_recall, passed: metrics.merge_recall >= 1 },
    { metric: 'trust_leak_rate', operator: 'lte', threshold: 0, actual: metrics.trust_leak_rate, passed: metrics.trust_leak_rate <= 0 },
    {
      metric: 'useful_facts_per_prompt_token',
      operator: 'gte',
      threshold: 0.02,
      actual: metrics.useful_facts_per_prompt_token,
      passed: metrics.useful_facts_per_prompt_token >= 0.02,
    },
    {
      metric: 'retrieval_latency_ms_p95',
      operator: 'lte',
      threshold: 50,
      actual: metrics.retrieval_latency_ms_p95,
      passed: metrics.retrieval_latency_ms_p95 <= 50,
    },
    {
      metric: 'queue_age_ms_max',
      operator: 'lte',
      threshold: 600_000,
      actual: metrics.queue_age_ms_max,
      passed: metrics.queue_age_ms_max <= 600_000,
    },
  ];
}

export function evaluateFixtureFailures(input: {
  fixture: MemoryRegressionFixture;
  writes: readonly MemoryWriteObservation[];
  retrievals: readonly MemoryRetrievalObservation[];
  maintenance: MemoryMaintenanceObservation;
}): string[] {
  const failures: string[] = [];
  const writesById = new Map(input.writes.map((write) => [write.operationId, write]));
  for (const operation of input.fixture.writes) {
    const observation = writesById.get(operation.id);
    if (!observation) {
      failures.push(`missing write observation for ${operation.id}`);
      continue;
    }
    for (const expectedId of operation.expectedSupersededMemoryIds) {
      if (!observation.supersededMemoryIds.includes(expectedId)) {
        failures.push(`write ${operation.id} missed expected supersede of ${expectedId}`);
      }
    }
    if (operation.compatibleUpdate && observation.supersededMemoryIds.length > 0) {
      failures.push(`compatible update ${operation.id} superseded ${observation.supersededMemoryIds.join(', ')}`);
    }
  }

  const probes = [
    ...input.fixture.retrievals,
    ...(input.fixture.backupRestore ? [input.fixture.backupRestore.probeAfterRestore] : []),
  ];
  const retrievalsById = new Map(input.retrievals.map((retrieval) => [retrieval.probeId, retrieval]));
  for (const probe of probes) {
    const observation = retrievalsById.get(probe.id);
    if (!observation) {
      failures.push(`missing retrieval observation for ${probe.id}`);
      continue;
    }
    const missing = probe.expectedMemoryIds.filter((id) => !observation.selectedMemoryIds.includes(id));
    if (missing.length > 0) {
      failures.push(`retrieval ${probe.id} missed ${missing.join(', ')}`);
    }
    const leaked = (probe.expectedWithheldMemoryIds ?? []).filter((id) => observation.selectedMemoryIds.includes(id));
    if (leaked.length > 0) {
      failures.push(`retrieval ${probe.id} leaked withheld ${leaked.join(', ')}`);
    }
    const unreportedWithheld = (probe.expectedWithheldMemoryIds ?? []).filter((id) => !observation.withheldMemoryIds.includes(id));
    if (unreportedWithheld.length > 0) {
      failures.push(`retrieval ${probe.id} did not report withheld ${unreportedWithheld.join(', ')}`);
    }
  }

  const activeEpisodeIds = new Set(input.maintenance.activeEpisodeIds);
  for (const group of input.fixture.maintenance?.expectedEpisodeMergeGroups ?? []) {
    const activeGroupMembers = group.filter((episodeId) => activeEpisodeIds.has(episodeId));
    if (activeGroupMembers.length > 1) {
      failures.push(`duplicate episode group still active: ${activeGroupMembers.join(', ')}`);
    }
  }

  return failures;
}
