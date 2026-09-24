// Decision backend comparison math (epic psfn-framework-4lf3r, beads .4/.9).
//
// Pure aggregation over DecisionShadowRecord rows — the content-free records
// the runtime appends to decision-shadow.jsonl in shadow mode, and the same
// shape the offline bake-off writes. Per site it reports agreement, per-question
// confusion matrices, local vs Jev latency p50/p95, Jev cost and the answering
// snapshots, and — where a labeled truth is attached — Brier score and
// reliability buckets per backend. This report is the go/no-go evidence for
// moving a site from shadow to jev; it never decides that by itself.

import type { DecisionShadowRecord } from '../../src/primitives/llm/decision/shadow-record.js';

type Side = DecisionShadowRecord['local'];
type Answer = NonNullable<Side['answers']>[string];

/** Ground truth per question: boolean for noul, option key for choice, level index for score. */
export type DecisionTruth = Record<string, boolean | string | number>;

export interface LabeledShadowRecord {
  record: DecisionShadowRecord;
  truth?: DecisionTruth;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
}

export interface CalibrationSummary {
  /** Mean Brier score over questions with a probability and a truth. */
  brier: number | null;
  samples: number;
  /** Ten equal-width buckets of predicted P(true) for noul questions. */
  reliability: Array<{ bucket: string; count: number; meanPredicted: number | null; observedRate: number | null }>;
  accuracy: number | null;
}

export interface QuestionReport {
  type: string;
  compared: number;
  agreementRate: number | null;
  /** confusion[localValue][jevValue] = count */
  confusion: Record<string, Record<string, number>>;
}

export interface SiteReport {
  siteId: string;
  records: number;
  bothAnswered: number;
  localFailures: Record<string, number>;
  jevFailures: Record<string, number>;
  questions: Record<string, QuestionReport>;
  latencyMs: { local: LatencySummary; jev: LatencySummary };
  jevCostUsd: { total: number; mean: number | null; priced: number };
  jevModels: Record<string, number>;
  calibration?: { local: CalibrationSummary; jev: CalibrationSummary };
}

export interface DecisionComparisonReport {
  schemaVersion: 1;
  reportType: 'decision_backend_comparison';
  totalRecords: number;
  sites: SiteReport[];
}

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

function latencySummary(values: number[]): LatencySummary {
  const sorted = [...values].sort((left, right) => left - right);
  return { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

/** The acted-on value of an answer, as a confusion-matrix label. */
export function answerLabel(answer: Answer): string {
  if (answer.type === 'noul') return answer.pYes >= 0.5 ? 'yes' : 'no';
  if (answer.type === 'choice') return answer.choice;
  return String(Math.round(answer.score));
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Per-question Brier contribution and correctness, when computable. */
function scoreAgainstTruth(answer: Answer, truth: boolean | string | number): { brier: number | null; correct: boolean } {
  if (answer.type === 'noul') {
    const target = truth === true ? 1 : 0;
    return { brier: (answer.pYes - target) ** 2, correct: (answer.pYes >= 0.5) === (truth === true) };
  }
  if (answer.type === 'choice') {
    const correct = answer.choice === truth;
    if (!answer.probabilities) return { brier: null, correct };
    const brier = Object.entries(answer.probabilities)
      .reduce((sum, [option, probability]) => sum + ((probability - (option === truth ? 1 : 0)) ** 2), 0);
    return { brier, correct };
  }
  const correct = Math.round(answer.score) === Number(truth);
  if (!answer.probabilities) return { brier: null, correct };
  const brier = Object.entries(answer.probabilities)
    .reduce((sum, [level, probability]) => sum + ((probability - (Number(level) === Number(truth) ? 1 : 0)) ** 2), 0);
  return { brier, correct };
}

function calibrate(rows: Array<{ side: Side; truth: DecisionTruth }>): CalibrationSummary {
  const bucketCount = 10;
  const buckets = Array.from({ length: bucketCount }, () => ({ count: 0, predicted: 0, observed: 0 }));
  let brierSum = 0;
  let brierSamples = 0;
  let correct = 0;
  let judged = 0;
  for (const { side, truth } of rows) {
    if (!side.ok || !side.answers) continue;
    for (const [name, value] of Object.entries(truth)) {
      const answer = side.answers[name];
      if (!answer) continue;
      const scored = scoreAgainstTruth(answer, value);
      judged += 1;
      if (scored.correct) correct += 1;
      if (scored.brier !== null) {
        brierSum += scored.brier;
        brierSamples += 1;
      }
      if (answer.type === 'noul') {
        const index = Math.min(bucketCount - 1, Math.floor(answer.pYes * bucketCount));
        const bucket = buckets[index]!;
        bucket.count += 1;
        bucket.predicted += answer.pYes;
        bucket.observed += value === true ? 1 : 0;
      }
    }
  }
  return {
    brier: brierSamples > 0 ? brierSum / brierSamples : null,
    samples: brierSamples,
    accuracy: judged > 0 ? correct / judged : null,
    reliability: buckets.map((bucket, index) => ({
      bucket: `${(index / bucketCount).toFixed(1)}-${((index + 1) / bucketCount).toFixed(1)}`,
      count: bucket.count,
      meanPredicted: bucket.count > 0 ? bucket.predicted / bucket.count : null,
      observedRate: bucket.count > 0 ? bucket.observed / bucket.count : null,
    })),
  };
}

function reportSite(siteId: string, rows: LabeledShadowRecord[]): SiteReport {
  const localFailures: Record<string, number> = {};
  const jevFailures: Record<string, number> = {};
  const questions: Record<string, QuestionReport> = {};
  const jevModels: Record<string, number> = {};
  const localLatency: number[] = [];
  const jevLatency: number[] = [];
  let bothAnswered = 0;
  let costTotal = 0;
  let priced = 0;

  for (const { record } of rows) {
    if (!record.local.ok) increment(localFailures, record.local.reason ?? 'unknown');
    if (!record.jev.ok) increment(jevFailures, record.jev.reason ?? 'unknown');
    if (record.local.ok && record.jev.ok) bothAnswered += 1;
    localLatency.push(record.local.latencyMs);
    jevLatency.push(record.jev.latencyMs);
    if (record.jev.costUsd !== undefined) {
      costTotal += record.jev.costUsd;
      priced += 1;
    }
    if (record.jev.model) increment(jevModels, record.jev.model);

    for (const [name, type] of Object.entries(record.questions)) {
      const question = questions[name] ??= { type, compared: 0, agreementRate: null, confusion: {} };
      const localAnswer = record.local.answers?.[name];
      const jevAnswer = record.jev.answers?.[name];
      if (!record.local.ok || !record.jev.ok || !localAnswer || !jevAnswer) continue;
      question.compared += 1;
      const row = question.confusion[answerLabel(localAnswer)] ??= {};
      increment(row, answerLabel(jevAnswer));
    }
  }

  for (const [name, question] of Object.entries(questions)) {
    let agreed = 0;
    let compared = 0;
    for (const { record } of rows) {
      const value = record.agreement[name];
      if (value === null || value === undefined) continue;
      compared += 1;
      if (value) agreed += 1;
    }
    question.agreementRate = compared > 0 ? agreed / compared : null;
  }

  const labeled = rows.filter((row): row is Required<LabeledShadowRecord> => row.truth !== undefined);
  return {
    siteId,
    records: rows.length,
    bothAnswered,
    localFailures,
    jevFailures,
    questions,
    latencyMs: { local: latencySummary(localLatency), jev: latencySummary(jevLatency) },
    jevCostUsd: { total: costTotal, mean: priced > 0 ? costTotal / priced : null, priced },
    jevModels,
    ...(labeled.length > 0
      ? {
        calibration: {
          local: calibrate(labeled.map(({ record, truth }) => ({ side: record.local, truth }))),
          jev: calibrate(labeled.map(({ record, truth }) => ({ side: record.jev, truth }))),
        },
      }
      : {}),
  };
}

export function aggregateDecisionComparison(rows: readonly LabeledShadowRecord[]): DecisionComparisonReport {
  const bySite = new Map<string, LabeledShadowRecord[]>();
  for (const row of rows) {
    const list = bySite.get(row.record.siteId) ?? [];
    list.push(row);
    bySite.set(row.record.siteId, list);
  }
  return {
    schemaVersion: 1,
    reportType: 'decision_backend_comparison',
    totalRecords: rows.length,
    sites: [...bySite.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([siteId, siteRows]) => reportSite(siteId, siteRows)),
  };
}

/** Parse decision-shadow.jsonl content; malformed lines are reported, never silently dropped. */
export function parseShadowRecordsJsonl(content: string, source: string): DecisionShadowRecord[] {
  const records: DecisionShadowRecord[] = [];
  content.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (typeof parsed !== 'object' || parsed === null
      || (parsed as { recordType?: unknown }).recordType !== 'decision_shadow_comparison'
      || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
      throw new Error(`${source}:${index + 1}: not a schemaVersion 1 decision_shadow_comparison record`);
    }
    records.push(parsed as DecisionShadowRecord);
  });
  return records;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value)}`;
}

export function renderComparisonMarkdown(report: DecisionComparisonReport): string {
  const lines = [
    `# Decision backend comparison (${report.totalRecords} records)`,
    '',
    '| site | records | both ok | agreement | local p50/p95 ms | jev p50/p95 ms | jev cost USD | jev failures |',
    '| --- | ---: | ---: | --- | --- | --- | ---: | --- |',
  ];
  for (const site of report.sites) {
    const agreement = Object.entries(site.questions)
      .map(([name, question]) => `${name} ${formatRate(question.agreementRate)}`)
      .join(', ');
    const failures = Object.entries(site.jevFailures).map(([reason, count]) => `${reason}:${count}`).join(' ') || '-';
    lines.push(`| ${site.siteId} | ${site.records} | ${site.bothAnswered} | ${agreement} | `
      + `${formatMs(site.latencyMs.local.p50)}/${formatMs(site.latencyMs.local.p95)} | `
      + `${formatMs(site.latencyMs.jev.p50)}/${formatMs(site.latencyMs.jev.p95)} | `
      + `${site.jevCostUsd.total.toFixed(6)} | ${failures} |`);
  }
  for (const site of report.sites) {
    if (!site.calibration) continue;
    lines.push('', `## ${site.siteId} calibration`, '',
      `- local: accuracy ${formatRate(site.calibration.local.accuracy)}, Brier ${site.calibration.local.brier?.toFixed(4) ?? 'n/a'} (${site.calibration.local.samples})`,
      `- jev: accuracy ${formatRate(site.calibration.jev.accuracy)}, Brier ${site.calibration.jev.brier?.toFixed(4) ?? 'n/a'} (${site.calibration.jev.samples})`);
  }
  return `${lines.join('\n')}\n`;
}
