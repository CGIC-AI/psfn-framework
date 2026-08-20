import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  countDashboardTools,
  DASHBOARD_SECTIONS,
  filterDashboardTools,
  memorySharePercent,
  resolveDashboardSection,
  type DashboardTool,
} from './dashboard-view';

const tools: DashboardTool[] = [
  { name: 'memory', status: 'healthy' },
  { name: 'notify', status: 'unavailable', detail: 'no heartbeat' },
  { name: 'session', status: 'degraded', detail: 'high latency' },
  { name: 'vault', status: 'not_applicable', detail: 'not provisioned' },
];

test('countDashboardTools preserves every canonical health state', () => {
  assert.deepEqual(countDashboardTools(tools), {
    healthy: 1,
    degraded: 1,
    unavailable: 1,
    notApplicable: 1,
  });
});

test('filterDashboardTools shows issues first without losing all-tools access', () => {
  assert.deepEqual(
    filterDashboardTools(tools, 'issues', '').map((tool) => tool.name),
    ['notify', 'session', 'vault'],
  );
  assert.deepEqual(
    filterDashboardTools(tools, 'all', '').map((tool) => tool.name),
    ['memory', 'notify', 'session', 'vault'],
  );
});

test('filterDashboardTools searches names, statuses, and live detail case-insensitively', () => {
  assert.deepEqual(
    filterDashboardTools(tools, 'all', 'HEARTBEAT').map((tool) => tool.name),
    ['notify'],
  );
  assert.deepEqual(
    filterDashboardTools(tools, 'all', 'not_applicable').map((tool) => tool.name),
    ['vault'],
  );
});

test('memorySharePercent is finite and bounded for unavailable or inconsistent totals', () => {
  assert.equal(memorySharePercent(25, 100), 25);
  assert.equal(memorySharePercent(200, 100), 100);
  assert.equal(memorySharePercent(25, 0), 0);
  assert.equal(memorySharePercent(Number.NaN, 100), 0);
});

test('dashboard section links resolve every visible deep link and reject unknown hashes', () => {
  assert.deepEqual(DASHBOARD_SECTIONS, [
    { id: 'overview', label: 'Overview', href: '#overview' },
    { id: 'health', label: 'Health', href: '#health' },
    { id: 'memory', label: 'Memory', href: '#memory' },
    { id: 'cost', label: 'Cost', href: '#cost' },
    { id: 'traces', label: 'Traces', href: '#traces' },
  ]);
  assert.equal(resolveDashboardSection('#memory'), 'memory');
  assert.equal(resolveDashboardSection('#traces'), 'traces');
  assert.equal(resolveDashboardSection('#missing'), 'overview');
  assert.equal(resolveDashboardSection(''), 'overview');
});
