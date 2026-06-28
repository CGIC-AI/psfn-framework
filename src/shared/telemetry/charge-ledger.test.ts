import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus.js';
import type { RunChargeEvent } from '../contracts/runtime.js';
import type { ChargePolicyConfig } from '../contracts/charge-policy.js';
import { RunChargeLedger } from './charge-ledger.js';
import {
  chargeSurface,
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from './run-charge.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-charge-ledger-'));
  tempDirs.push(dir);
  return dir;
}

function makeEvent(overrides: Partial<RunChargeEvent> = {}): RunChargeEvent {
  return {
    timestampMs: 1_800_000_000_000,
    lane: 'interactive',
    surface: 'externalModelConsult',
    amount: 3,
    quota: 10,
    spentAfter: 3,
    remainingAfter: 7,
    lineage: {
      runId: 'run-a',
      rootRunId: 'run-a',
    },
    requestId: 'request-a',
    turnId: 'turn-a',
    callType: 'chat',
    purpose: 'test',
    details: {
      provider: 'openai',
      model: 'gpt-test-1',
      modality: 'text',
    },
    ...overrides,
  };
}

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

describe('RunChargeLedger', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    resetRunChargeRollingWindowForTests();
    vi.useRealTimers();
  });

  it('persists charge events to append-only JSONL and reloads history after restart', () => {
    const ledgerPath = join(makeTempDir(), 'state', 'charge-ledger.jsonl');
    const firstLedger = new RunChargeLedger(ledgerPath);
    firstLedger.recordChargeEvent(makeEvent());
    firstLedger.recordChargeEvent(makeEvent({
      timestampMs: 1_800_000_000_100,
      lane: 'background',
      amount: 4,
      quota: 20,
      spentAfter: 4,
      remainingAfter: 16,
      lineage: {
        runId: 'run-child',
        rootRunId: 'run-a',
        parentRunId: 'run-a',
      },
      surface: 'shardLaunch',
      details: {
        shardId: 'shard-1',
        model: 'gpt-test-2',
      },
    }));

    const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const rebootedLedger = new RunChargeLedger(ledgerPath);
    const data = rebootedLedger.getData();
    expect(data.activeRun?.runId).toBe('run-child');
    expect(data.aggregates.amount).toBe(7);
    expect(data.aggregates.byLane).toEqual([
      { key: 'background', amount: 4, eventCount: 1 },
      { key: 'interactive', amount: 3, eventCount: 1 },
    ]);
    expect(data.aggregates.byLineage).toEqual([
      { key: 'run-child', amount: 4, eventCount: 1 },
      { key: 'run-a', amount: 3, eventCount: 1 },
    ]);
    expect(data.recentRuns.map(run => run.runId)).toEqual(['run-child', 'run-a']);
    expect(data.recentRuns[0]).toEqual(expect.objectContaining({
      shardIds: ['shard-1'],
      models: ['gpt-test-2'],
      parentRunId: 'run-a',
    }));
  });

  it('subscribes to agent charge events without becoming a quota engine', async () => {
    const eventBus = new EventBus();
    const ledgerPath = join(makeTempDir(), 'charge-ledger.jsonl');
    const ledger = new RunChargeLedger(ledgerPath, eventBus);

    await eventBus.emit('agent.charge', makeEvent({
      amount: 12,
      quota: 10,
      spentAfter: 12,
      remainingAfter: 0,
    }));

    const data = ledger.getData();
    expect(data.aggregates.amount).toBe(12);
    expect(data.events[0].event.spentAfter).toBe(12);
    expect(data.events[0].event.quota).toBe(10);
  });

  it('hydrates rolling charge enforcement from persisted ledger events after restart', async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const ledgerPath = join(makeTempDir(), 'charge-ledger.jsonl');
    const firstLedger = new RunChargeLedger(ledgerPath, null, { now: () => nowMs });
    firstLedger.recordChargeEvent(makeEvent({
      timestampMs: nowMs - 60_000,
      amount: 2,
      quota: 3,
      spentAfter: 2,
      remainingAfter: 1,
    }));
    firstLedger.close();
    resetRunChargeRollingWindowForTests();

    const rebootedLedger = new RunChargeLedger(ledgerPath, null, { now: () => nowMs });
    await expect(runWithChargeContext({
      chargePolicy: makeChargePolicy(),
      lane: 'interactive',
      runId: 'root-after-restart',
    }, async () => {
      chargeSurface('externalModelConsult', { amount: 2 });
    })).rejects.toThrow('rolling 24-hour budget');
    rebootedLedger.close();
  });
});

describe('RunChargeLedger calendar accrual', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    resetRunChargeRollingWindowForTests();
    vi.useRealTimers();
  });

  // 1_800_000_000_000 = 2027-01-15T08:53:20Z
  const NOW_MS = 1_800_000_000_000;

  it('buckets spend per UTC calendar day and rolls up month-to-date', () => {
    const ledgerPath = join(makeTempDir(), 'charge-ledger.jsonl');
    const ledger = new RunChargeLedger(ledgerPath, null, { now: () => NOW_MS });

    // Two events today, one yesterday, one earlier in the month, one last month.
    ledger.recordChargeEvent(makeEvent({ timestampMs: NOW_MS - 60_000, amount: 3 }));
    ledger.recordChargeEvent(makeEvent({ timestampMs: NOW_MS - 30_000, amount: 2, lane: 'background' }));
    ledger.recordChargeEvent(makeEvent({ timestampMs: NOW_MS - 24 * 60 * 60_000, amount: 5 }));
    ledger.recordChargeEvent(makeEvent({ timestampMs: NOW_MS - 10 * 24 * 60 * 60_000, amount: 7 }));
    ledger.recordChargeEvent(makeEvent({ timestampMs: NOW_MS - 40 * 24 * 60 * 60_000, amount: 11 }));

    const { calendar } = ledger.getData();

    expect(calendar.monthKey).toBe('2027-01');
    expect(calendar.monthToDateAmount).toBe(3 + 2 + 5 + 7);
    expect(calendar.monthToDateEventCount).toBe(4);

    // Daily buckets cover the 31-day window only, most recent first.
    expect(calendar.daily.map(day => day.dayKey)).toEqual(['2027-01-15', '2027-01-14', '2027-01-05']);
    expect(calendar.daily[0].amount).toBe(5);
    expect(calendar.daily[0].eventCount).toBe(2);
    expect(calendar.daily[0].byLane.map(lane => lane.key).sort()).toEqual(['background', 'interactive']);
    expect(calendar.daily[1].amount).toBe(5);
    expect(calendar.daily[2].amount).toBe(7);
  });

  it('keeps calendar accrual stable regardless of the query filter', () => {
    const ledgerPath = join(makeTempDir(), 'charge-ledger.jsonl');
    const ledger = new RunChargeLedger(ledgerPath, null, { now: () => NOW_MS });
    ledger.recordChargeEvent(makeEvent({ timestampMs: NOW_MS - 60_000, amount: 3 }));
    ledger.recordChargeEvent(makeEvent({
      timestampMs: NOW_MS - 30_000,
      amount: 2,
      lineage: { runId: 'run-other', rootRunId: 'run-other' },
    }));

    const filtered = ledger.getData({ runId: 'run-other' });
    expect(filtered.aggregates.amount).toBe(2);
    expect(filtered.calendar.monthToDateAmount).toBe(5);
  });
});
