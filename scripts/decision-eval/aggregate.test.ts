import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  aggregateDecisionComparison,
  parseShadowRecordsJsonl,
  percentile,
} from './aggregate.js';
import { runShadowReport } from './shadow-report.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shadow-records.jsonl');

function fixtureRecords() {
  return parseShadowRecordsJsonl(readFileSync(FIXTURE, 'utf8'), FIXTURE);
}

describe('decision comparison aggregation', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it('reports agreement, confusion, latency, cost and failures per site', () => {
    const report = aggregateDecisionComparison(fixtureRecords().map(record => ({ record })));
    expect(report.totalRecords).toBe(5);
    expect(report.sites.map(site => site.siteId)).toEqual(['participation.appraise', 'room.ambiguity']);

    const room = report.sites.find(site => site.siteId === 'room.ambiguity')!;
    expect(room.records).toBe(3);
    expect(room.bothAnswered).toBe(2);
    expect(room.jevFailures).toEqual({ aborted: 1 });
    expect(room.questions.q).toEqual({
      type: 'noul',
      compared: 2,
      agreementRate: 0.5,
      confusion: { yes: { yes: 1 }, no: { yes: 1 } },
    });
    expect(room.latencyMs.local).toEqual({ count: 3, p50: 1000, p95: 1100 });
    expect(room.latencyMs.jev).toEqual({ count: 3, p50: 120, p95: 1500 });
    expect(room.jevCostUsd.priced).toBe(2);
    expect(room.jevCostUsd.total).toBeCloseTo(0.00002);
    expect(room.jevModels).toEqual({ 'typesafe/jev-1.13-20260917': 2 });
    expect(room.calibration).toBeUndefined();

    const appraise = report.sites.find(site => site.siteId === 'participation.appraise')!;
    expect(appraise.questions.q?.confusion).toEqual({ reply: { reply: 1 }, ignore: { react: 1 } });
  });

  it('scores Brier and accuracy against labeled truth', () => {
    const [first, second] = fixtureRecords();
    const report = aggregateDecisionComparison([
      { record: first!, truth: { q: true } },
      { record: second!, truth: { q: false } },
    ]);
    const calibration = report.sites[0]!.calibration!;
    // local: (0.9-1)^2 = 0.01, (0.2-0)^2 = 0.04 -> 0.025; jev: (0.8-1)^2 = 0.04, 0.7^2 = 0.49 -> 0.265
    expect(calibration.local.brier).toBeCloseTo(0.025);
    expect(calibration.jev.brier).toBeCloseTo(0.265);
    expect(calibration.local.accuracy).toBe(1);
    expect(calibration.jev.accuracy).toBe(0.5);
    expect(calibration.jev.reliability.find(bucket => bucket.bucket === '0.7-0.8')).toMatchObject({
      count: 1, meanPredicted: 0.7, observedRate: 0,
    });
  });

  it('rejects a malformed line instead of dropping it', () => {
    expect(() => parseShadowRecordsJsonl('{"recordType":"other"}\n', 'x.jsonl')).toThrow(/x\.jsonl:1/);
  });

  it('renders the Markdown summary and writes the JSON report', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'decision-report-'));
    try {
      const out = path.join(dir, 'report.json');
      const markdown = runShadowReport(['--input', FIXTURE, '--out', out]);
      expect(markdown).toContain('| room.ambiguity | 3 | 2 | q 50.0% | 1000/1100 | 120/1500 |');
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ reportType: 'decision_backend_comparison' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
