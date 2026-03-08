import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DASHBOARD_COST_WINDOW_OPTIONS,
  buildDashboardCostWindowPath,
  resolveDashboardCostWindow,
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
