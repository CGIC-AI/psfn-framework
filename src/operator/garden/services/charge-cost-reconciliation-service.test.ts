import { describe, expect, it, vi } from 'vitest';
import type { RunChargeEvent } from '../../../shared/contracts/runtime.js';
import type { RunChargeLedgerEntry } from '../../../shared/telemetry/charge-ledger.js';
import type { ModelUsageEvent } from '../../../shared/telemetry/model-usage.js';
import { normalizeModelUsageAttribution } from '../../../shared/telemetry/model-usage-attribution.js';
import { AdminChargeCostReconciliationDataService } from './charge-cost-reconciliation-service.js';

function chargeEntry(): RunChargeLedgerEntry {
  const event: RunChargeEvent = {
    eventId: 'charge-1',
    timestampMs: 150,
    lane: 'interactive',
    surface: 'externalModelConsult',
    amount: 2,
    quota: 10,
    spentAfter: 2,
    remainingAfter: 8,
    lineage: { runId: 'run-1', rootRunId: 'root-1' },
    companionId: 'companion-a',
    channelId: 'channel-a',
  };
  return {
    schemaVersion: 1,
    recordType: 'charge_event',
    eventId: event.eventId,
    recordedAtMs: event.timestampMs,
    event,
  };
}

function usageEvent(): ModelUsageEvent {
  return {
    id: 'usage-1',
    logicalCallId: 'logical-1',
    attempt: 1,
    recordedAtMs: 160,
    startedAtMs: 140,
    dayKey: '1970-01-01',
    monthKey: '1970-01',
    status: 'success',
    settlement: 'complete',
    callKind: 'chat',
    attribution: normalizeModelUsageAttribution({
      companionId: 'companion-a',
      channelId: 'channel-a',
      callType: 'chat',
      purpose: 'test',
      chargeEventId: 'charge-1',
      chargeLane: 'interactive',
      chargeSurface: 'externalModelConsult',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-1',
    }),
    provider: 'provider-a',
    model: 'model-a',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    providerCostUsd: 0.5,
    effectiveCostUsd: 0.5,
    providerCost: { total: 0.5, currency: 'USD' },
    estimatedCost: {},
    effectiveCost: { total: 0.5, currency: 'USD' },
    costSource: 'provider',
    metadata: {},
  };
}

describe('AdminChargeCostReconciliationDataService', () => {
  it('reconciles the complete original ledgers under the Garden tenant', async () => {
    const listReconciliationEntries = vi.fn(() => [chargeEntry()]);
    const getUsageEventsForReconciliation = vi.fn(async () => [usageEvent()]);
    const service = new AdminChargeCostReconciliationDataService(
      { listReconciliationEntries },
      { getUsageEventsForReconciliation },
      'companion-a',
    );

    const data = await service.getChargeCostReconciliation({
      sinceMs: 100,
      untilMs: 200,
      channelId: 'channel-a',
      lane: 'interactive',
      surface: 'externalModelConsult',
      runId: 'run-1',
      rootRunId: 'root-1',
    });

    expect(listReconciliationEntries).toHaveBeenCalledWith({ sinceMs: 100, untilMs: 200 });
    expect(getUsageEventsForReconciliation).toHaveBeenCalledWith({
      sinceMs: 100,
      untilMs: 200,
      companionId: 'companion-a',
      channelId: 'channel-a',
      chargeLane: 'interactive',
      chargeSurface: 'externalModelConsult',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-1',
    });
    expect(data.buckets.attributable).toMatchObject({
      chargeUnits: 2,
      calls: 1,
      effectiveCostUsd: 0.5,
      dollarsPerChargeUnit: 0.25,
    });
  });

  it('fails closed when a query asks for another companion tenant', async () => {
    const service = new AdminChargeCostReconciliationDataService(
      { listReconciliationEntries: vi.fn(() => []) },
      { getUsageEventsForReconciliation: vi.fn(async () => []) },
      'companion-a',
    );

    await expect(service.getChargeCostReconciliation({ companionId: 'companion-b' }))
      .rejects.toThrow('outside the reconciliation tenant');
  });
});
