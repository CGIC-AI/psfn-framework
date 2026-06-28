import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FatigueBudgetEvent } from '../contracts/runtime.js';
import { EventBus } from '../event-bus.js';
import { FatigueLedger } from './fatigue-ledger.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-fatigue-ledger-'));
  tempDirs.push(dir);
  return dir;
}

function makeEvent(overrides: Partial<FatigueBudgetEvent> = {}): FatigueBudgetEvent {
  return {
    timestampMs: Date.parse('2027-01-15T12:00:00.000Z'),
    dayKey: '2027-01-15',
    localCompanionId: 'purrsephone',
    peerContactId: 'artemis',
    channelId: 'dm-artemis',
    triggeringAuthor: {
      role: 'machine_intelligence',
      contactId: 'artemis',
      isMachineIntelligence: true,
    },
    peer: {
      contactId: 'artemis',
      isMachineIntelligence: true,
    },
    amount: 1,
    decision: 'charged',
    reason: 'machine_intelligence_response',
    spentAfter: 1,
    remainingAllowance: 2,
    allowance: 3,
    softLimit: 2,
    softState: 'clear',
    hardState: 'available',
    requestId: 'req-a',
    turnId: 'turn-a',
    callType: 'chat',
    purpose: 'assistant_response',
    lineage: {
      runId: 'run-a',
      rootRunId: 'run-a',
    },
    details: {
      source: 'unit-test',
    },
    ...overrides,
  };
}

describe('FatigueLedger', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists fatigue events to JSONL and reloads audit history', () => {
    const ledgerPath = join(makeTempDir(), 'state', 'fatigue-ledger.jsonl');
    const ledger = new FatigueLedger(ledgerPath, null, {
      now: () => Date.parse('2027-01-15T12:00:01.000Z'),
    });
    ledger.recordFatigueEvent(makeEvent());
    ledger.recordFatigueEvent(makeEvent({
      timestampMs: Date.parse('2027-01-15T12:05:00.000Z'),
      amount: 0,
      decision: 'free',
      reason: 'triggering_author_not_machine_intelligence',
      triggeringAuthor: {
        role: 'human',
        contactId: 'human-1',
        isMachineIntelligence: false,
      },
      spentAfter: 1,
      remainingAllowance: 2,
      requestId: 'req-human',
    }));

    const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const rebooted = new FatigueLedger(ledgerPath);
    const events = rebooted.listFatigueEvents({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'dm-artemis',
      dayKey: '2027-01-15',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      decision: 'free',
      amount: 0,
      requestId: 'req-human',
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      decision: 'charged',
      amount: 1,
      requestId: 'req-a',
      lineage: {
        runId: 'run-a',
        rootRunId: 'run-a',
      },
    }));
  });

  it('filters and summarizes by channel, peer, day, decision, and run lineage', () => {
    const ledgerPath = join(makeTempDir(), 'fatigue-ledger.jsonl');
    const ledger = new FatigueLedger(ledgerPath);
    ledger.recordFatigueEvent(makeEvent({
      channelId: 'chan-a',
      requestId: 'req-a1',
    }));
    ledger.recordFatigueEvent(makeEvent({
      timestampMs: Date.parse('2027-01-15T12:01:00.000Z'),
      channelId: 'chan-a',
      amount: 0,
      decision: 'free',
      reason: 'triggering_author_not_machine_intelligence',
      triggeringAuthor: {
        role: 'human',
        contactId: 'human-1',
      },
      spentAfter: 1,
      remainingAllowance: 2,
      requestId: 'req-a2',
    }));
    ledger.recordFatigueEvent(makeEvent({
      timestampMs: Date.parse('2027-01-15T12:02:00.000Z'),
      channelId: 'chan-b',
      spentAfter: 1,
      requestId: 'req-b1',
      lineage: {
        runId: 'run-child',
        rootRunId: 'run-a',
        parentRunId: 'run-a',
      },
    }));
    ledger.recordFatigueEvent(makeEvent({
      timestampMs: Date.parse('2027-01-16T01:00:00.000Z'),
      dayKey: '2027-01-16',
      channelId: 'chan-a',
      peerContactId: 'borealis',
      peer: {
        contactId: 'borealis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'borealis',
        isMachineIntelligence: true,
      },
      spentAfter: 1,
      requestId: 'req-a3',
      lineage: {
        runId: 'run-borealis',
        rootRunId: 'run-borealis',
      },
    }));

    expect(ledger.listFatigueEvents({
      peerContactId: 'artemis',
      dayKey: '2027-01-15',
      decision: 'charged',
    }).map(event => event.requestId)).toEqual(['req-b1', 'req-a1']);
    expect(ledger.listFatigueEvents({ runId: 'run-a' }).map(event => event.requestId)).toEqual([
      'req-b1',
      'req-a2',
      'req-a1',
    ]);

    const data = ledger.getData({ channelId: 'chan-a' });
    expect(data.aggregates.amount).toBe(2);
    expect(data.aggregates.eventCount).toBe(3);
    expect(data.aggregates.byChannel).toEqual([
      { key: 'chan-a', amount: 2, eventCount: 3 },
    ]);
    expect(data.aggregates.byPeer).toEqual([
      { key: 'artemis', amount: 1, eventCount: 2 },
      { key: 'borealis', amount: 1, eventCount: 1 },
    ]);
    expect(data.aggregates.byDay).toEqual([
      { key: '2027-01-15', amount: 1, eventCount: 2 },
      { key: '2027-01-16', amount: 1, eventCount: 1 },
    ]);
    expect(data.aggregates.byDecision).toEqual([
      { key: 'charged', amount: 2, eventCount: 2 },
      { key: 'free', amount: 0, eventCount: 1 },
    ]);
    expect(data.aggregates.scopes).toEqual([
      expect.objectContaining({
        localCompanionId: 'purrsephone',
        peerContactId: 'borealis',
        channelId: 'chan-a',
        dayKey: '2027-01-16',
        amount: 1,
        eventCount: 1,
        chargedEventCount: 1,
        freeEventCount: 0,
      }),
      expect.objectContaining({
        localCompanionId: 'purrsephone',
        peerContactId: 'artemis',
        channelId: 'chan-a',
        dayKey: '2027-01-15',
        amount: 1,
        eventCount: 2,
        chargedEventCount: 1,
        freeEventCount: 1,
      }),
    ]);
  });

  it('subscribes to typed fatigue events from the event bus', async () => {
    const eventBus = new EventBus();
    const ledger = new FatigueLedger(join(makeTempDir(), 'fatigue-ledger.jsonl'), eventBus);

    await eventBus.emit('agent.fatigue', makeEvent({
      channelId: 'chan-bus',
      requestId: 'req-bus',
    }));

    expect(ledger.listFatigueEvents({ channelId: 'chan-bus' })).toHaveLength(1);
    ledger.close();

    await eventBus.emit('agent.fatigue', makeEvent({
      channelId: 'chan-bus',
      requestId: 'req-after-close',
    }));

    expect(ledger.listFatigueEvents({ channelId: 'chan-bus' }).map(event => event.requestId)).toEqual(['req-bus']);
  });
});
