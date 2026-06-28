import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FatigueLedger } from '../../../shared/telemetry/fatigue-ledger.js';
import {
  createOverchargeFatigueEvaluation,
  DeterministicFatigueBudgetPort,
  type FatigueBudgetLimits,
} from './fatigue-budget.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-fatigue-budget-'));
  tempDirs.push(dir);
  return dir;
}

function makePort(options: {
  nowMs?: number;
  ledgerPath?: string;
} = {}): { ledger: FatigueLedger; port: DeterministicFatigueBudgetPort } {
  const ledger = new FatigueLedger(
    options.ledgerPath ?? join(makeTempDir(), 'fatigue-ledger.jsonl'),
    null,
    { now: () => options.nowMs ?? Date.UTC(2027, 0, 15, 12, 0, 0) },
  );
  return {
    ledger,
    port: new DeterministicFatigueBudgetPort(ledger, {
      now: () => options.nowMs ?? Date.UTC(2027, 0, 15, 12, 0, 0),
    }),
  };
}

const LIMITS = {
  softLimit: 2,
  hardLimit: 3,
} satisfies FatigueBudgetLimits;

const LIMITS_WITH_OVERCHARGE = {
  ...LIMITS,
  overchargeLimit: 2,
} satisfies FatigueBudgetLimits;

describe('DeterministicFatigueBudgetPort', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('charges MI-triggered assistant responses and records human-triggered turns as free', () => {
    const { ledger, port } = makePort();

    const miEvaluation = port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'dm-artemis',
      peer: {
        contactId: 'artemis',
        displayName: 'Artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
      correlation: {
        requestId: 'req-mi',
        turnId: 'turn-mi',
        callType: 'chat',
        purpose: 'assistant_response',
      },
      lineage: {
        runId: 'run-mi',
        rootRunId: 'run-mi',
      },
    });

    expect(miEvaluation.decision).toBe('charged');
    expect(miEvaluation.amount).toBe(1);
    expect(miEvaluation.stateBefore.spent).toBe(0);
    expect(miEvaluation.stateAfter.spent).toBe(1);
    expect(ledger.listFatigueEvents()).toHaveLength(0);

    const chargedEvent = port.recordFinalDecision(miEvaluation);
    expect(chargedEvent.amount).toBe(1);
    expect(chargedEvent.requestId).toBe('req-mi');
    expect(chargedEvent.lineage?.runId).toBe('run-mi');

    const humanEvaluation = port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'dm-artemis',
      peer: {
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'human',
        contactId: 'human-1',
        isMachineIntelligence: false,
      },
      limits: LIMITS,
    });

    expect(humanEvaluation.decision).toBe('free');
    expect(humanEvaluation.reason).toBe('triggering_author_not_machine_intelligence');
    expect(humanEvaluation.amount).toBe(0);
    expect(humanEvaluation.stateBefore.spent).toBe(1);
    expect(humanEvaluation.stateAfter.spent).toBe(1);

    port.recordFinalDecision(humanEvaluation, {
      correlation: {
        requestId: 'req-human',
        callType: 'chat',
        purpose: 'assistant_response',
      },
    });

    const state = port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'dm-artemis',
      dayKey: '2027-01-15',
      limits: LIMITS,
    });
    expect(state.spent).toBe(1);
    expect(state.remainingAllowance).toBe(2);
    expect(ledger.listFatigueEvents()).toHaveLength(2);
    expect(ledger.listFatigueEvents({ decision: 'free' })[0]).toEqual(expect.objectContaining({
      amount: 0,
      requestId: 'req-human',
    }));
  });

  it('keeps the same MI peer isolated by channel and accumulates within one channel', () => {
    const { port } = makePort();

    for (const channelId of ['dm-artemis', 'dm-artemis']) {
      const evaluation = port.evaluate({
        localCompanionId: 'purrsephone',
        channelId,
        peer: {
          contactId: 'artemis',
          isMachineIntelligence: true,
        },
        triggeringAuthor: {
          role: 'machine_intelligence',
          contactId: 'artemis',
          isMachineIntelligence: true,
        },
        limits: LIMITS,
      });
      port.recordFinalDecision(evaluation);
    }

    expect(port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'dm-artemis',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(2);

    expect(port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(0);

    const groupEvaluation = port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'group-room',
      peer: {
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
    });
    port.recordFinalDecision(groupEvaluation);

    expect(port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(1);
  });

  it('resets accounting at the UTC day boundary', () => {
    const ledgerPath = join(makeTempDir(), 'fatigue-ledger.jsonl');
    const beforeMidnightMs = Date.parse('2027-01-15T23:59:00.000Z');
    const afterMidnightMs = Date.parse('2027-01-16T00:01:00.000Z');
    const first = makePort({ ledgerPath, nowMs: beforeMidnightMs });

    first.port.recordFinalDecision(first.port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'dm-artemis',
      peer: {
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
    }));
    first.ledger.close();

    const secondLedger = new FatigueLedger(ledgerPath, null, { now: () => afterMidnightMs });
    const second = new DeterministicFatigueBudgetPort(secondLedger, { now: () => afterMidnightMs });

    expect(second.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'dm-artemis',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(1);
    expect(second.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'dm-artemis',
      dayKey: '2027-01-16',
      limits: LIMITS,
    }).spent).toBe(0);

    const nextDayEvaluation = second.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'dm-artemis',
      peer: {
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
    });
    expect(nextDayEvaluation.dayKey).toBe('2027-01-16');
    expect(nextDayEvaluation.stateBefore.spent).toBe(0);
    secondLedger.close();
  });

  it('tracks overcharge reserve separately from normal fatigue spend', () => {
    const { ledger, port } = makePort();

    for (let index = 0; index < LIMITS_WITH_OVERCHARGE.hardLimit; index += 1) {
      const evaluation = port.evaluate({
        localCompanionId: 'purrsephone',
        channelId: 'dm-artemis',
        peer: {
          contactId: 'artemis',
          isMachineIntelligence: true,
        },
        triggeringAuthor: {
          role: 'machine_intelligence',
          contactId: 'artemis',
          isMachineIntelligence: true,
        },
        limits: LIMITS_WITH_OVERCHARGE,
      });
      port.recordFinalDecision(evaluation);
    }

    const baseEvaluation = port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'dm-artemis',
      peer: {
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      limits: LIMITS_WITH_OVERCHARGE,
    });
    expect(baseEvaluation.stateBefore.normalSpent).toBe(3);
    expect(baseEvaluation.stateBefore.remainingAllowance).toBe(0);
    expect(baseEvaluation.stateBefore.remainingOvercharge).toBe(2);

    const overchargeEvaluation = createOverchargeFatigueEvaluation(
      baseEvaluation,
      'overcharge_recent_human_participation',
    );
    expect(overchargeEvaluation.decision).toBe('overcharge');
    expect(overchargeEvaluation.stateAfter.normalSpent).toBe(3);
    expect(overchargeEvaluation.stateAfter.overchargeSpent).toBe(1);
    expect(overchargeEvaluation.stateAfter.remainingOvercharge).toBe(1);

    const event = port.recordFinalDecision(overchargeEvaluation);
    expect(event).toMatchObject({
      decision: 'overcharge',
      reason: 'overcharge_recent_human_participation',
      amount: 1,
      normalSpentAfter: 3,
      overchargeSpentAfter: 1,
      overchargeAllowance: 2,
      remainingOvercharge: 1,
    });

    const state = port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'dm-artemis',
      dayKey: '2027-01-15',
      limits: LIMITS_WITH_OVERCHARGE,
    });
    expect(state.normalSpent).toBe(3);
    expect(state.overchargeSpent).toBe(1);
    expect(state.spent).toBe(4);
    expect(state.remainingAllowance).toBe(0);
    expect(state.remainingOvercharge).toBe(1);
    expect(ledger.listFatigueEvents({ decision: 'overcharge' })).toHaveLength(1);
  });

  it('treats unknown or unflagged contacts as free', () => {
    const { port } = makePort();

    const unflaggedPeer = port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'group-room',
      peer: {
        contactId: 'unknown-contact',
      },
      triggeringAuthor: {
        role: 'unknown',
        contactId: 'unknown-contact',
      },
      limits: LIMITS,
    });
    expect(unflaggedPeer.decision).toBe('free');
    expect(unflaggedPeer.reason).toBe('peer_not_machine_intelligence');
    expect(unflaggedPeer.amount).toBe(0);
    port.recordFinalDecision(unflaggedPeer);

    const unflaggedAuthor = port.evaluate({
      localCompanionId: 'purrsephone',
      channelId: 'group-room',
      peer: {
        contactId: 'artemis',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'unknown',
        contactId: 'unknown-contact',
      },
      limits: LIMITS,
    });
    expect(unflaggedAuthor.decision).toBe('free');
    expect(unflaggedAuthor.reason).toBe('triggering_author_not_machine_intelligence');
    expect(unflaggedAuthor.amount).toBe(0);
    port.recordFinalDecision(unflaggedAuthor);

    expect(port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'unknown-contact',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(0);
    expect(port.readState({
      localCompanionId: 'purrsephone',
      peerContactId: 'artemis',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(0);
  });
});
