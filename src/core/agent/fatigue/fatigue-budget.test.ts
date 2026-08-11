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

const ROOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REGULATION_WINDOW_MS = 48 * 60 * 60_000;
const REGULATION_HALF_LIFE_MS = 6 * 60 * 60_000;

function makeIcpCorrelation(rootInitiationId: string, channelId: string, turnId: string) {
  return {
    conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    rootInitiationId,
    initiatedByCompanionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    localCompanionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    peerCompanionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    peerContactId: 'fixture-companion',
    channelId,
    turnId,
    messageId: `message-${turnId}`,
    requestId: `request-${turnId}`,
    chargeLane: 'interactive' as const,
    surface: 'companion_dm' as const,
    costPurpose: 'conversation_turn' as const,
    costOriginStage: 'reply' as const,
    fatigueDecision: 'allow' as const,
  };
}

describe('DeterministicFatigueBudgetPort', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('charges MI-triggered assistant responses and records human-triggered turns as free', () => {
    const { ledger, port } = makePort();

    const miEvaluation = port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'dm-fixture-companion',
      peer: {
        contactId: 'fixture-companion',
        displayName: 'Fixture Companion',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'fixture-companion',
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
      localCompanionId: 'companion-alpha',
      channelId: 'dm-fixture-companion',
      peer: {
        contactId: 'fixture-companion',
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
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-fixture-companion',
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

  it('records a durable pending spend once across recovery replay', () => {
    const { ledger, port } = makePort();
    const evaluation = port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'dm-fixture-companion',
      peer: { contactId: 'fixture-companion', isMachineIntelligence: true },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      limits: LIMITS_WITH_OVERCHARGE,
      correlation: {
        turnId: 'turn-recovery-1',
        requestId: 'request-recovery-1',
        callType: 'chat',
        purpose: 'agent.fatigue.record',
      },
    });
    const pending = {
      schemaVersion: 1 as const,
      timestampMs: evaluation.timestampMs,
      decision: evaluation.decision,
      reason: evaluation.reason,
      amount: evaluation.amount,
      scope: evaluation.scope,
      peer: evaluation.peer,
      triggeringAuthor: evaluation.triggeringAuthor,
      limits: {
        softLimit: evaluation.stateAfter.softLimit,
        hardLimit: evaluation.stateAfter.allowance,
        overchargeLimit: evaluation.stateAfter.overchargeAllowance,
      },
      correlation: evaluation.correlation ?? {},
    };

    const first = port.recordPendingSpend(pending);
    const replay = port.recordPendingSpend(pending);

    expect(replay).toEqual(first);
    expect(ledger.listFatigueEvents()).toHaveLength(1);
    expect(port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-fixture-companion',
      dayKey: evaluation.dayKey,
      limits: LIMITS_WITH_OVERCHARGE,
    }).spent).toBe(1);
    expect(() => port.recordPendingSpend({
      ...pending,
      amount: Number.NaN,
    })).toThrow(/malformed/i);
    expect(ledger.listFatigueEvents()).toHaveLength(1);
  });

  it('keeps the same MI peer isolated by channel and accumulates within one channel', () => {
    const { port } = makePort();

    for (const channelId of ['dm-fixture-companion', 'dm-fixture-companion']) {
      const evaluation = port.evaluate({
        localCompanionId: 'companion-alpha',
        channelId,
        peer: {
          contactId: 'fixture-companion',
          isMachineIntelligence: true,
        },
        triggeringAuthor: {
          role: 'machine_intelligence',
          contactId: 'fixture-companion',
          isMachineIntelligence: true,
        },
        limits: LIMITS,
      });
      port.recordFinalDecision(evaluation);
    }

    expect(port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-fixture-companion',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(2);

    expect(port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(0);

    const groupEvaluation = port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'group-room',
      peer: {
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
    });
    port.recordFinalDecision(groupEvaluation);

    expect(port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
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
      localCompanionId: 'companion-alpha',
      channelId: 'dm-fixture-companion',
      peer: {
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
    }));
    first.ledger.close();

    const secondLedger = new FatigueLedger(ledgerPath, null, { now: () => afterMidnightMs });
    const second = new DeterministicFatigueBudgetPort(secondLedger, { now: () => afterMidnightMs });

    expect(second.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-fixture-companion',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(1);
    expect(second.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-fixture-companion',
      dayKey: '2027-01-16',
      limits: LIMITS,
    }).spent).toBe(0);

    const nextDayEvaluation = second.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'dm-fixture-companion',
      peer: {
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      limits: LIMITS,
    });
    expect(nextDayEvaluation.dayKey).toBe('2027-01-16');
    expect(nextDayEvaluation.stateBefore.spent).toBe(0);
    secondLedger.close();
  });

  it('keeps ICP root spend across DM/room hopping and UTC rollover while leaving legacy scope unchanged', () => {
    const ledgerPath = join(makeTempDir(), 'fatigue-ledger.jsonl');
    const beforeMidnightMs = Date.parse('2027-01-15T23:59:00.000Z');
    const afterMidnightMs = Date.parse('2027-01-16T00:01:00.000Z');
    const first = makePort({ ledgerPath, nowMs: beforeMidnightMs });
    const regulation = {
      rootInitiationId: ROOT_A,
      timestampMs: beforeMidnightMs,
      relationshipPressureHalfLifeMs: REGULATION_HALF_LIFE_MS,
      relationshipPressureWindowMs: REGULATION_WINDOW_MS,
    };
    first.port.recordFinalDecision(first.port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'companion-dm:a:b',
      peer: { contactId: 'fixture-companion', isMachineIntelligence: true },
      triggeringAuthor: { role: 'machine_intelligence', isMachineIntelligence: true },
      limits: LIMITS_WITH_OVERCHARGE,
      timestampMs: beforeMidnightMs,
      regulation,
      correlation: {
        turnId: 'turn-root-a-1',
        icpCorrelation: makeIcpCorrelation(ROOT_A, 'companion-dm:a:b', 'turn-root-a-1'),
      },
    }));
    first.ledger.close();

    const second = makePort({ ledgerPath, nowMs: afterMidnightMs });
    const state = second.port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'companion-room:elsewhere',
      dayKey: '2027-01-16',
      limits: LIMITS_WITH_OVERCHARGE,
      regulation: { ...regulation, timestampMs: afterMidnightMs },
    });
    expect(state.normalSpent).toBe(1);
    expect(state.regulation).toMatchObject({
      rootInitiationId: ROOT_A,
      rootNormalSpent: 1,
      contributingEventCount: 1,
    });
    expect(state.scope.channelId).toBe('companion-room:elsewhere');
    second.ledger.close();
  });

  it('inherits elapsed-decayed relationship pressure on a new root but never decays the active root', () => {
    const startMs = Date.parse('2027-01-15T12:00:00.000Z');
    const { port } = makePort({ nowMs: startMs });
    const rootRegulation = {
      rootInitiationId: ROOT_A,
      timestampMs: startMs,
      relationshipPressureHalfLifeMs: REGULATION_HALF_LIFE_MS,
      relationshipPressureWindowMs: REGULATION_WINDOW_MS,
    };
    port.recordFinalDecision(port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'dm-a',
      peer: { contactId: 'fixture-companion', isMachineIntelligence: true },
      triggeringAuthor: { role: 'machine_intelligence', isMachineIntelligence: true },
      limits: LIMITS_WITH_OVERCHARGE,
      timestampMs: startMs,
      regulation: rootRegulation,
      correlation: {
        turnId: 'turn-pressure-1',
        icpCorrelation: makeIcpCorrelation(ROOT_A, 'dm-a', 'turn-pressure-1'),
      },
    }));

    const afterHalfLife = startMs + REGULATION_HALF_LIFE_MS;
    const sameRoot = port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'room-b',
      limits: LIMITS_WITH_OVERCHARGE,
      regulation: { ...rootRegulation, timestampMs: afterHalfLife },
    });
    const newRoot = port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'room-b',
      limits: LIMITS_WITH_OVERCHARGE,
      regulation: {
        ...rootRegulation,
        rootInitiationId: ROOT_B,
        timestampMs: afterHalfLife,
      },
    });
    expect(sameRoot.normalSpent).toBe(1);
    expect(sameRoot.regulation?.rootNormalSpent).toBe(1);
    expect(newRoot.regulation?.rootNormalSpent).toBe(0);
    expect(newRoot.regulation?.relationshipPressure).toBeCloseTo(0.5, 5);
    expect(newRoot.normalSpent).toBe(1);

    const afterWindow = port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'room-b',
      limits: LIMITS_WITH_OVERCHARGE,
      regulation: {
        ...rootRegulation,
        rootInitiationId: ROOT_B,
        timestampMs: startMs + REGULATION_WINDOW_MS + 1,
      },
    });
    expect(afterWindow.normalSpent).toBe(0);
    expect(afterWindow.regulation?.contributingEventCount).toBe(0);
  });

  it('keeps fatigue choices independent per local companion for the same relationship root', () => {
    const nowMs = Date.parse('2027-01-15T12:00:00.000Z');
    const { port } = makePort({ nowMs });
    const regulation = {
      rootInitiationId: ROOT_A,
      timestampMs: nowMs,
      relationshipPressureHalfLifeMs: REGULATION_HALF_LIFE_MS,
      relationshipPressureWindowMs: REGULATION_WINDOW_MS,
    };
    port.recordFinalDecision(port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'dm-a',
      peer: { contactId: 'fixture-companion', isMachineIntelligence: true },
      triggeringAuthor: { role: 'machine_intelligence', isMachineIntelligence: true },
      limits: LIMITS_WITH_OVERCHARGE,
      timestampMs: nowMs,
      regulation,
      correlation: {
        turnId: 'turn-local-a',
        icpCorrelation: makeIcpCorrelation(ROOT_A, 'dm-a', 'turn-local-a'),
      },
    }));
    expect(port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-a',
      limits: LIMITS_WITH_OVERCHARGE,
      regulation,
    }).normalSpent).toBe(1);
    expect(port.readState({
      localCompanionId: 'fixture-companion',
      peerContactId: 'companion-alpha',
      channelId: 'dm-a',
      limits: LIMITS_WITH_OVERCHARGE,
      regulation,
    }).normalSpent).toBe(0);
  });

  it('tracks overcharge reserve separately from normal fatigue spend', () => {
    const { ledger, port } = makePort();

    for (let index = 0; index < LIMITS_WITH_OVERCHARGE.hardLimit; index += 1) {
      const evaluation = port.evaluate({
        localCompanionId: 'companion-alpha',
        channelId: 'dm-fixture-companion',
        peer: {
          contactId: 'fixture-companion',
          isMachineIntelligence: true,
        },
        triggeringAuthor: {
          role: 'machine_intelligence',
          contactId: 'fixture-companion',
          isMachineIntelligence: true,
        },
        limits: LIMITS_WITH_OVERCHARGE,
      });
      port.recordFinalDecision(evaluation);
    }

    const baseEvaluation = port.evaluate({
      localCompanionId: 'companion-alpha',
      channelId: 'dm-fixture-companion',
      peer: {
        contactId: 'fixture-companion',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: 'fixture-companion',
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
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'dm-fixture-companion',
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
      localCompanionId: 'companion-alpha',
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
      localCompanionId: 'companion-alpha',
      channelId: 'group-room',
      peer: {
        contactId: 'fixture-companion',
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
      localCompanionId: 'companion-alpha',
      peerContactId: 'unknown-contact',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(0);
    expect(port.readState({
      localCompanionId: 'companion-alpha',
      peerContactId: 'fixture-companion',
      channelId: 'group-room',
      dayKey: '2027-01-15',
      limits: LIMITS,
    }).spent).toBe(0);
  });
});
