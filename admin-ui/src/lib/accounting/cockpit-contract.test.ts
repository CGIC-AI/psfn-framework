import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cockpit = readFileSync(new URL('../components/accounting/AccountingCockpit.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../components/accounting/AccountingControls.svelte', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../components/accounting/UsageMetricCards.svelte', import.meta.url), 'utf8');
const chart = readFileSync(new URL('../components/accounting/UsageTimeSeries.svelte', import.meta.url), 'utf8');
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

  it('preserves token, cache, cost-source, and latency context beside accessible graphs', () => {
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
    expect(chart).toMatch(/role="img"/);
    expect(chart).toMatch(/Time-series data table/);
  });

  it('wires headline sparklines and previous-period deltas to the applied usage response', () => {
    expect(cockpit).toMatch(/timeSeries=\{usage\.timeSeries\}/);
    expect(cockpit).toMatch(/previousPeriod=\{usage\.previousPeriod\}/);
    expect(metrics).toMatch(/import Sparkline/);
    expect(metrics).toMatch(/import TrendDelta/);
    expect(metrics).toMatch(/\{#if previousPeriod\}/);
    for (const label of [
      'Effective spend',
      'Requests',
      'Token volume',
      'Cache hit rate',
      'Blended $/1M',
      'Latency',
    ]) {
      expect(metrics).toContain(`>${label}</p>`);
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
