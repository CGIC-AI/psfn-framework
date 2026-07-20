import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cockpit = readFileSync(new URL('../components/accounting/AccountingCockpit.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../components/accounting/AccountingControls.svelte', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../components/accounting/UsageMetricCards.svelte', import.meta.url), 'utf8');
const byModelChart = readFileSync(new URL('../components/accounting/UsageByModelChart.svelte', import.meta.url), 'utf8');
const tokenChart = readFileSync(new URL('../components/accounting/TokenCompositionChart.svelte', import.meta.url), 'utf8');
const stackedBars = readFileSync(new URL('../components/accounting/charts/StackedBars.svelte', import.meta.url), 'utf8');
const events = readFileSync(new URL('../components/accounting/UsageEventsTable.svelte', import.meta.url), 'utf8');
const eventDetails = readFileSync(new URL('../components/accounting/UsageEventDetails.svelte', import.meta.url), 'utf8');

describe('operator accounting cockpit contract', () => {
  it('uses canonical APIs and preserves a stale last-known-good view', () => {
    expect(cockpit).toMatch(/getModelUsage/);
    expect(cockpit).toMatch(/getChargeCosts/);
    expect(cockpit).toMatch(/stale = usage !== null/);
    expect(cockpit).toMatch(/role="alert"/);
    expect(cockpit).toMatch(/aria-live="polite"/);
  });

  it('offers every range, URL persistence, declared dimensions, and filtered exports', () => {
    expect(controls).toMatch(/ACCOUNTING_RANGE_OPTIONS/);
    expect(controls).toMatch(/ACCOUNTING_DIMENSION_OPTIONS/);
    expect(cockpit).toMatch(/accountingStateFromSearchParams/);
    expect(cockpit).toMatch(/accountingStateToSearchParams/);
    expect(cockpit).toMatch(/downloadModelUsageExport/);
  });

  it('renders explicit token/cost components plus accessible model and token charts', () => {
    for (const field of [
      'totals.inputTokens',
      'totals.outputTokens',
      'totals.cacheReadTokens',
      'totals.cacheWriteTokens',
      'totals.providerCost.totalUsd',
      'totals.estimatedCost.totalUsd',
      'totals.averageTtftMs',
      'totals.averageDurationMs',
    ]) {
      expect(metrics).toContain(field);
    }
    expect(cockpit).toMatch(/seriesByDimension\?\.model/);
    expect(byModelChart).toMatch(/Usage by model/);
    expect(byModelChart).toMatch(/operator-visible detail/);
    expect(byModelChart).toMatch(/Time-series data table/);
    expect(tokenChart).toMatch(/Token composition/);
    for (const component of ['Input', 'Cache read', 'Cache write', 'Output']) {
      expect(tokenChart).toContain(`label: '${component}'`);
    }
    expect(stackedBars).toMatch(/aria-label={`Stacked usage by time bucket in \$\{timezone\}`}/);
    expect(stackedBars).toMatch(/aria-label="Chart series"/);
    expect(stackedBars).toMatch(/onkeydown=/);
  });

  it('wires headline sparklines and previous-period deltas to the applied usage response', () => {
    expect(cockpit).toMatch(/timeSeries=\{usage\.timeSeries\}/);
    expect(cockpit).toMatch(/previousPeriod=\{usage\.previousPeriod\}/);
    expect(metrics).toMatch(/import Sparkline/);
    expect(metrics).toMatch(/import TrendDelta/);

    for (const bucketMapping of [
      'bucket.effectiveCost.totalUsd',
      'bucket.calls',
      'bucket.totalTokens',
      'cacheHitRatePercent(bucket) ?? 0',
      'blendedCostPerMillionTokens(bucket) ?? 0',
      'bucket.averageDurationMs ?? 0',
    ]) {
      expect(metrics).toContain(bucketMapping);
    }

    const cards = [
      {
        headingId: 'effective-spend-heading',
        sparkline: 'spendTrend',
        current: 'totals.effectiveCost.totalUsd',
        previous: 'previousPeriod.totals.effectiveCost.totalUsd',
        inverted: true,
      },
      {
        headingId: 'requests-heading',
        sparkline: 'requestTrend',
        current: 'totals.calls',
        previous: 'previousPeriod.totals.calls',
        inverted: false,
      },
      {
        headingId: 'token-volume-heading',
        sparkline: 'tokenTrend',
        current: 'totals.totalTokens',
        previous: 'previousPeriod.totals.totalTokens',
        inverted: false,
      },
      {
        headingId: 'cache-hit-heading',
        sparkline: 'cacheHitTrend',
        current: 'cacheHitRate ?? Number.NaN',
        previous: 'previousCacheHitRate',
        inverted: false,
      },
      {
        headingId: 'blended-cost-heading',
        sparkline: 'blendedCostTrend',
        current: 'blendedCost ?? Number.NaN',
        previous: 'previousBlendedCost',
        inverted: true,
      },
      {
        headingId: 'latency-heading',
        sparkline: 'latencyTrend',
        current: 'totals.averageDurationMs ?? Number.NaN',
        previous: 'previousPeriod.totals.averageDurationMs',
        inverted: true,
      },
    ];

    for (const card of cards) {
      const start = metrics.indexOf(`aria-labelledby="${card.headingId}"`);
      const end = metrics.indexOf('</article>', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const source = metrics.slice(start, end);
      expect(source).toContain(`<Sparkline values={${card.sparkline}}`);
      expect(source).toContain(`current={${card.current}}`);
      expect(source).toContain(`previous={${card.previous}}`);
      expect(source).toMatch(/\{#if previousPeriod\}[\s\S]*<TrendDelta[\s\S]*\/>[\s\S]*\{\/if\}/);
      if (card.inverted) expect(source).toContain('invertPolarity');
      else expect(source).not.toContain('invertPolarity');
    }
  });

  it('renders both event orders from canonical nested attribution with intentional unknown handling', () => {
    expect(events).toMatch(/order === 'expensive'/);
    expect(events).toMatch(/Highest-cost calls/);
    expect(events).toMatch(/Recent calls/);
    expect(events).toMatch(/event\.attribution\.callType/);
    expect(events).toMatch(/event\.attribution\.purpose/);
    expect(events).toMatch(/event\.attribution\.toolName !== 'unknown'/);
    expect(events).toMatch(/UsageEventDetails/);
    expect(eventDetails).toMatch(/event\.attribution\.chargeRunId/);
    expect(eventDetails).toMatch(/detail\.value !== 'unknown'/);
    expect(events).not.toMatch(/event\.(purpose|callType|toolName|chargeRunId)/);
    expect(eventDetails).not.toMatch(/event\.(purpose|callType|toolName|chargeRunId)/);
  });
});
