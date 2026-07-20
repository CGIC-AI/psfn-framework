import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({ apiGet: vi.fn(), apiDownload: vi.fn() }));
import { buildChargeCostsPath } from './charge-costs';
import { buildModelUsagePath, buildModelUsageExportPath } from './model-usage';
import { buildFleetModelUsagePath } from './fleet-model-usage';
import { scopeGardenDataPath } from '../../fleet/companion-scope';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';

describe('accounting endpoint paths', () => {
  it('serializes every canonical model-usage query field used by operator drill-downs', () => {
    const path = buildModelUsagePath({
      range: 'month',
      timezone: 'America/New_York',
      chargeEventId: 'charge-1',
      groupBy: ['model', 'chargeLane'],
    });
    const url = new URL(path, 'http://garden.local');

    expect(url.pathname).toBe('/api/admin/model-usage');
    expect(url.searchParams.get('chargeEventId')).toBe('charge-1');
    expect(url.searchParams.get('groupBy')).toBe('model,chargeLane');
  });

  it('uses the same filtered query for JSON and CSV export', () => {
    const query = {
      range: 'week' as const,
      timezone: 'America/New_York',
      model: 'gpt-5',
      status: 'failure' as const,
    };
    const csv = new URL(buildModelUsageExportPath('csv', query), 'http://garden.local');
    const json = new URL(buildModelUsageExportPath('json', query), 'http://garden.local');

    expect(buildModelUsageExportPath('csv', query))
      .toContain('timezone=America/New_York');
    expect(csv.searchParams.get('model')).toBe('gpt-5');
    expect(csv.searchParams.get('status')).toBe('failure');
    expect(json.searchParams.get('model')).toBe('gpt-5');
    expect(json.searchParams.get('status')).toBe('failure');
    expect(csv.searchParams.get('format')).toBe('csv');
    expect(json.searchParams.get('format')).toBe('json');
  });

  it('serializes the canonical charge-cost reconciliation scope', () => {
    const path = buildChargeCostsPath({
      sinceMs: 100,
      untilMs: 200,
      companionId: 'companion-a',
      lane: 'interactive',
      surface: 'externalModelConsult',
      runId: 'run-1',
    });
    const url = new URL(path, 'http://garden.local');

    expect(url.pathname).toBe('/api/admin/charge-costs');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sinceMs: '100',
      untilMs: '200',
      companionId: 'companion-a',
      lane: 'interactive',
      surface: 'externalModelConsult',
      runId: 'run-1',
    });
  });

  it('scopes timezone-filtered token and fleet usage endpoints as canonical Garden paths', () => {
    const pathname = `/companions/${COMPANION_A}/garden/charge-budget`;
    expect(scopeGardenDataPath(buildModelUsagePath({
      range: 'month',
      timezone: 'America/New_York',
    }), pathname)).toBe(
      `/companions/${COMPANION_A}/garden/api/admin/model-usage`
        + '?range=month&timezone=America/New_York',
    );
    expect(scopeGardenDataPath(buildFleetModelUsagePath({
      range: 'month',
      timezone: 'America/New_York',
    }), pathname)).toBe(
      `/companions/${COMPANION_A}/garden/api/admin/fleet-model-usage`
        + '?range=month&timezone=America/New_York',
    );
    expect(scopeGardenDataPath(buildModelUsagePath({ timezone: 'UTC' }), pathname))
      .toBe(`/companions/${COMPANION_A}/garden/api/admin/model-usage?timezone=UTC`);
    expect(() => scopeGardenDataPath(buildModelUsagePath({
      timezone: 'Not/A_Timezone',
    }), pathname)).toThrow(/one canonical root-absolute path/u);
  });
});
