import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../event-bus.js';
import type { RunChargeEvent } from '../contracts/runtime.js';
import { RunChargeLedger } from './charge-ledger.js';

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

describe('RunChargeLedger', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
});
