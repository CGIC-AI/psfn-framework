import { describe, it, expect } from 'vitest';
import type {
  CorrelationMetadata,
  FatigueBudgetEvent,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { FatiguePolicyConfig } from '../../../shared/contracts/charge-policy.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import {
  DeterministicFatigueBudgetPort,
  type FatigueBudgetHistoryPort,
  type FatigueBudgetPort,
} from './fatigue-budget.js';
import {
  evaluateFatigueForTurn,
  type FatigueAuthorPolicyContext,
  type FatigueRecentHumanParticipation,
} from './runtime-enforcement.js';

// ── Two-companion loop end-to-end verification (E7.3, charter §8.10 / law 26) ──
// Drives the REAL fatigue engine (evaluateFatigueForTurn + DeterministicFatigueBudgetPort
// + recordFinalDecision — the exact functions the turn pipeline calls) through a
// simulated companion-to-companion exchange in a room. Proves the guard bounds
// machine-to-machine looping without banning conversation, spends only on
// MI-to-MI turns, walks the budget states, and terminates within budget.

const LOCAL_COMPANION = 'companion-selene';
const PEER_CONTACT = 'peer-nova';
const CHANNEL_ID = 'discord:companion-room-1'; // includes 'companion' -> companion_room
const TS = Date.parse('2026-03-08T12:00:00Z');
const CHANNEL_META: ChannelMeta = { isDirectMessage: false };
const CORRELATION: CorrelationMetadata = { callType: 'chat', purpose: 'test.fatigue.two_companion_loop' };

// Small, legible budget: soft target 3, hard cap 5, reserve 2.
// Walk (spent -> baseState): 0 normal, 1 normal, 2 nearing_limit,
// 3 soft_exhausted, 4 wrap_up_allowed, 5 hard_exhausted.
function makeLoopConfig(): FatiguePolicyConfig {
  const base = makeTestFatiguePolicyConfig();
  return {
    ...base,
    relationshipBudgets: {
      ...base.relationshipBudgets,
      trusted_collaborator_mi: { softTarget: 3, hardCap: 5 },
    },
    // Flatten intent multipliers so the budget is a legible fixed 3/5 regardless
    // of intent — this isolates the state walk and the work-intent OVERCHARGE
    // trigger from the separate intent-scaling-of-limits behavior.
    intentMultipliers: Object.fromEntries(
      Object.keys(base.intentMultipliers).map(intent => [
        intent,
        { softTargetMultiplier: 1, hardCapMultiplier: 1 },
      ]),
    ) as FatiguePolicyConfig['intentMultipliers'],
  };
}

class InMemoryFatigueBudgetHistory implements FatigueBudgetHistoryPort {
  readonly events: FatigueBudgetEvent[] = [];

  listFatigueEvents(
    query: NonNullable<Parameters<FatigueBudgetHistoryPort['listFatigueEvents']>[0]> = {},
  ): FatigueBudgetEvent[] {
    return this.events.filter(event => (
      (query.localCompanionId === undefined || event.localCompanionId === query.localCompanionId)
      && (query.peerContactId === undefined || event.peerContactId === query.peerContactId)
      && (query.channelId === undefined || event.channelId === query.channelId)
      && (query.dayKey === undefined || event.dayKey === query.dayKey)
      && (query.decision === undefined || event.decision === query.decision)
    ));
  }

  recordFatigueEvent(event: FatigueBudgetEvent): void {
    this.events.push({ ...event, triggeringAuthor: { ...event.triggeringAuthor }, peer: { ...event.peer } });
  }
}

function createHarness(): { fatigueBudget: FatigueBudgetPort; history: InMemoryFatigueBudgetHistory } {
  const history = new InMemoryFatigueBudgetHistory();
  const fatigueBudget = new DeterministicFatigueBudgetPort(history, { now: () => TS });
  return { fatigueBudget, history };
}

const miAuthorContext: FatigueAuthorPolicyContext = {
  trustLevel: 'trusted',
  speakerRole: 'user',
  resolvedUserName: 'Nova',
  speakingWithIsMachineIntelligence: true,
  canonicalContactKey: PEER_CONTACT,
  relationshipType: 'ai_companion',
};

const humanAuthorContext: FatigueAuthorPolicyContext = {
  trustLevel: 'trusted',
  speakerRole: 'user',
  resolvedUserName: 'Raul',
  canonicalContactKey: 'human-raul',
  relationshipType: 'friend',
};

function makeMessage(content: string, authorId: string, authorName: string): SubstrateMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    channelId: CHANNEL_ID,
    channelType: 'discord',
    isDirectMessage: false,
    authorId,
    authorName,
    content,
    timestamp: new Date(TS),
  };
}

interface TurnOptions {
  config: FatiguePolicyConfig;
  content?: string;
  human?: boolean;
  taskKind?: string;
  recentHumanParticipation?: FatigueRecentHumanParticipation;
}

function runTurn(
  harness: { fatigueBudget: FatigueBudgetPort },
  opts: TurnOptions,
) {
  const human = opts.human === true;
  const decision = evaluateFatigueForTurn({
    fatigueBudget: harness.fatigueBudget,
    fatiguePolicy: opts.config,
    localCompanionId: LOCAL_COMPANION,
    message: human
      ? makeMessage(opts.content ?? 'hey you two, what are you up to?', 'human-raul', 'Raul')
      : makeMessage(opts.content ?? 'just carrying on chatting', PEER_CONTACT, 'Nova'),
    authorContext: human ? humanAuthorContext : miAuthorContext,
    channelId: CHANNEL_ID,
    channelType: 'discord',
    channelMeta: CHANNEL_META,
    ...(opts.taskKind ? { taskKind: opts.taskKind } : {}),
    ...(opts.recentHumanParticipation ? { recentHumanParticipation: opts.recentHumanParticipation } : {}),
    timestampMs: TS,
    correlation: CORRELATION,
  });
  if (decision.shouldRecordSpend) {
    harness.fatigueBudget.recordFinalDecision(decision.evaluation);
  }
  return decision;
}

describe('two-companion fatigue loop (E7.3 end-to-end)', () => {
  it('walks the budget states and terminates within budget on machine-to-machine turns', () => {
    const harness = createHarness();
    const config = makeLoopConfig();

    const baseStates: string[] = [];
    const relationshipClasses: string[] = [];
    let suppressedAt = -1;

    // A companion cannot loop forever: cap iterations well above the hard cap
    // and prove the guard terminates the exchange on its own.
    for (let i = 0; i < 12; i++) {
      const decision = runTurn(harness, { config });
      baseStates.push(decision.metadata.policyBaseState);
      relationshipClasses.push(decision.metadata.relationshipClass);
      if (decision.suppressModel) {
        suppressedAt = i;
        break;
      }
    }

    // Clean state walk normal -> nearing_limit -> soft_exhausted -> wrap_up_allowed -> hard_exhausted.
    expect(baseStates).toEqual([
      'normal',
      'normal',
      'nearing_limit',
      'soft_exhausted',
      'wrap_up_allowed',
      'hard_exhausted',
    ]);

    // The loop terminates: the 6th turn (hard-exhausted, no human, casual) is suppressed.
    expect(suppressedAt).toBe(5);

    // Spending happened only on machine-intelligence-triggered turns, against
    // the peer companion's machine-intelligence relationship class.
    expect(harness.history.events.every(event => event.decision === 'charged')).toBe(true);
    expect(harness.history.events.every(event => event.reason === 'machine_intelligence_response')).toBe(true);
    expect(relationshipClasses.every(cls => cls === 'trusted_collaborator_mi')).toBe(true);
    // Five charged turns before the hard cap suppresses the sixth.
    expect(harness.history.events).toHaveLength(5);
    expect(harness.history.events.every(event => event.peerContactId === PEER_CONTACT)).toBe(true);
  });

  it('never spends on a human-authored turn (fatigue is machine-to-machine only)', () => {
    const harness = createHarness();
    const config = makeLoopConfig();

    const decision = runTurn(harness, { config, human: true });
    expect(decision.metadata.decision).toBe('allowed_free');
    expect(decision.metadata.spendReason).toBe('peer_not_machine_intelligence');
    expect(decision.shouldRecordSpend).toBe(false);
    expect(harness.history.events).toHaveLength(0);
  });

  it('suppresses at the hard cap when no qualifying overcharge trigger is present', () => {
    const harness = createHarness();
    const config = makeLoopConfig();
    for (let i = 0; i < 5; i++) runTurn(harness, { config });

    const decision = runTurn(harness, { config });
    expect(decision.metadata.policyBaseState).toBe('hard_exhausted');
    expect(decision.suppressModel).toBe(true);
    expect(decision.metadata.decision).toBe('suppressed_hard_exhausted');
    expect(decision.metadata.overchargeBlockedReasons).toContain('no_qualifying_overcharge_trigger');
  });

  it('a human message resets the dynamics: recent human participation unlocks a bounded overcharge', () => {
    const harness = createHarness();
    const config = makeLoopConfig();
    for (let i = 0; i < 5; i++) runTurn(harness, { config }); // exhaust to hard cap

    // A human speaks in the room (free, non-spending) ...
    const humanTurn = runTurn(harness, { config, human: true });
    expect(humanTurn.shouldRecordSpend).toBe(false);

    // ... and the next machine-to-machine reply may use a bounded overcharge.
    const overcharge = runTurn(harness, {
      config,
      recentHumanParticipation: { messageCount: 1, participantCount: 1, latestMessageAgeMs: 1_000 },
    });
    expect(overcharge.suppressModel).toBe(false);
    expect(overcharge.metadata.decision).toBe('overcharge_charged');
    expect(overcharge.metadata.overchargeReasons).toContain('recent_human_participation');
  });

  it('a work/research intent unlocks a bounded overcharge to wrap up', () => {
    const harness = createHarness();
    const config = makeLoopConfig();
    for (let i = 0; i < 5; i++) runTurn(harness, { config });

    const overcharge = runTurn(harness, {
      config,
      content: 'let us finish the research write-up before we stop',
    });
    expect(overcharge.suppressModel).toBe(false);
    expect(overcharge.metadata.decision).toBe('overcharge_charged');
    expect(overcharge.metadata.overchargeReasons).toContain('work_intent_wrapup');
  });

  it('overcharge is bounded by the reserve and then suppresses again', () => {
    const harness = createHarness();
    const config = makeLoopConfig();
    for (let i = 0; i < 5; i++) runTurn(harness, { config });

    const recentHuman: FatigueRecentHumanParticipation = {
      messageCount: 1,
      participantCount: 1,
      latestMessageAgeMs: 1_000,
    };
    // Reserve is 2 overcharge responses.
    const first = runTurn(harness, { config, recentHumanParticipation: recentHuman });
    const second = runTurn(harness, { config, recentHumanParticipation: recentHuman });
    expect(first.metadata.decision).toBe('overcharge_charged');
    expect(second.metadata.decision).toBe('overcharge_charged');

    // Third overcharge exceeds the reserve -> suppressed again.
    const third = runTurn(harness, { config, recentHumanParticipation: recentHuman });
    expect(third.suppressModel).toBe(true);
    expect(third.metadata.overchargeBlockedReasons).toContain('overcharge_reserve_exhausted');
  });
});
