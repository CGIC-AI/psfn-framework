import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunChargeEvent } from '../../../shared/contracts/runtime.js';
import type { RunChargeLedgerData } from '../../../shared/telemetry/charge-ledger.js';
import {
  AdminAuditHistoryDataService,
  GardenAuditHistoryJsonlStore,
  type GatewayAuditHistoryReader,
} from './audit-history-service.js';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-garden-audit-history-'));
  tempDirs.push(dir);
  return dir;
}

function makeChargeEvent(overrides: Partial<RunChargeEvent> = {}): RunChargeEvent {
  return {
    timestampMs: 1_700_000_000_300,
    lane: 'interactive',
    surface: 'externalModelConsult',
    amount: 2,
    quota: 10,
    spentAfter: 2,
    remainingAfter: 8,
    lineage: {
      runId: 'run-a',
      rootRunId: 'run-a',
    },
    details: {
      provider: 'openrouter',
      model: 'test/model',
    },
    ...overrides,
  };
}

describe('AdminAuditHistoryDataService', () => {
  it('merges persisted Garden audit, gateway audit, and charge ledger history with paging', async () => {
    const dir = makeTempDir();
    const gardenStore = new GardenAuditHistoryJsonlStore(join(dir, 'garden-audit-history.jsonl'));
    const gatewayReader: GatewayAuditHistoryReader = vi.fn(() => ({
      entries: [
        {
          id: 7,
          timestamp: 1_700_000_000_200,
          method: 'fs.write',
          decision: 'DENY',
          paramsJson: '{"path":"/blocked"}',
          durationMs: 4,
          error: 'policy denied',
        },
      ],
      total: 1,
      limit: 2_000,
      offset: 0,
    }));
    const chargeLedger = {
      getData: vi.fn(async (): Promise<RunChargeLedgerData> => ({
        activeRun: null,
        recentRuns: [],
        aggregates: {
          amount: 2,
          eventCount: 1,
          byLane: [],
          bySurface: [],
          byLineage: [],
        },
        events: [
          {
            schemaVersion: 1,
            recordType: 'charge_event',
            eventId: 'charge-1',
            recordedAtMs: 1_700_000_000_301,
            event: makeChargeEvent(),
            metadata: {
              provider: 'openrouter',
              model: 'test/model',
            },
          },
        ],
      })),
    };
    const service = new AdminAuditHistoryDataService({
      gardenStore,
      gatewayReader,
      chargeLedger,
      now: () => 1_700_000_000_500,
    });

    service.appendGardenEntry({
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'Operator updated runtime settings.',
      actor: 'operator',
      timestamp: 1_700_000_000_100,
    });

    const data = await service.getAuditHistory({
      timeRange: 'all',
      limit: 2,
      offset: 0,
    });

    expect(data.pagination).toMatchObject({
      limit: 2,
      offset: 0,
      total: 3,
      hasNext: true,
    });
    expect(data.entries.map(entry => entry.source)).toEqual(['charge', 'gateway']);
    expect(data.entries[0]).toMatchObject({
      actionType: 'charge_decision',
      decision: 'allowed',
    });
    expect(data.entries[1]).toMatchObject({
      actionType: 'gateway_policy',
      decision: 'denied',
    });
  });

  it('filters historical audit rows by source, action type, decision, and text', async () => {
    const dir = makeTempDir();
    const service = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, 'garden-audit-history.jsonl')),
      gatewayReader: null,
      chargeLedger: null,
      now: () => 1_700_000_000_500,
    });

    service.appendGardenEntry({
      actionType: 'confirmation',
      decision: 'denied',
      narrative: 'Operator resolved confirmation abc: denied.',
      actor: 'operator',
      timestamp: 1_700_000_000_200,
    });
    service.appendGardenEntry({
      actionType: 'tool_activation',
      decision: 'allowed',
      narrative: 'Adaptive tool "repo_diff" was activated.',
      actor: 'companion',
      timestamp: 1_700_000_000_100,
    });

    const data = await service.getAuditHistory({
      source: 'garden',
      actionType: 'confirmation',
      decision: 'denied',
      query: 'abc',
      timeRange: 'all',
    });

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({
      actionType: 'confirmation',
      decision: 'denied',
      actor: 'operator',
    });
  });
});
