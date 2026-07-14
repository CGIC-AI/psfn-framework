import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DASHBOARD_COST_WINDOW_OPTIONS,
  DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS,
  buildDashboardCostWindowPath,
  resolveDashboardCostWindow,
  shouldPublishDashboardResponse,
} from './cost-window';

test('resolveDashboardCostWindow fails closed to today for unknown values', () => {
  assert.equal(resolveDashboardCostWindow(undefined), 'today');
  assert.equal(resolveDashboardCostWindow(null), 'today');
  assert.equal(resolveDashboardCostWindow('invalid-window'), 'today');
  assert.equal(resolveDashboardCostWindow('today'), 'today');
  assert.equal(resolveDashboardCostWindow('week'), 'week');
  assert.equal(resolveDashboardCostWindow('month'), 'month');
});

test('dashboard cost window options expose Today/Week/Month selector order', () => {
  assert.deepEqual(
    DASHBOARD_COST_WINDOW_OPTIONS.map((option) => option.value),
    ['today', 'week', 'month'],
  );
});

test('buildDashboardCostWindowPath includes validated costWindow query parameter', () => {
  assert.equal(buildDashboardCostWindowPath('today'), '/api/admin/dashboard?costWindow=today');
  assert.equal(buildDashboardCostWindowPath('week'), '/api/admin/dashboard?costWindow=week');
  assert.equal(buildDashboardCostWindowPath('month'), '/api/admin/dashboard?costWindow=month');
});

test('dashboard refresh interval is bounded to fifteen seconds', () => {
  assert.equal(DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS, 15_000);
});

test('only the latest range request may publish a dashboard response', () => {
  assert.equal(shouldPublishDashboardResponse(2, 2), true);
  assert.equal(shouldPublishDashboardResponse(1, 2), false);
  assert.equal(shouldPublishDashboardResponse(3, 2), false);
});

test('dashboard page polls durable usage and renders unavailable/stale states without a plausible zero', () => {
  const source = readFileSync(new URL('../../routes/+page.svelte', import.meta.url), 'utf8');

  assert.match(source, /setInterval\(\(\) =>/);
  assert.match(source, /DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS/);
  assert.match(source, /stats\.modelUsage\.usage/);
  assert.match(source, /modelUsageFreshness\.state/);
  assert.match(source, />Unavailable</);
  assert.doesNotMatch(source, /stats\.sessionUsage/);
});
