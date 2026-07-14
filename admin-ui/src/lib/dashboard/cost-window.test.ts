import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  beginDashboardCostWindowSelection,
  commitDashboardCostWindowSelection,
  createDashboardCostWindowSelection,
  DASHBOARD_COST_WINDOW_OPTIONS,
  DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS,
  buildDashboardAccountingPath,
  buildDashboardCostWindowPath,
  rejectDashboardCostWindowSelection,
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

test('dashboard accounting drill-through carries the committed Today/Week/Month range', () => {
  assert.equal(buildDashboardAccountingPath('today'), '/charge-budget?tab=token-usage&range=today');
  assert.equal(buildDashboardAccountingPath('week'), '/charge-budget?tab=token-usage&range=week');
  assert.equal(buildDashboardAccountingPath('month'), '/charge-budget?tab=token-usage&range=month');

  const source = readFileSync(new URL('../../routes/+page.svelte', import.meta.url), 'utf8');
  assert.equal(
    source.match(/href=\{buildDashboardAccountingPath\(committedCostWindow\)\}/gu)?.length,
    2,
  );
});

test('dashboard refresh interval is bounded to fifteen seconds', () => {
  assert.equal(DASHBOARD_MODEL_USAGE_POLL_INTERVAL_MS, 15_000);
});

test('only the latest range request may publish a dashboard response', () => {
  assert.equal(shouldPublishDashboardResponse(2, 2), true);
  assert.equal(shouldPublishDashboardResponse(1, 2), false);
  assert.equal(shouldPublishDashboardResponse(3, 2), false);
});

test('a deferred range refresh keeps the committed label attached to the visible totals', () => {
  const initial = createDashboardCostWindowSelection('today');
  const deferredRefresh = beginDashboardCostWindowSelection(initial, 'week');

  assert.deepEqual(deferredRefresh, { committed: 'today', pending: 'week' });
  assert.equal(deferredRefresh.committed, 'today');
});

test('a rejected range refresh clears the pending range without relabeling the visible totals', () => {
  const initial = createDashboardCostWindowSelection('today');
  const deferredRefresh = beginDashboardCostWindowSelection(initial, 'month');
  const rejectedRefresh = rejectDashboardCostWindowSelection(deferredRefresh);

  assert.deepEqual(rejectedRefresh, { committed: 'today', pending: null });
});

test('a successful range refresh commits the response range', () => {
  const initial = createDashboardCostWindowSelection('today');
  const deferredRefresh = beginDashboardCostWindowSelection(initial, 'week');
  const committedRefresh = commitDashboardCostWindowSelection(deferredRefresh, 'week');

  assert.deepEqual(committedRefresh, { committed: 'week', pending: null });
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

test('dashboard page exposes durable usage transitions and refresh failures to assistive technology', () => {
  const source = readFileSync(new URL('../../routes/+page.svelte', import.meta.url), 'utf8');
  const liveRegion = source.match(/<p[^>]*role="status"[^>]*>[\s\S]*?<\/p>/)?.[0];

  assert.ok(liveRegion, 'expected a model-usage status live region');
  assert.match(liveRegion, /aria-live="polite"/);
  assert.match(liveRegion, /aria-atomic="true"/);
  assert.match(liveRegion, /modelUsageFreshness\.state/);
  assert.doesNotMatch(liveRegion, /formatFreshnessTimestamp/);
  assert.match(source, /aria-busy=\{costWindowLoading \|\| backgroundRefreshLoading\}/);
  assert.match(source, /role="alert"/);
});

test('dashboard page derives accounting labels from the committed range only', () => {
  const source = readFileSync(new URL('../../routes/+page.svelte', import.meta.url), 'utf8');

  assert.match(source, /costWindowSelection\.committed/);
  assert.match(source, /beginDashboardCostWindowSelection/);
  assert.match(source, /rejectDashboardCostWindowSelection/);
  assert.doesNotMatch(source, /selectedCostWindow\s*=\s*window/);
});
