import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  countDashboardTools,
  DASHBOARD_SECTIONS,
  filterDashboardTools,
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

test('dashboard section links resolve every visible deep link and reject unknown hashes', () => {
  assert.deepEqual(DASHBOARD_SECTIONS, [
    { id: 'overview', label: 'Overview', href: '#overview' },
    { id: 'health', label: 'Health', href: '#health' },
    { id: 'runtime', label: 'Runtime', href: '#runtime' },
  ]);
  assert.equal(resolveDashboardSection('#health'), 'health');
  assert.equal(resolveDashboardSection('#runtime'), 'runtime');
  assert.equal(resolveDashboardSection('#missing'), 'overview');
  assert.equal(resolveDashboardSection(''), 'overview');
});
