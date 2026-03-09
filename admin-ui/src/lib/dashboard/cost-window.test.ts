import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DASHBOARD_COST_WINDOW_OPTIONS,
  buildDashboardCostWindowPath,
  normalizeDashboardCostWindowTotals,
  resolveDashboardCostWindow,
  resolveSelectedDashboardCostWindowUsage,
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

test('normalizeDashboardCostWindowTotals fails closed for partial/malformed payloads', () => {
  assert.deepEqual(
    normalizeDashboardCostWindowTotals({
      today: {
        turns: 3,
        llmCalls: 5,
        toolCalls: 2,
        estimatedCostUsd: 0.1234,
      },
      week: {
        turns: undefined,
        llmCalls: Number.NaN,
        toolCalls: -4,
        estimatedCostUsd: '0.8',
      },
    }),
    {
      today: {
        turns: 3,
        llmCalls: 5,
        toolCalls: 2,
        estimatedCostUsd: 0.1234,
      },
      week: {
        turns: 0,
        llmCalls: 0,
        toolCalls: 0,
        estimatedCostUsd: 0,
      },
      month: {
        turns: 0,
        llmCalls: 0,
        toolCalls: 0,
        estimatedCostUsd: 0,
      },
    },
  );
});

test('resolveSelectedDashboardCostWindowUsage fails closed when selected window data is missing', () => {
  assert.deepEqual(
    resolveSelectedDashboardCostWindowUsage(
      {
        today: {
          turns: 1,
          llmCalls: 1,
          toolCalls: 0,
          estimatedCostUsd: 0.01,
        },
      },
      'month',
    ),
    {
      turns: 0,
      llmCalls: 0,
      toolCalls: 0,
      estimatedCostUsd: 0,
    },
  );
});
