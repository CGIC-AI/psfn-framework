import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { isInternalSessionId } from '../session/session-id.js';
import type { SessionEntry } from '../session/types.js';
import type {
  EpisodicProcessingRestWindowConfig,
  FreeTimeConfig,
} from '../../system/config/scheduler-config.js';
import { HEARTBEAT_SILENT_REFLECTION_TOKEN } from './heartbeat-policy.js';
import { Scheduler } from './scheduler.js';
import {
  buildFreeTimeContinuationPrompt,
  buildFreeTimeFramingPrompt,
  evaluateFreeTimeGate,
  evaluateFreeTimeLaneEligibility,
  FREE_TIME_CHANNEL_PREFIX,
  FREE_TIME_QUIET_HOURS_TASK_ID,
  FREE_TIME_RETURN_NOTE_SOURCE,
  registerFreeTimeTasks,
  runFreeTimeBlock,
  type FreeTimeBlockResult,
  type FreeTimeRuntimeOptions,
} from './free-time.js';

const restWindow: EpisodicProcessingRestWindowConfig = {
  enabled: true,
  startLocalTime: '00:00',
  endLocalTime: '09:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 180,
};

function freeTimeConfig(overrides: Partial<FreeTimeConfig> = {}): FreeTimeConfig {
  return {
    enabled: true,
    minBlockIntervalMinutes: 240,
    maxBlocksPerDay: 3,
    seedText: 'You have some time to yourself.',
    quietHours: { enabled: true, checkIntervalMs: 1_000 },
    idle: { enabled: true, checkIntervalMs: 1_000, minIdleMinutes: 180 },
    budget: { maxTurns: 6, maxChargeUnits: 8 },
    ...overrides,
  };
}

function entry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'role' | 'timestamp'>): SessionEntry {
  return {
    id: overrides.id ?? 1,
    channelId: overrides.channelId ?? 'api:main',
    content: overrides.content ?? 'hello',
    ...overrides,
  };
}

// ── Lane eligibility ──

describe('evaluateFreeTimeLaneEligibility', () => {
  const lastAt = Date.parse('2026-06-10T22:00:00.000Z');
  const insideWindowNow = Date.parse('2026-06-11T06:00:00.000Z');

  it('quiet-hours lane is eligible inside the rest window after inactivity', () => {
    const decision = evaluateFreeTimeLaneEligibility({
      lane: 'quiet_hours',
      session: { sessionId: 'api:main', channelType: 'api', timestamp: lastAt },
      recentEntries: [
        entry({ role: 'user', timestamp: lastAt - 60_000 }),
        entry({ role: 'assistant', timestamp: lastAt }),
      ],
      restWindow,
      idleMinIdleMinutes: 180,
      nowMs: insideWindowNow,
    });
    expect(decision.allowed).toBe(true);
  });

  it('quiet-hours lane is blocked outside the rest window', () => {
    const decision = evaluateFreeTimeLaneEligibility({
      lane: 'quiet_hours',
      session: { sessionId: 'api:main', channelType: 'api', timestamp: lastAt },
      recentEntries: [entry({ role: 'user', timestamp: lastAt })],
      restWindow,
      idleMinIdleMinutes: 180,
      nowMs: Date.parse('2026-06-11T14:00:00.000Z'),
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'outside_rest_window' });
  });

  it('idle lane is eligible after the idle gap regardless of time of day', () => {
    const daytimeNow = Date.parse('2026-06-11T15:00:00.000Z');
    const idleLastAt = Date.parse('2026-06-11T11:00:00.000Z'); // 4h earlier
    const decision = evaluateFreeTimeLaneEligibility({
      lane: 'idle',
      session: { sessionId: 'api:main', channelType: 'api', timestamp: idleLastAt },
      recentEntries: [
        entry({ role: 'user', timestamp: idleLastAt - 60_000 }),
        entry({ role: 'assistant', timestamp: idleLastAt }),
      ],
      restWindow,
      idleMinIdleMinutes: 180,
      nowMs: daytimeNow,
    });
    expect(decision.allowed).toBe(true);
  });

  it('idle lane is blocked below the idle threshold (active conversation)', () => {
    const now = Date.parse('2026-06-11T15:00:00.000Z');
    const decision = evaluateFreeTimeLaneEligibility({
      lane: 'idle',
      session: { sessionId: 'api:main', channelType: 'api', timestamp: now - 60_000 },
      recentEntries: [entry({ role: 'user', timestamp: now - 60_000 })],
      restWindow,
      idleMinIdleMinutes: 180,
      nowMs: now,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'below_idle_threshold' });
  });

  it('blocks public/broadcast surfaces at the privacy boundary', () => {
    const decision = evaluateFreeTimeLaneEligibility({
      lane: 'idle',
      session: { sessionId: 'twitter:timeline', channelType: 'api', timestamp: 1 },
      recentEntries: [entry({ channelId: 'twitter:timeline', role: 'user', timestamp: 1 })],
      restWindow,
      idleMinIdleMinutes: 180,
      nowMs: 10 * 60 * 60_000,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'privacy_boundary' });
  });
});

// ── Deterministic pre-spend gate ──

describe('evaluateFreeTimeGate', () => {
  const base = {
    activeConversationGuardMinutes: 180,
    minBlockIntervalMinutes: 240,
    maxBlocksPerDay: 3,
  };

  it('opens when the lane is eligible and no hard-close applies', () => {
    const decision = evaluateFreeTimeGate({
      ...base,
      laneEligible: true,
      minutesSincePartnerActivity: 480,
      minutesSinceLastBlock: 10_000,
      blocksToday: 0,
    });
    expect(decision).toMatchObject({ open: true, reason: 'open' });
  });

  it('stays closed when the lane is not eligible', () => {
    const decision = evaluateFreeTimeGate({
      ...base,
      laneEligible: false,
      minutesSincePartnerActivity: 480,
      minutesSinceLastBlock: 10_000,
      blocksToday: 0,
    });
    expect(decision).toMatchObject({ open: false, reason: 'lane_not_eligible' });
  });

  it('blocks during recent partner activity even when otherwise eligible', () => {
    const decision = evaluateFreeTimeGate({
      ...base,
      laneEligible: true,
      minutesSincePartnerActivity: 30,
      minutesSinceLastBlock: 10_000,
      blocksToday: 0,
    });
    expect(decision).toMatchObject({ open: false, reason: 'partner_recently_active' });
  });

  it('enforces the minimum interval between blocks', () => {
    const decision = evaluateFreeTimeGate({
      ...base,
      laneEligible: true,
      minutesSincePartnerActivity: 480,
      minutesSinceLastBlock: 60,
      blocksToday: 1,
    });
    expect(decision).toMatchObject({ open: false, reason: 'min_block_interval' });
  });

  it('enforces the daily block cap', () => {
    const decision = evaluateFreeTimeGate({
      ...base,
      laneEligible: true,
      minutesSincePartnerActivity: 480,
      minutesSinceLastBlock: 10_000,
      blocksToday: 3,
    });
    expect(decision).toMatchObject({ open: false, reason: 'daily_block_cap' });
  });
});

// ── Framing ──

describe('free-time framing', () => {
  it('leads with the full persona and open seed, with no forced-task language', () => {
    const prompt = buildFreeTimeFramingPrompt({
      personaBlock: 'I am Purrsephone, and this is me.',
      seedText: 'You have some time to yourself. You can do nothing if you want.',
    });
    expect(prompt).toContain('I am Purrsephone');
    expect(prompt).toContain('some time to yourself');
    expect(prompt).toContain(HEARTBEAT_SILENT_REFLECTION_TOKEN);
    expect(prompt).toContain('nothing here is sent to anyone');
    expect(prompt.toLowerCase()).not.toContain('you must');
    expect(prompt.toLowerCase()).not.toContain('your task');
  });

  it('continuation prompt keeps it optional', () => {
    const prompt = buildFreeTimeContinuationPrompt();
    expect(prompt).toContain(HEARTBEAT_SILENT_REFLECTION_TOKEN);
    expect(prompt.toLowerCase()).not.toContain('you must');
  });
});

// ── Block runner budget ──

describe('runFreeTimeBlock', () => {
  const baseInput = {
    lane: 'idle' as const,
    channelId: `${FREE_TIME_CHANNEL_PREFIX}idle`,
    framingPrompt: 'framing',
    now: () => 1_000,
  };

  it('records a first-turn stop as a valid zero-output loaf', async () => {
    const invokeTurn = vi.fn().mockResolvedValue({ content: HEARTBEAT_SILENT_REFLECTION_TOKEN });
    const result = await runFreeTimeBlock({
      ...baseInput,
      maxTurns: 6,
      maxChargeUnits: 8,
      readSpentChargeUnits: () => 0,
      invokeTurn,
    });
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ turnsUsed: 1, activity: false, endReason: 'loafed' });
  });

  it('continues while she engages and stops on a later stop signal', async () => {
    const invokeTurn = vi.fn()
      .mockResolvedValueOnce({ content: 'I wrote a little poem.' })
      .mockResolvedValueOnce({ content: 'I sketched an idea for the wiki.' })
      .mockResolvedValueOnce({ content: HEARTBEAT_SILENT_REFLECTION_TOKEN });
    const result = await runFreeTimeBlock({
      ...baseInput,
      maxTurns: 6,
      maxChargeUnits: 8,
      readSpentChargeUnits: () => 0,
      invokeTurn,
    });
    expect(invokeTurn).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ turnsUsed: 3, activity: true, endReason: 'companion_stopped' });
  });

  it('enforces the hard turn cap', async () => {
    const invokeTurn = vi.fn().mockResolvedValue({ content: 'still going' });
    const result = await runFreeTimeBlock({
      ...baseInput,
      maxTurns: 2,
      maxChargeUnits: 100,
      readSpentChargeUnits: () => 0,
      invokeTurn,
    });
    expect(invokeTurn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ turnsUsed: 2, activity: true, endReason: 'turns_exhausted' });
  });

  it('ends gracefully when the charge budget is exhausted', async () => {
    let spent = 0;
    const invokeTurn = vi.fn().mockImplementation(async () => {
      spent += 5; // each turn costs 5 units
      return { content: 'exploring' };
    });
    const result = await runFreeTimeBlock({
      ...baseInput,
      maxTurns: 10,
      maxChargeUnits: 8,
      readSpentChargeUnits: () => spent,
      invokeTurn,
    });
    // Turn 0 (spent 0<8) runs -> spent 5. Turn 1 (spent 5<8) runs -> spent 10.
    // Turn 2 blocked (spent 10>=8): graceful exhaustion.
    expect(invokeTurn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ endReason: 'charge_budget_exhausted' });
  });
});

// ── Runtime registration integration ──

interface FakeSessionManager {
  resolveStartupSessionMetadata: () => { sessionId: string; channelType: string; timestamp: number } | null;
  getRecentMessages: (channelId: string, limit?: number) => SessionEntry[];
  getRecentSessionEntries: (channelId: string, limit: number) => SessionEntry[];
  appendSystemNote: ReturnType<typeof vi.fn>;
  appendContextSystemNote: ReturnType<typeof vi.fn>;
}

function buildRuntime(options: {
  turnScript: string[];
  freeTimeTranscript?: SessionEntry[];
  config?: FreeTimeConfig;
  now: () => number;
}): {
  scheduler: Scheduler;
  sessionManager: FakeSessionManager;
  invokeTurn: ReturnType<typeof vi.fn>;
  runtime: FreeTimeRuntimeOptions;
  eventBus: EventBus;
} {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 500 });
  const lastAt = Date.parse('2026-06-10T22:00:00.000Z');
  const partnerEntries: SessionEntry[] = [
    entry({ id: 1, role: 'user', timestamp: lastAt - 60_000 }),
    entry({ id: 2, role: 'assistant', timestamp: lastAt }),
  ];
  const transcript = options.freeTimeTranscript ?? [];

  let turnIndex = 0;
  const invokeTurn = vi.fn().mockImplementation(async () => {
    const content = options.turnScript[turnIndex] ?? HEARTBEAT_SILENT_REFLECTION_TOKEN;
    turnIndex += 1;
    return { content };
  });

  const sessionManager: FakeSessionManager = {
    resolveStartupSessionMetadata: () => ({ sessionId: 'api:main', channelType: 'api', timestamp: lastAt }),
    getRecentMessages: (channelId) => (channelId === 'api:main' ? partnerEntries : []),
    getRecentSessionEntries: (channelId) => (channelId.startsWith(FREE_TIME_CHANNEL_PREFIX) ? transcript : partnerEntries),
    appendSystemNote: vi.fn(),
    appendContextSystemNote: vi.fn(),
  };

  const runtime: FreeTimeRuntimeOptions = {
    scheduler,
    sessionManager,
    config: options.config ?? freeTimeConfig(),
    restWindow,
    eventBus,
    resolvePersonaBlock: () => 'I am Purrsephone, and this is me.',
    runBlock: ({ run }) => run(() => 0),
    invokeTurn,
    summarizeActivity: async () => 'I worked on a small poem.',
    now: options.now,
  };

  return { scheduler, sessionManager, invokeTurn, runtime, eventBus };
}

describe('registerFreeTimeTasks', () => {
  it('runs a quiet-hours block only through an internal channel and never dispatches outward', async () => {
    let nowMs = Date.parse('2026-06-11T05:59:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const sent: unknown[] = [];
    try {
      const { scheduler, invokeTurn, runtime, eventBus } = buildRuntime({
        turnScript: ['I wrote a little poem.', HEARTBEAT_SILENT_REFLECTION_TOKEN],
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: Date.parse('2026-06-11T06:00:30.000Z'), content: 'I wrote a little poem.' }),
        ],
        now: () => nowMs,
      });
      eventBus.on('message.sent', (payload) => sent.push(payload));
      registerFreeTimeTasks(runtime);

      nowMs = Date.parse('2026-06-11T06:00:00.000Z');
      await scheduler.tick();

      expect(invokeTurn).toHaveBeenCalled();
      // Every turn ran on an internal free-time channel — structurally unable to leak.
      for (const call of invokeTurn.mock.calls) {
        const channelId = (call[0] as { channelId: string }).channelId;
        expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true);
        expect(isInternalSessionId(channelId)).toBe(true);
      }
      // No outbound message was emitted by the block.
      expect(sent).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('surfaces a "while you were away" note on the partner session after an ACTIVE block', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, sessionManager, runtime } = buildRuntime({
        turnScript: ['I wrote a little poem.', HEARTBEAT_SILENT_REFLECTION_TOKEN],
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: nowMs + 30_000, content: 'I wrote a little poem.' }),
        ],
        now: () => nowMs,
      });
      registerFreeTimeTasks(runtime);

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();

      expect(sessionManager.appendContextSystemNote).toHaveBeenCalledTimes(1);
      const [channelId, note, source] = sessionManager.appendContextSystemNote.mock.calls[0];
      expect(channelId).toBe('api:main'); // partner session, NOT the internal channel
      expect(source).toBe(FREE_TIME_RETURN_NOTE_SOURCE);
      expect(note).toContain('While you were away');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does NOT surface a return note after an empty "loafed" block', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, sessionManager, runtime } = buildRuntime({
        turnScript: [HEARTBEAT_SILENT_REFLECTION_TOKEN], // first-turn stop = loaf
        freeTimeTranscript: [],
        now: () => nowMs,
      });
      registerFreeTimeTasks(runtime);

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();

      expect(sessionManager.appendContextSystemNote).not.toHaveBeenCalled();
      // The block itself is still recorded on the internal transcript as a valid outcome.
      expect(sessionManager.appendSystemNote).toHaveBeenCalledTimes(1);
      const [, note] = sessionManager.appendSystemNote.mock.calls[0];
      expect(note).toContain('resting is a valid way');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('anti-loops within the minimum block interval on the next tick', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, invokeTurn, runtime } = buildRuntime({
        turnScript: ['I wrote a little poem.', HEARTBEAT_SILENT_REFLECTION_TOKEN],
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: nowMs + 30_000, content: 'poem' }),
        ],
        now: () => nowMs,
      });
      registerFreeTimeTasks(runtime);

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();
      const firstCallCount = invokeTurn.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // 30 minutes later — still inside the 240-minute min interval.
      nowMs += 30 * 60_000;
      await scheduler.tick();
      expect(invokeTurn.mock.calls.length).toBe(firstCallCount);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('emits a block event with visible spend and activity', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const blocks: Array<{ activity: boolean; endReason: string }> = [];
    try {
      const { scheduler, runtime, eventBus } = buildRuntime({
        turnScript: ['I wrote a little poem.', HEARTBEAT_SILENT_REFLECTION_TOKEN],
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: nowMs + 30_000, content: 'poem' }),
        ],
        now: () => nowMs,
      });
      eventBus.on('scheduler.free_time.block', (payload) => blocks.push({ activity: payload.activity, endReason: payload.endReason }));
      registerFreeTimeTasks(runtime);

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ activity: true, endReason: 'companion_stopped' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('is denied when the scheduler write-budget eligibility gate blocks the task', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const eventBus = new EventBus();
      const gate = createEligibilityGate(() => ({
        getTier: () => 'custom',
        getGrantedTokens: () => new Set(),
        has: () => false,
      }));
      const scheduler = new Scheduler(
        eventBus,
        { tickIntervalMs: 100, heartbeatIntervalMs: 500 },
        { eligibilityGate: gate },
      );
      const invokeTurn = vi.fn();
      registerFreeTimeTasks({
        scheduler,
        sessionManager: {
          resolveStartupSessionMetadata: () => ({ sessionId: 'api:main', channelType: 'api', timestamp: nowMs - 8 * 60 * 60_000 }),
          getRecentMessages: () => [entry({ role: 'user', timestamp: nowMs - 8 * 60 * 60_000 })],
          getRecentSessionEntries: () => [],
          appendSystemNote: vi.fn(),
          appendContextSystemNote: vi.fn(),
        },
        config: freeTimeConfig(),
        restWindow,
        eventBus,
        resolvePersonaBlock: () => 'persona',
        runBlock: ({ run }) => run(() => 0),
        invokeTurn,
        now: () => nowMs,
      });

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();

      expect(invokeTurn).not.toHaveBeenCalled();
      expect(scheduler.getTask(FREE_TIME_QUIET_HOURS_TASK_ID)).toMatchObject({
        lastOutcome: 'denied',
        lastDeniedReason: 'missing_capability_tokens',
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
