import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cockpit = readFileSync(new URL('../components/accounting/AccountingCockpit.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../components/accounting/AccountingControls.svelte', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../components/accounting/UsageMetricCards.svelte', import.meta.url), 'utf8');
const chart = readFileSync(new URL('../components/accounting/UsageTimeSeries.svelte', import.meta.url), 'utf8');
const events = readFileSync(new URL('../components/accounting/UsageEventsTable.svelte', import.meta.url), 'utf8');

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

  it('renders explicit token/cost components plus an accessible graph and table', () => {
    for (const component of ['Input', 'Cache read', 'Cache write', 'Output']) {
      expect(metrics).toContain(`label: '${component}'`);
    }
    expect(chart).toMatch(/role="img"/);
    expect(chart).toMatch(/Time-series data table/);
  });

  it('renders both event orders from canonical nested attribution with intentional unknown handling', () => {
    expect(events).toMatch(/order === 'expensive'/);
    expect(events).toMatch(/Highest-cost calls/);
    expect(events).toMatch(/Recent calls/);
    expect(events).toMatch(/event\.attribution\.callType/);
    expect(events).toMatch(/event\.attribution\.purpose/);
    expect(events).toMatch(/event\.attribution\.toolName !== 'unknown'/);
    expect(events).toMatch(/event\.attribution\.chargeRunId !== 'unknown'/);
    expect(events).not.toMatch(/event\.(purpose|callType|toolName|chargeRunId)/);
  });
});
