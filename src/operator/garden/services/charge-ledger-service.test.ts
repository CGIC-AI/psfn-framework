import { describe, expect, it, vi } from 'vitest';
import type { RunChargeLedger, RunChargeLedgerData } from '../../../shared/telemetry/charge-ledger.js';
import type { FatigueLedgerData } from '../../../shared/telemetry/fatigue-ledger.js';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
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
    events: [
      {
        schemaVersion: 1,
        recordType: 'fatigue_event',
        eventId: 'fatigue-1',
        recordedAtMs: Date.parse('2027-01-15T12:00:00Z'),
        event: {
          timestampMs: Date.parse('2027-01-15T12:00:00Z'),
          dayKey: '2027-01-15',
          localCompanionId: 'purrsephone',
          peerContactId: 'peer-mi',
          channelId: 'group-room',
          triggeringAuthor: {
            role: 'machine_intelligence',
            contactId: 'peer-mi',
            isMachineIntelligence: true,
          },
          peer: {
            contactId: 'peer-mi',
            isMachineIntelligence: true,
          },
          amount: 1,
          decision: 'charged',
          reason: 'machine_intelligence_response',
          spentAfter: 1,
          remainingAllowance: 0,
          allowance: 1,
          softLimit: 1,
          softState: 'soft_limit_reached',
          hardState: 'exhausted',
          details: {
            channelSetting: 'busy_human_group',
            enforcementDecision: 'allowed_charged',
          },
        },
      },
      {
        schemaVersion: 1,
        recordType: 'fatigue_event',
        eventId: 'fatigue-2',
        recordedAtMs: Date.parse('2027-01-15T12:01:00Z'),
        event: {
          timestampMs: Date.parse('2027-01-15T12:01:00Z'),
          dayKey: '2027-01-15',
          localCompanionId: 'purrsephone',
          peerContactId: 'peer-mi',
          channelId: 'group-room',
          triggeringAuthor: {
            role: 'machine_intelligence',
            contactId: 'peer-mi',
            isMachineIntelligence: true,
          },
          peer: {
            contactId: 'peer-mi',
            isMachineIntelligence: true,
          },
          amount: 1,
          decision: 'overcharge',
          reason: 'overcharge_recent_human_participation',
          spentAfter: 2,
          remainingAllowance: 0,
          allowance: 1,
          softLimit: 1,
          softState: 'soft_limit_reached',
          hardState: 'exhausted',
          details: {
            channelSetting: 'busy_human_group',
            enforcementDecision: 'overcharge_charged',
            recentHumanParticipation: true,
          },
        },
      },
    ],
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
    const service = new AdminChargeLedgerDataService(
      chargeLedger as unknown as RunChargeLedger,
      fatigueLedger,
      makeTestFatiguePolicyConfig(),
    );

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
    expect(data.fatigueTuning?.recommendations.find(
      recommendation => recommendation.channelSetting === 'busy_human_group',
    )).toEqual(expect.objectContaining({
      action: 'collect_more_data',
      metrics: expect.objectContaining({
        overchargeEventCount: 1,
      }),
    }));
  });
});
