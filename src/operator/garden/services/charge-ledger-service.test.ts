import { describe, expect, it, vi } from 'vitest';
import type { RunChargeLedger, RunChargeLedgerData } from '../../../shared/telemetry/charge-ledger.js';
import type { FatigueLedgerData } from '../../../shared/telemetry/fatigue-ledger.js';
import { AdminChargeLedgerDataService } from './charge-ledger-service.js';

function makeChargeData(): RunChargeLedgerData {
  return {
    activeRun: null,
    recentRuns: [],
    aggregates: {
      amount: 0,
      eventCount: 0,
      byLane: [],
      bySurface: [],
      byLineage: [],
    },
    events: [],
  };
}

function makeFatigueData(): FatigueLedgerData {
  return {
    aggregates: {
      amount: 2,
      eventCount: 2,
      byChannel: [
        { key: 'group-room', amount: 2, eventCount: 2 },
      ],
      byPeer: [
        { key: 'peer-mi', amount: 2, eventCount: 2 },
      ],
      byDay: [
        { key: '2027-01-15', amount: 2, eventCount: 2 },
      ],
      byDecision: [
        { key: 'charged', amount: 1, eventCount: 1 },
        { key: 'overcharge', amount: 1, eventCount: 1 },
      ],
      scopes: [
        {
          localCompanionId: 'purrsephone',
          peerContactId: 'peer-mi',
          channelId: 'group-room',
          dayKey: '2027-01-15',
          amount: 2,
          eventCount: 2,
          chargedEventCount: 1,
          overchargeEventCount: 1,
          freeEventCount: 0,
        },
      ],
    },
    events: [],
  };
}

describe('AdminChargeLedgerDataService', () => {
  it('returns fatigue ledger data alongside charge data with overcharge distinguishable', async () => {
    const chargeLedger = {
      getData: vi.fn(() => makeChargeData()),
    };
    const fatigueLedger = {
      getData: vi.fn(() => makeFatigueData()),
    };
    const service = new AdminChargeLedgerDataService(chargeLedger as unknown as RunChargeLedger, fatigueLedger);

    const data = await service.getChargeLedgerData({ limit: 20, runId: 'run-a' });

    expect(chargeLedger.getData).toHaveBeenCalledWith({ limit: 20, runId: 'run-a' });
    expect(fatigueLedger.getData).toHaveBeenCalledWith({ limit: 20, runId: 'run-a' });
    expect(data.fatigue?.aggregates.byDecision).toEqual([
      { key: 'charged', amount: 1, eventCount: 1 },
      { key: 'overcharge', amount: 1, eventCount: 1 },
    ]);
    expect(data.fatigue?.aggregates.scopes[0]).toEqual(expect.objectContaining({
      chargedEventCount: 1,
      overchargeEventCount: 1,
    }));
  });
});
