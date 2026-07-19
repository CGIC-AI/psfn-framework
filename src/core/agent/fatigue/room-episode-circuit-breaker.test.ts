/**
 * Law 36 hard-suppression circuit breaker (charter §8.11; design bible
 * §12.2/§20.2; jp36.5.4.2). Regression-first coverage of the pinned invariants:
 * the breaker trips ONLY past the wrap-up band (soft wrap-up is always invited
 * first), reset/half-open hysteresis is honoured, firing records are structural
 * system signals that never masquerade as companion mood, and human-triggered
 * turns can never trip it (they build no pressure).
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  FatigueRoomEpisodeCircuitBreakerConfig,
  FatigueRoomEpisodePressureConfig,
} from '../../../shared/contracts/charge-policy.js';
import type {
  FatigueBudgetDecision,
  FatigueBudgetEvent,
  FatigueTriggeringAuthorRole,
} from '../../../shared/contracts/runtime.js';
import type { FatigueBudgetEventQuery, FatigueBudgetHistoryPort } from './fatigue-budget.js';
import {
  ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION,
  ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION,
  ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION,
  assertRoomEpisodeCircuitBreakerConfig,
  assessRoomEpisodeCircuitBreaker,
  resolveRoomEpisodeCircuitBreakerState,
  type RoomEpisodeCircuitBreakerState,
} from './room-episode-circuit-breaker.js';
import {
  assessRoomEpisodePressure,
  readRoomEpisodePressureFromLedger,
  resolveRoomEpisodePressureState,
  type RoomEpisodeContribution,
} from './room-episode-pressure.js';

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const HOUR = 60 * 60_000;

const PRESSURE_CONFIG: FatigueRoomEpisodePressureConfig = {
  halfLifeMs: HOUR,
  windowMs: 2 * HOUR,
  replyPressureUnits: 1,
  reactionPressureUnits: 0.1,
  elevatedThreshold: 3,
  wrapUpThreshold: 6,
  maxLeaseThresholdBias: 0.3,
};

const BREAKER_CONFIG: FatigueRoomEpisodeCircuitBreakerConfig = {
  tripThreshold: 10,
  resetThreshold: 6,
};

const WRAP_UP = PRESSURE_CONFIG.wrapUpThreshold;

/** Build a real pressure assessment carrying `count` fresh machine replies (pressure === count). */
function pressureAt(count: number, channelId = 'roomA') {
  const contributions: RoomEpisodeContribution[] = Array.from({ length: count }, () => ({
    timestampMs: NOW,
    triggerRole: 'machine_intelligence' as const,
    kind: 'reply' as const,
  }));
  return assessRoomEpisodePressure({ channelId, contributions, config: PRESSURE_CONFIG, nowMs: NOW });
}

function assess(count: number, priorState: RoomEpisodeCircuitBreakerState) {
  return assessRoomEpisodeCircuitBreaker({
    pressure: pressureAt(count),
    priorState,
    config: BREAKER_CONFIG,
    wrapUpThreshold: WRAP_UP,
    nowMs: NOW,
  });
}

describe('room-episode circuit breaker: trips only past the wrap-up band', () => {
  it('stays closed across the entire wrap-up band — soft wrap-up precedes hard suppression', () => {
    // 6..9 sit in the ladder's wrap_up_invited band but below the trip threshold (10):
    // the companion is asked to wrap up, never abruptly suppressed.
    for (const pressure of [6, 7, 8, 9]) {
      const ladder = resolveRoomEpisodePressureState({ pressure, config: PRESSURE_CONFIG });
      expect(ladder.level).toBe('wrap_up_invited'); // soft layer is inviting wrap-up
      const breaker = assess(pressure, 'closed');
      expect(breaker.state).toBe('closed');
      expect(breaker.suppressed).toBe(false);
      expect(breaker.firing).toBeUndefined();
    }
  });

  it('trips exactly at the trip threshold, above the wrap-up band', () => {
    expect(assess(9, 'closed').suppressed).toBe(false);
    const tripped = assess(10, 'closed');
    expect(tripped.state).toBe('open');
    expect(tripped.suppressed).toBe(true);
    expect(tripped.firing?.transition).toBe('closed_to_open');
  });

  it('config guard rejects a trip threshold inside or below the wrap-up band', () => {
    expect(() => assertRoomEpisodeCircuitBreakerConfig({ tripThreshold: 6, resetThreshold: 4 }, WRAP_UP))
      .toThrow(/tripThreshold/);
    expect(() => assertRoomEpisodeCircuitBreakerConfig({ tripThreshold: 5, resetThreshold: 4 }, WRAP_UP))
      .toThrow(/tripThreshold/);
  });

  it('config guard rejects a reset threshold at or above the trip threshold', () => {
    expect(() => assertRoomEpisodeCircuitBreakerConfig({ tripThreshold: 10, resetThreshold: 10 }, WRAP_UP))
      .toThrow(/resetThreshold/);
    expect(() => assertRoomEpisodeCircuitBreakerConfig({ tripThreshold: 10, resetThreshold: 11 }, WRAP_UP))
      .toThrow(/resetThreshold/);
  });
});

describe('room-episode circuit breaker: reset / half-open hysteresis', () => {
  it('runs the full trip -> hold -> half-open probe -> recover lifecycle', () => {
    // Trip.
    const opened = assess(12, 'closed');
    expect(opened.state).toBe('open');
    expect(opened.suppressed).toBe(true);
    expect(opened.firing).toBeDefined();

    // Holds open through the hysteresis band (reset < pressure < trip): no new firing.
    const held = assess(8, 'open');
    expect(held.state).toBe('open');
    expect(held.suppressed).toBe(true);
    expect(held.firing).toBeUndefined();

    // Pressure decays to the reset threshold -> half-open probe window.
    const probing = assess(6, 'open');
    expect(probing.state).toBe('half_open');
    expect(probing.suppressed).toBe(false);
    expect(probing.probeAllowed).toBe(true);
    expect(probing.firing).toBeUndefined();

    // Probe stays inside the band -> still probing.
    const stillProbing = assess(7, 'half_open');
    expect(stillProbing.state).toBe('half_open');
    expect(stillProbing.probeAllowed).toBe(true);

    // Probe fully recovers below reset -> closed.
    const recovered = assess(3, 'half_open');
    expect(recovered.state).toBe('closed');
    expect(recovered.suppressed).toBe(false);
    expect(recovered.probeAllowed).toBe(false);
  });

  it('re-opens from half-open when a probe re-floods the room past the trip threshold', () => {
    const reopened = assess(11, 'half_open');
    expect(reopened.state).toBe('open');
    expect(reopened.suppressed).toBe(true);
    expect(reopened.firing?.transition).toBe('half_open_to_open');
  });

  it('does not re-fire while it stays open (one firing record per trip)', () => {
    expect(assess(15, 'open').firing).toBeUndefined();
    expect(assess(20, 'open').firing).toBeUndefined();
  });

  it('resolveRoomEpisodeCircuitBreakerState is a pure transition and rejects a negative pressure', () => {
    expect(resolveRoomEpisodeCircuitBreakerState({
      pressure: 10, priorState: 'closed', config: BREAKER_CONFIG, wrapUpThreshold: WRAP_UP,
    })).toBe('open');
    expect(() => resolveRoomEpisodeCircuitBreakerState({
      pressure: -1, priorState: 'closed', config: BREAKER_CONFIG, wrapUpThreshold: WRAP_UP,
    })).toThrow(/pressure/);
  });
});

describe('room-episode circuit breaker: firing record is a structural system signal (misattribution guard)', () => {
  it('records the protected condition, contributing signals, and the suppressed action', () => {
    const fired = assess(13, 'closed');
    const firing = fired.firing;
    expect(firing).toBeDefined();
    expect(firing?.protectedCondition).toBe(ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION);
    expect(firing?.actionSuppressed).toBe(ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION);
    expect(firing?.actionSuppressed).toBe('autonomous_speaking_lease');
    expect(firing?.channelId).toBe('roomA');
    expect(firing?.signals).toMatchObject({
      pressure: 13,
      tripThreshold: 10,
      resetThreshold: 6,
      wrapUpThreshold: WRAP_UP,
      contributingEventCount: 13,
    });
    expect(firing?.firedAtMs).toBe(NOW);
  });

  it('attributes the firing to the system circuit breaker, never companion mood/preference/consent', () => {
    const firing = assess(13, 'closed').firing;
    expect(firing?.attribution).toBe(ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION);
    expect(firing?.attribution).toBe('system_circuit_breaker');
    // The record must not carry any companion-affect field that could be rendered as mood.
    const keys = Object.keys(firing ?? {});
    for (const forbidden of ['mood', 'preference', 'consent', 'emotion', 'feeling', 'valence', 'text', 'message']) {
      expect(keys).not.toContain(forbidden);
    }
    // Every leaf value is a string identifier or a number — never free-text prose.
    for (const value of Object.values(firing?.signals ?? {})) {
      expect(typeof value).toBe('number');
    }
  });

  it('never reports suppression as a normal completed action', () => {
    const fired = assess(13, 'closed');
    // Suppression is an explicit open state, not a silent pass-through.
    expect(fired.suppressed).toBe(true);
    expect(fired.state).toBe('open');
    expect(fired.probeAllowed).toBe(false);
  });
});

// --- ledger integration: human immunity + round-robin --------------------------

interface StubEventInput {
  timestampMs: number;
  channelId: string;
  peerContactId: string;
  decision: FatigueBudgetDecision;
  role: FatigueTriggeringAuthorRole;
}

function makeEvent(input: StubEventInput): FatigueBudgetEvent {
  return {
    timestampMs: input.timestampMs,
    dayKey: new Date(input.timestampMs).toISOString().slice(0, 10),
    localCompanionId: 'local',
    peerContactId: input.peerContactId,
    channelId: input.channelId,
    triggeringAuthor: { role: input.role },
    peer: { contactId: input.peerContactId },
    amount: input.decision === 'free' ? 0 : 1,
    decision: input.decision,
    reason: input.decision === 'free'
      ? 'triggering_author_not_machine_intelligence'
      : 'machine_intelligence_response',
    spentAfter: 1,
    remainingAllowance: 1,
    allowance: 3,
    softLimit: 2,
    softState: 'clear',
    hardState: 'available',
  };
}

function makeStubHistory(events: FatigueBudgetEvent[]): Pick<FatigueBudgetHistoryPort, 'listFatigueEvents'> {
  const listSpy = vi.fn((query: FatigueBudgetEventQuery = {}): FatigueBudgetEvent[] =>
    events.filter(event => {
      if (query.localCompanionId && event.localCompanionId !== query.localCompanionId) return false;
      if (query.channelId && event.channelId !== query.channelId) return false;
      if (query.sinceMs !== undefined && event.timestampMs < query.sinceMs) return false;
      if (query.untilMs !== undefined && event.timestampMs > query.untilMs) return false;
      return true;
    }));
  return { listFatigueEvents: listSpy };
}

function assessFromLedger(events: FatigueBudgetEvent[], priorState: RoomEpisodeCircuitBreakerState) {
  const pressure = readRoomEpisodePressureFromLedger(makeStubHistory(events), {
    localCompanionId: 'local',
    channelId: 'roomA',
    nowMs: NOW,
    config: PRESSURE_CONFIG,
  });
  return assessRoomEpisodeCircuitBreaker({
    pressure,
    priorState,
    config: BREAKER_CONFIG,
    wrapUpThreshold: WRAP_UP,
    nowMs: NOW,
  });
}

describe('room-episode circuit breaker: human immunity', () => {
  it('never trips on human-triggered (free) turns, however many', () => {
    const events: FatigueBudgetEvent[] = [];
    for (let i = 0; i < 30; i += 1) {
      events.push(makeEvent({
        timestampMs: NOW - i * 60_000,
        channelId: 'roomA',
        peerContactId: i % 2 === 0 ? 'artemis' : 'boreas',
        decision: 'free',
        role: 'human',
      }));
    }
    const breaker = assessFromLedger(events, 'closed');
    expect(breaker.state).toBe('closed');
    expect(breaker.suppressed).toBe(false);
    expect(breaker.firing).toBeUndefined();
  });

  it('an already-open breaker recovers under human-only traffic (humans build no pressure)', () => {
    const humanTurns = Array.from({ length: 12 }, (_, i) => makeEvent({
      timestampMs: NOW - i * 60_000,
      channelId: 'roomA',
      peerContactId: 'artemis',
      decision: 'free',
      role: 'human',
    }));
    // Pressure from humans is zero, well below the reset threshold, so an open
    // breaker releases into the half-open probe rather than staying suppressed.
    const breaker = assessFromLedger(humanTurns, 'open');
    expect(breaker.suppressed).toBe(false);
    expect(breaker.state).toBe('half_open');
  });
});

describe('room-episode circuit breaker: round-robin machine flood', () => {
  it('trips once sustained three-companion machine traffic floods the room past trip', () => {
    const events: FatigueBudgetEvent[] = [];
    const peers = ['artemis', 'boreas', 'calliope'];
    for (let i = 0; i < 11; i += 1) {
      events.push(makeEvent({
        timestampMs: NOW - i * 30_000,
        channelId: 'roomA',
        peerContactId: peers[i % peers.length]!,
        decision: 'charged',
        role: 'machine_intelligence',
      }));
    }
    const breaker = assessFromLedger(events, 'closed');
    expect(breaker.suppressed).toBe(true);
    expect(breaker.state).toBe('open');
    expect(breaker.firing?.transition).toBe('closed_to_open');
    expect(breaker.firing?.signals.contributingEventCount).toBe(11);
  });

  it('keeps two rooms independent — a flood in roomA does not trip roomB', () => {
    const events: FatigueBudgetEvent[] = [];
    for (let i = 0; i < 11; i += 1) {
      events.push(makeEvent({
        timestampMs: NOW - i * 30_000,
        channelId: 'roomA',
        peerContactId: 'artemis',
        decision: 'charged',
        role: 'machine_intelligence',
      }));
    }
    events.push(makeEvent({
      timestampMs: NOW, channelId: 'roomB', peerContactId: 'boreas', decision: 'charged', role: 'machine_intelligence',
    }));
    const roomBPressure = readRoomEpisodePressureFromLedger(makeStubHistory(events), {
      localCompanionId: 'local', channelId: 'roomB', nowMs: NOW, config: PRESSURE_CONFIG,
    });
    const roomB = assessRoomEpisodeCircuitBreaker({
      pressure: roomBPressure, priorState: 'closed', config: BREAKER_CONFIG, wrapUpThreshold: WRAP_UP, nowMs: NOW,
    });
    expect(roomB.channelId).toBe('roomB');
    expect(roomB.suppressed).toBe(false);
    expect(roomB.state).toBe('closed');
  });
});
