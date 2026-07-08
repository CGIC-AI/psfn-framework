import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunChargeEvent } from '../contracts/runtime.js';
import type { ChargePolicyConfig } from '../contracts/charge-policy.js';
import {
  chargeSurface,
  getRunChargeRollingWindowSnapshot,
  getRunChargeSnapshot,
  hydrateRunChargeRollingWindowFromEvents,
  resetRunChargeRollingWindowForTests,
  RUN_CHARGE_ROLLING_WINDOW_MS,
  runWithChargeContext,
} from './run-charge.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';

const NOW_MS = 1_800_000_000_000;

function makeChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 3,
      background: 3,
      maintenance: 0,
      subagent: 3,
      shard: 12,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 3,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

function makeEventBus(events: RunChargeEvent[]): { emit: (eventName: 'agent.charge', event: RunChargeEvent) => Promise<void> } {
  return {
    emit: vi.fn(async (_eventName: 'agent.charge', event: RunChargeEvent) => {
      events.push(event);
    }),
  };
}

describe('run charge rolling window', () => {
  afterEach(() => {
    resetRunChargeRollingWindowForTests();
    vi.useRealTimers();
  });

  it('shares the rolling 24-hour lane budget across separate root invocations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const events: RunChargeEvent[] = [];
    const eventBus = makeEventBus(events);
    const chargePolicy = makeChargePolicy();

    await runWithChargeContext({
      chargePolicy,
      eventBus,
      lane: 'interactive',
      runId: 'root-a',
    }, async () => {
      chargeSurface('externalModelConsult', { amount: 2 });
    });

    const secondSnapshot = await runWithChargeContext({
      chargePolicy,
      eventBus,
      lane: 'interactive',
      runId: 'root-b',
    }, async () => {
      const event = chargeSurface('externalModelConsult', { amount: 1 });
      return {
        event,
        snapshot: getRunChargeSnapshot(),
      };
    });

    expect(secondSnapshot.snapshot?.quotaSpentByLane.interactive).toBe(1);
    expect(secondSnapshot.event?.spentAfter).toBe(3);
    expect(events.map(event => event.spentAfter)).toEqual([2, 3]);

    await expect(runWithChargeContext({
      chargePolicy,
      eventBus,
      lane: 'interactive',
      runId: 'root-c',
    }, async () => {
      chargeSurface('externalModelConsult', { amount: 1 });
    })).rejects.toThrow('rolling 24-hour budget');
  });

  it('charges nested shard contexts against the same rolling deployment budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const chargePolicy = makeChargePolicy();

    await runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'root-a',
    }, async () => {
      await runWithChargeContext({
        lane: 'shard',
        runId: 'shard-a',
      }, async () => {
        chargeSurface('shardLaunch');
      });
    });

    await expect(runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'root-b',
    }, async () => runWithChargeContext({
      lane: 'shard',
      runId: 'shard-b',
    }, async () => {
      chargeSurface('shardLaunch');
    }))).rejects.toThrow('rolling 24-hour budget');
  });

  it('releases spend after it leaves the rolling 24-hour window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const chargePolicy = makeChargePolicy();

    await runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'root-a',
    }, async () => {
      chargeSurface('externalModelConsult', { amount: 3 });
    });

    vi.setSystemTime(NOW_MS + RUN_CHARGE_ROLLING_WINDOW_MS - 1);
    await expect(runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'root-b',
    }, async () => {
      chargeSurface('externalModelConsult', { amount: 1 });
    })).rejects.toThrow('rolling 24-hour budget');

    vi.setSystemTime(NOW_MS + RUN_CHARGE_ROLLING_WINDOW_MS + 1);
    const event = await runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'root-c',
    }, async () => chargeSurface('externalModelConsult', { amount: 1 }));

    expect(event?.spentAfter).toBe(1);
    expect(event?.remainingAfter).toBe(2);
  });

  it('counts both of two identical charges instead of collapsing them by content', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const events: RunChargeEvent[] = [];
    const eventBus = makeEventBus(events);
    const chargePolicy = makeChargePolicy();

    await runWithChargeContext({
      chargePolicy,
      eventBus,
      lane: 'interactive',
      runId: 'root-a',
    }, async () => {
      // Same run, surface, amount, correlation, and (fake-timer frozen)
      // timestamp: identical metadata, two legitimate spends.
      chargeSurface('externalModelConsult', { amount: 1 });
      chargeSurface('externalModelConsult', { amount: 1 });
    });

    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.eventId)).size).toBe(2);
    const window = getRunChargeRollingWindowSnapshot(NOW_MS);
    expect(window.entryCount).toBe(2);
    expect(window.spentByLane.interactive).toBe(2);
  });

  it('dedupes rehydrated events by eventId without dropping identical charges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const events: RunChargeEvent[] = [];
    const eventBus = makeEventBus(events);
    const chargePolicy = makeChargePolicy();

    await runWithChargeContext({
      chargePolicy,
      eventBus,
      lane: 'interactive',
      runId: 'root-a',
    }, async () => {
      chargeSurface('externalModelConsult', { amount: 1 });
      chargeSurface('externalModelConsult', { amount: 1 });
    });

    // Rehydrating the same persisted events (exact identity) must not double
    // count them against the live rolling window.
    hydrateRunChargeRollingWindowFromEvents(events, NOW_MS);
    const window = getRunChargeRollingWindowSnapshot(NOW_MS);
    expect(window.entryCount).toBe(2);
    expect(window.spentByLane.interactive).toBe(2);
  });

  it('fails closed when a charge event is missing its eventId', () => {
    const events: RunChargeEvent[] = [{
      timestampMs: NOW_MS,
      lane: 'interactive',
      surface: 'externalModelConsult',
      amount: 1,
      quota: 3,
      spentAfter: 1,
      remainingAfter: 2,
      lineage: { runId: 'root-a', rootRunId: 'root-a' },
    } as unknown as RunChargeEvent];

    expect(() => hydrateRunChargeRollingWindowFromEvents(events, NOW_MS))
      .toThrow('eventId is required');
  });
});
