import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import { summarizeRecentSessionEntries } from '../session/manager/compaction-service.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { isInternalSessionId } from '../session/session-id.js';
import type { SessionEntry } from '../session/types.js';
import type {
  EpisodicProcessingRestWindowConfig,
  FreeTimeConfig,
} from '../../system/config/scheduler-config.js';
import { REFLECTION_SILENT_TOKEN } from './reflection-policy.js';
import { Scheduler } from './scheduler.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
  type DisclosureDestinationConstraint,
  type DisclosureLineage,
} from '../cogsec/disclosure/index.js';
import type { ContextEnvelope } from '../../system/trust/context-envelope.js';
import {
  resolveFreeTimeWorkspace,
  type FreeTimeWorkspace,
  type FreeTimeWorkspaceResolverDeps,
} from './free-time-workspace-resolver.js';
import type { FreeTimeChooserOutcome } from './free-time-chooser.js';
import {
  buildFreeTimeContinuationPrompt,
  buildFreeTimeFramingPrompt,
  evaluateFreeTimeGate,
  evaluateFreeTimeLaneEligibility,
  FREE_TIME_CHANNEL_PREFIX,
  FREE_TIME_DEFAULT_WORKSPACE_SEGMENT,
  FREE_TIME_IDLE_TASK_ID,
  FREE_TIME_QUIET_HOURS_TASK_ID,
  FREE_TIME_RETURN_NOTE_SOURCE,
  freeTimeWorkspaceChannelId,
  buildFreeTimeBlockNote,
  registerFreeTimeTasks,
  runFreeTimeBlock,
  type FreeTimeBlockRecord,
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
    returnNote: { summaryMaxTokens: 160 },
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

/**
 * Build a single-source disclosure lineage (via the landed accumulator) that
 * permits exactly one contact's DM at `personal` sensitivity — enough to prove
 * the return-note projection filters per contact.
 */
function disclosureLineage(input: { ref: string; permittedContactId: string }): DisclosureLineage {
  const permitted: DisclosureDestinationConstraint[] = [
    { kind: 'contact_dm', contactIds: [input.permittedContactId] },
  ];
  return accumulateDisclosureSource(
    beginDisclosureAccumulation({
      generationContextRef: `gen:${input.ref}`,
      classifierVersion: 'test',
      classifiedAt: '2026-07-20T00:00:00.000Z',
    }),
    {
      ref: input.ref,
      sensitivity: 'personal',
      permittedDestinations: permitted,
      subjectContactIds: [input.permittedContactId],
      classified: true,
    },
  );
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
  it('uses only free-time framing and the open seed, with no duplicated persona text', () => {
    const prompt = buildFreeTimeFramingPrompt({
      seedText: 'You have some time to yourself. You can do nothing if you want.',
    });
    expect(prompt.startsWith('[Free time]\n\n')).toBe(true);
    expect(prompt).not.toContain('I am Purrsephone');
    expect(prompt).not.toContain('PERSONALITY_SENTINEL');
    expect(prompt).not.toContain('DESCRIPTION_SENTINEL');
    expect(prompt).not.toContain('SCENARIO_SENTINEL');
    expect(prompt).toContain('some time to yourself');
    expect(prompt).toContain(REFLECTION_SILENT_TOKEN);
    expect(prompt).toContain('nothing here is sent to anyone');
    expect(prompt.toLowerCase()).not.toContain('you must');
    expect(prompt.toLowerCase()).not.toContain('your task');
  });

  it('continuation prompt keeps it optional', () => {
    const prompt = buildFreeTimeContinuationPrompt();
    expect(prompt).toContain(REFLECTION_SILENT_TOKEN);
    expect(prompt.toLowerCase()).not.toContain('you must');
  });

  it('places an active project intention and recent artifacts in the opening frame', () => {
    const prompt = buildFreeTimeFramingPrompt({
      seedText: 'You have some time to yourself.',
      projectContext: [
        '[Returning to one of your projects]',
        'Project: Moon Garden (project:moon-garden)',
        'Your last intention: paint the second panel.',
        'Recent artifacts: panel-one.png',
      ].join('\n'),
    });

    expect(prompt).toContain('project:moon-garden');
    expect(prompt).toContain('Your last intention: paint the second panel.');
    expect(prompt.indexOf('Returning to one of your projects'))
      .toBeLessThan(prompt.indexOf('There is no task and nothing to prove'));
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
    const invokeTurn = vi.fn().mockResolvedValue({ content: REFLECTION_SILENT_TOKEN });
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
      .mockResolvedValueOnce({ content: REFLECTION_SILENT_TOKEN });
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
  resolveStartupSessionMetadata: () => {
    sessionId: string;
    channelType: string;
    timestamp: number;
    lastRole?: SessionEntry['role'];
  } | null;
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
  const invokeTurn = vi.fn(async (_input: {
    lane: 'quiet_hours' | 'idle';
    channelId: string;
    turnIndex: number;
    content: string;
  }) => {
    const content = options.turnScript[turnIndex] ?? REFLECTION_SILENT_TOKEN;
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
    runBlock: ({ run }) => run(() => 0),
    invokeTurn,
    summarizeActivity: async () => 'I worked on a small poem.',
    now: options.now,
  };

  return { scheduler, sessionManager, invokeTurn, runtime, eventBus };
}

describe('registerFreeTimeTasks', () => {
  it.each([
    ['quiet_hours', FREE_TIME_QUIET_HOURS_TASK_ID],
    ['idle', FREE_TIME_IDLE_TASK_ID],
  ] as const)('%s lane rejects recent partner metadata without reading session entries', async (lane, taskId) => {
    const nowMs = lane === 'quiet_hours'
      ? Date.parse('2026-06-11T06:00:00.000Z')
      : Date.parse('2026-06-11T15:00:00.000Z');
    const { scheduler, sessionManager, invokeTurn, runtime, eventBus } = buildRuntime({
      turnScript: ['should not run'],
      config: freeTimeConfig({
        quietHours: { enabled: lane === 'quiet_hours', checkIntervalMs: 1_000 },
        idle: { enabled: lane === 'idle', checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => nowMs,
    });
    const getRecentMessages = vi.fn(() => []);
    const getRecentSessionEntries = vi.fn(() => []);
    sessionManager.resolveStartupSessionMetadata = () => ({
      sessionId: 'api:main',
      channelType: 'api',
      timestamp: nowMs - 30 * 60_000,
      lastRole: 'user',
    });
    sessionManager.getRecentMessages = getRecentMessages;
    sessionManager.getRecentSessionEntries = getRecentSessionEntries;
    const gateReasons: string[] = [];
    eventBus.on('scheduler.free_time.gate', payload => gateReasons.push(payload.reason));
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(taskId)?.handler;
    if (!handler) throw new Error(`${lane} free-time task was not registered`);
    await handler();

    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(getRecentSessionEntries).not.toHaveBeenCalled();
    expect(invokeTurn).not.toHaveBeenCalled();
    expect(gateReasons).toEqual([`${lane}:partner_recently_active`]);
  });

  it('does not treat a recent system index row as recent partner activity', async () => {
    const nowMs = Date.parse('2026-06-11T15:00:00.000Z');
    const { scheduler, sessionManager, invokeTurn, runtime } = buildRuntime({
      turnScript: [REFLECTION_SILENT_TOKEN],
      config: freeTimeConfig({
        quietHours: { enabled: false, checkIntervalMs: 1_000 },
        idle: { enabled: true, checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => nowMs,
    });
    const originalGetRecentMessages = sessionManager.getRecentMessages;
    const getRecentMessages = vi.fn(originalGetRecentMessages);
    sessionManager.resolveStartupSessionMetadata = () => ({
      sessionId: 'api:main',
      channelType: 'api',
      timestamp: nowMs - 30 * 60_000,
      lastRole: 'system',
    });
    sessionManager.getRecentMessages = getRecentMessages;
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(FREE_TIME_IDLE_TASK_ID)?.handler;
    if (!handler) throw new Error('idle free-time task was not registered');
    await handler();

    expect(getRecentMessages).toHaveBeenCalledTimes(1);
    expect(invokeTurn).toHaveBeenCalledTimes(1);
  });

  it('runs a quiet-hours block only through an internal channel and never dispatches outward', async () => {
    let nowMs = Date.parse('2026-06-11T05:59:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const sent: unknown[] = [];
    try {
      const { scheduler, invokeTurn, runtime, eventBus } = buildRuntime({
        turnScript: ['I wrote a little poem.', REFLECTION_SILENT_TOKEN],
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
        const turn = call[0];
        const channelId = turn.channelId;
        expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true);
        expect(isInternalSessionId(channelId)).toBe(true);
        expect(turn.audience).toBe('self');
        expect(turn.content).not.toContain('I am Purrsephone');
      }
      // No outbound message was emitted by the block.
      expect(sent).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('loads one active project before the first free-time turn', async () => {
    const nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const { scheduler, invokeTurn, runtime } = buildRuntime({
      turnScript: [REFLECTION_SILENT_TOKEN],
      now: () => nowMs,
    });
    const loadProjectContext = vi.fn(async () => [
      '[Returning to one of your projects]',
      'Project: Story Panels (project:story-panels)',
      'Your last intention: render the opening scene.',
    ].join('\n'));
    runtime.loadProjectContext = loadProjectContext;
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(FREE_TIME_QUIET_HOURS_TASK_ID)?.handler;
    if (!handler) throw new Error('quiet-hours free-time task was not registered');
    await handler();

    expect(loadProjectContext).toHaveBeenCalledTimes(1);
    expect(invokeTurn.mock.calls[0]?.[0].content).toContain('project:story-panels');
    expect(invokeTurn.mock.calls[0]?.[0].content).toContain('render the opening scene');
  });

  it('keeps an unanchored "while you were away" note on the private internal workspace', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, sessionManager, runtime } = buildRuntime({
        turnScript: ['I wrote a little poem.', REFLECTION_SILENT_TOKEN],
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
      expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true);
      expect(channelId).not.toBe('api:main');
      expect(source).toBe(FREE_TIME_RETURN_NOTE_SOURCE);
      expect(note).toContain('While you were away');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('DM-targeted return note summarizes ONLY destination-eligible evidence (multi-contact)', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, sessionManager, runtime } = buildRuntime({
        turnScript: ['about contact A', REFLECTION_SILENT_TOKEN],
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: nowMs + 10_000, content: 'note about contact A' }),
          entry({ id: 11, role: 'assistant', timestamp: nowMs + 20_000, content: 'note about contact B' }),
        ],
        now: () => nowMs,
      });

      const summarizeActivity = vi.fn(async (input: { entries: readonly SessionEntry[] }) => {
        return input.entries.map(e => e.content).join(' | ');
      });
      runtime.summarizeActivity = summarizeActivity;
      runtime.resolveReturnDestination = () => ({ kind: 'contact_dm', contactId: 'contact-a' });
      runtime.resolveContactDmSessionId = (id) => (id === 'contact-a' ? 'discord:dm-a' : null);
      const lineages = new Map<number, DisclosureLineage>([
        [10, disclosureLineage({ ref: 'mem:a', permittedContactId: 'contact-a' })],
        [11, disclosureLineage({ ref: 'mem:b', permittedContactId: 'contact-b' })],
      ]);
      runtime.resolveEntryDisclosureLineage = (e) => lineages.get(e.id);

      registerFreeTimeTasks(runtime);
      nowMs += 2_000;
      await scheduler.tick();

      // The summarizer saw ONLY the contact-A entry; contact-B never reached it.
      expect(summarizeActivity).toHaveBeenCalledTimes(1);
      const seen = summarizeActivity.mock.calls[0]?.[0].entries ?? [];
      expect(seen.map(e => e.id)).toEqual([10]);
      // Route AND destination agree: contact-A eligible content lands in contact-A's
      // resolved DM session, never the latest eligible partner session.
      const [channelId, note] = sessionManager.appendContextSystemNote.mock.calls[0];
      expect(channelId).toBe('discord:dm-a');
      expect(note).toContain('note about contact A');
      expect(note).not.toContain('note about contact B');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('collapses to a content-free note when nothing is eligible for the outward destination', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, sessionManager, runtime } = buildRuntime({
        turnScript: ['about contact B', REFLECTION_SILENT_TOKEN],
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: nowMs + 10_000, content: 'note about contact B' }),
        ],
        now: () => nowMs,
      });

      const summarizeActivity = vi.fn(async () => 'should not be called');
      runtime.summarizeActivity = summarizeActivity;
      // Target contact A (DM resolves), but the only evidence belongs to contact B
      // → projection collapse. The content-free note must land on private/self,
      // NEVER in contact A's DM.
      runtime.resolveReturnDestination = () => ({ kind: 'contact_dm', contactId: 'contact-a' });
      runtime.resolveContactDmSessionId = (id) => (id === 'contact-a' ? 'discord:dm-a' : null);
      runtime.resolveEntryDisclosureLineage = () =>
        disclosureLineage({ ref: 'mem:b', permittedContactId: 'contact-b' });

      registerFreeTimeTasks(runtime);
      nowMs += 2_000;
      await scheduler.tick();

      // Fail-closed collapse: no summary generated, content-free self note only.
      expect(summarizeActivity).not.toHaveBeenCalled();
      expect(sessionManager.appendContextSystemNote).toHaveBeenCalledTimes(1);
      const [channelId, note] = sessionManager.appendContextSystemNote.mock.calls[0];
      expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true);
      expect(channelId).not.toBe('api:main');
      expect(note).toContain('While you were away');
      expect(note).not.toContain('Here is what I got up to');
      expect(note).not.toContain('contact B');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does NOT surface a return note after an empty "loafed" block', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const { scheduler, sessionManager, runtime } = buildRuntime({
        turnScript: [REFLECTION_SILENT_TOKEN], // first-turn stop = loaf
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
      const { scheduler, sessionManager, invokeTurn, runtime, eventBus } = buildRuntime({
        // A non-silent, turns-exhausted block so the NEXT tick is gated by the
        // block interval — not by the bead 75ci silent-exit suppression.
        turnScript: ['I wrote a little poem.'],
        config: freeTimeConfig({ budget: { maxTurns: 1, maxChargeUnits: 8 } }),
        freeTimeTranscript: [
          entry({ id: 10, role: 'assistant', timestamp: nowMs + 30_000, content: 'poem' }),
        ],
        now: () => nowMs,
      });
      const originalGetRecentMessages = sessionManager.getRecentMessages;
      const originalGetRecentSessionEntries = sessionManager.getRecentSessionEntries;
      const getRecentMessages = vi.fn(originalGetRecentMessages);
      const getRecentSessionEntries = vi.fn(originalGetRecentSessionEntries);
      sessionManager.getRecentMessages = getRecentMessages;
      sessionManager.getRecentSessionEntries = getRecentSessionEntries;
      const gateReasons: string[] = [];
      eventBus.on('scheduler.free_time.gate', payload => gateReasons.push(payload.reason));
      registerFreeTimeTasks(runtime);

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();
      const firstCallCount = invokeTurn.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);
      expect(getRecentMessages).toHaveBeenCalled();
      expect(getRecentSessionEntries).toHaveBeenCalled();
      getRecentMessages.mockClear();
      getRecentSessionEntries.mockClear();
      gateReasons.length = 0;

      // 30 minutes later — still inside the 240-minute min interval.
      nowMs += 30 * 60_000;
      await scheduler.tick();
      expect(invokeTurn.mock.calls.length).toBe(firstCallCount);
      expect(getRecentMessages).not.toHaveBeenCalled();
      expect(getRecentSessionEntries).not.toHaveBeenCalled();
      expect(gateReasons).toContain('quiet_hours:min_block_interval');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('enforces the shared daily cap before rereading an unchanged session', async () => {
    let nowMs = Date.parse('2026-06-11T01:00:00.000Z');
    const { scheduler, sessionManager, invokeTurn, runtime, eventBus } = buildRuntime({
      // A non-silent, turns-exhausted block so the NEXT tick is gated by the
      // daily cap — not by the bead 75ci silent-exit suppression.
      turnScript: ['I journaled a little.'],
      config: freeTimeConfig({
        maxBlocksPerDay: 1,
        budget: { maxTurns: 1, maxChargeUnits: 8 },
        quietHours: { enabled: true, checkIntervalMs: 1_000 },
        idle: { enabled: false, checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => nowMs,
    });
    const originalGetRecentMessages = sessionManager.getRecentMessages;
    const originalGetRecentSessionEntries = sessionManager.getRecentSessionEntries;
    const getRecentMessages = vi.fn(originalGetRecentMessages);
    const getRecentSessionEntries = vi.fn(originalGetRecentSessionEntries);
    sessionManager.getRecentMessages = getRecentMessages;
    sessionManager.getRecentSessionEntries = getRecentSessionEntries;
    const gateReasons: string[] = [];
    eventBus.on('scheduler.free_time.gate', payload => gateReasons.push(payload.reason));
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(FREE_TIME_QUIET_HOURS_TASK_ID)?.handler;
    if (!handler) throw new Error('quiet-hours free-time task was not registered');
    await handler();
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    getRecentMessages.mockClear();
    getRecentSessionEntries.mockClear();
    gateReasons.length = 0;

    nowMs += 5 * 60 * 60_000;
    await handler();

    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(getRecentSessionEntries).not.toHaveBeenCalled();
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    expect(gateReasons).toEqual(['quiet_hours:daily_block_cap']);
  });

  it('suppresses further free-time blocks for the rest of the day after a silent exit (bead 75ci)', async () => {
    let nowMs = Date.parse('2026-06-11T01:00:00.000Z');
    const { scheduler, invokeTurn, runtime, eventBus } = buildRuntime({
      // First (and only) turn is silent — the block ends 'loafed'.
      turnScript: [REFLECTION_SILENT_TOKEN],
      config: freeTimeConfig({
        quietHours: { enabled: true, checkIntervalMs: 1_000 },
        idle: { enabled: false, checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => nowMs,
    });
    const gateReasons: string[] = [];
    eventBus.on('scheduler.free_time.gate', payload => gateReasons.push(payload.reason));
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(FREE_TIME_QUIET_HOURS_TASK_ID)?.handler;
    if (!handler) throw new Error('quiet-hours free-time task was not registered');
    await handler();
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    gateReasons.length = 0;

    // Well past the 240-minute min-block interval, still the same local day: the
    // silent exit — not the interval or daily cap — must keep the gate closed.
    nowMs += 5 * 60 * 60_000;
    await handler();
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    expect(gateReasons).toEqual(['quiet_hours:silenced_after_stop']);
  });

  it('does not suppress after a block that ended normally (bead 75ci)', async () => {
    let nowMs = Date.parse('2026-06-11T01:00:00.000Z');
    const { scheduler, invokeTurn, runtime, eventBus } = buildRuntime({
      // A single non-silent turn with maxTurns=1 ends 'turns_exhausted', not a
      // silent exit — the gate must reopen after the interval.
      turnScript: ['I journaled for a bit.', 'Still going.'],
      config: freeTimeConfig({
        budget: { maxTurns: 1, maxChargeUnits: 8 },
        quietHours: { enabled: true, checkIntervalMs: 1_000 },
        idle: { enabled: false, checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => nowMs,
    });
    const gateReasons: string[] = [];
    eventBus.on('scheduler.free_time.gate', payload => gateReasons.push(payload.reason));
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(FREE_TIME_QUIET_HOURS_TASK_ID)?.handler;
    if (!handler) throw new Error('quiet-hours free-time task was not registered');
    await handler();
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    gateReasons.length = 0;

    nowMs += 5 * 60 * 60_000;
    await handler();
    expect(invokeTurn).toHaveBeenCalledTimes(2);
    expect(gateReasons).not.toContain('quiet_hours:silenced_after_stop');
  });

  it('emits a block event with visible spend and activity', async () => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const blocks: Array<{ activity: boolean; endReason: string }> = [];
    try {
      const { scheduler, runtime, eventBus } = buildRuntime({
        turnScript: ['I wrote a little poem.', REFLECTION_SILENT_TOKEN],
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

// ── Free-time return summary lane (psfn-framework-zpgz) ──

describe('free-time return summary lane', () => {
  it('summarizeRecentSessionEntries carries the free_time_return purpose into correlation metadata', async () => {
    const complete = vi.fn<LLMProviderPort['complete']>().mockResolvedValue({
      content: 'Wandered the wiki and wrote a poem.',
      model: 'test',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const stream = vi.fn<LLMProviderPort['stream']>().mockResolvedValue({
      content: 'Wandered the wiki and wrote a poem.',
      model: 'test',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const summary = await summarizeRecentSessionEntries({
      channelId: 'internal:free-time:quiet-hours',
      entries: [
        entry({ role: 'assistant', timestamp: 1_000, content: 'I wrote a poem about sunbeams.' }),
      ],
      characterName: 'Companion',
      llmProvider: { complete, stream },
      promptRegistry: null,
      maxTokens: 160,
      purpose: 'free_time_return',
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
    const [context, positionalPurpose, options] = complete.mock.calls[0] ?? [];
    // completeWithWorkSpec strips correlation from prompt context and owns it
    // on the typed completion options/work spec.
    expect(context.correlation).toBeUndefined();
    expect(positionalPurpose).toBe('background');
    expect(options?.workSpec).toMatchObject({
      purpose: 'background',
      durable: false,
      correlation: {
        callType: 'summary',
        purpose: 'session.recent.summary',
        originType: 'summary',
        originStage: 'session.recent.summary.free_time_return',
        channelId: 'internal:free-time:quiet-hours',
        requestId: expect.stringContaining('free_time_return'),
      },
    });
    expect(options?.correlation).toEqual(options?.workSpec?.correlation);
    expect(summary).toBe('Wandered the wiki and wrote a poem.');
  });

  it('the free-time lane wires summarizeActivity with the free_time_return purpose and the freeTime-owned budget', () => {
    // The wiring moved from agent/main.ts to the extracted lane module
    // (charter 12.1 split, emh3p.1); the contract being pinned is unchanged.
    const source = readFileSync(resolve('src/app/agent/startup/free-time-lane.ts'), 'utf-8');
    const start = source.indexOf('registerFreeTimeTasks({');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start);
    expect(block).toContain("purpose: 'free_time_return'");
    expect(block).toContain('config.returnNote.summaryMaxTokens');
    expect(block).not.toContain('catchUpSummaryMaxTokens');
  });
});

// ── Lane-independent continuity identity (bible §10.4) ──
// The scheduler trigger lane (quiet-hours vs idle) must NEVER appear in the
// free-time transcript identity: both lanes resume the SAME chosen workspace
// session. These regressions pin that the resolved channel is workspace-keyed,
// never lane-keyed, and that the optional resolver seam overrides it uniformly.

describe('free-time continuity identity is lane-independent', () => {
  it('freeTimeWorkspaceChannelId resolves the default continuity session, never a lane', () => {
    const expectedDefault = `${FREE_TIME_CHANNEL_PREFIX}${FREE_TIME_DEFAULT_WORKSPACE_SEGMENT}`;
    expect(freeTimeWorkspaceChannelId()).toBe(expectedDefault);
    expect(freeTimeWorkspaceChannelId()).toBe('internal:free-time:wandering');
    // Missing / empty / whitespace segment falls back to the shared default.
    expect(freeTimeWorkspaceChannelId(undefined)).toBe(expectedDefault);
    expect(freeTimeWorkspaceChannelId(null)).toBe(expectedDefault);
    expect(freeTimeWorkspaceChannelId('')).toBe(expectedDefault);
    expect(freeTimeWorkspaceChannelId('   ')).toBe(expectedDefault);
    // A chosen workspace segment is preserved verbatim under the same prefix.
    expect(freeTimeWorkspaceChannelId('project:story-panels'))
      .toBe('internal:free-time:project:story-panels');
    // The trigger-lane names never leak into the resolved identity.
    expect(freeTimeWorkspaceChannelId()).not.toContain('quiet-hours');
    expect(freeTimeWorkspaceChannelId()).not.toContain('idle');
  });

  async function runLaneBlock(input: {
    lane: 'quiet_hours' | 'idle';
    nowMs: number;
    resolveWorkspaceChannelId?: () => string;
  }): Promise<{
    turnChannelId: string;
    blockNoteChannelId: string;
    gateChannelIds: string[];
  }> {
    const { scheduler, sessionManager, invokeTurn, runtime, eventBus } = buildRuntime({
      // First-turn stop = valid "loaf": one turn still runs (channel captured),
      // then the block records its provenance note on the same channel.
      turnScript: [REFLECTION_SILENT_TOKEN],
      config: freeTimeConfig({
        quietHours: { enabled: input.lane === 'quiet_hours', checkIntervalMs: 1_000 },
        idle: { enabled: input.lane === 'idle', checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => input.nowMs,
    });
    if (input.resolveWorkspaceChannelId) {
      runtime.resolveWorkspaceChannelId = input.resolveWorkspaceChannelId;
    }
    const gateChannelIds: string[] = [];
    eventBus.on('scheduler.free_time.gate', payload => {
      if (typeof payload.channelId === 'string') gateChannelIds.push(payload.channelId);
    });
    registerFreeTimeTasks(runtime);

    const taskId = input.lane === 'quiet_hours'
      ? FREE_TIME_QUIET_HOURS_TASK_ID
      : FREE_TIME_IDLE_TASK_ID;
    const handler = scheduler.getTask(taskId)?.handler;
    if (!handler) throw new Error(`${input.lane} free-time task was not registered`);
    await handler();

    expect(invokeTurn).toHaveBeenCalled();
    expect(sessionManager.appendSystemNote).toHaveBeenCalled();
    return {
      turnChannelId: invokeTurn.mock.calls[0]?.[0].channelId as string,
      blockNoteChannelId: sessionManager.appendSystemNote.mock.calls[0]?.[0] as string,
      gateChannelIds,
    };
  }

  const QUIET_NOW = Date.parse('2026-06-11T06:00:00.000Z'); // inside rest window
  const IDLE_NOW = Date.parse('2026-06-11T15:00:00.000Z'); // outside rest window

  it('quiet-hours and idle blocks converge on the same default continuity session', async () => {
    const quiet = await runLaneBlock({ lane: 'quiet_hours', nowMs: QUIET_NOW });
    const idle = await runLaneBlock({ lane: 'idle', nowMs: IDLE_NOW });

    // Identical, workspace-keyed identity across lanes — the acceptance criterion.
    expect(quiet.turnChannelId).toBe(idle.turnChannelId);
    expect(quiet.turnChannelId).toBe(freeTimeWorkspaceChannelId());
    // Provenance note lands on the same continuity channel, not a lane channel.
    expect(quiet.blockNoteChannelId).toBe(quiet.turnChannelId);
    expect(idle.blockNoteChannelId).toBe(idle.turnChannelId);
    // The old lane-keyed identities are gone.
    expect(quiet.turnChannelId).not.toBe(`${FREE_TIME_CHANNEL_PREFIX}quiet-hours`);
    expect(idle.turnChannelId).not.toBe(`${FREE_TIME_CHANNEL_PREFIX}idle`);
    // Gate telemetry is lane-independent too.
    expect(quiet.gateChannelIds).toEqual([freeTimeWorkspaceChannelId()]);
    expect(idle.gateChannelIds).toEqual([freeTimeWorkspaceChannelId()]);
  });

  it('a resolved workspace overrides the continuity channel identically for both lanes', async () => {
    const resolveWorkspaceChannelId = () => `${FREE_TIME_CHANNEL_PREFIX}project:story-panels`;
    const quiet = await runLaneBlock({ lane: 'quiet_hours', nowMs: QUIET_NOW, resolveWorkspaceChannelId });
    const idle = await runLaneBlock({ lane: 'idle', nowMs: IDLE_NOW, resolveWorkspaceChannelId });

    expect(quiet.turnChannelId).toBe(idle.turnChannelId);
    expect(quiet.turnChannelId).toBe('internal:free-time:project:story-panels');
    expect(quiet.blockNoteChannelId).toBe('internal:free-time:project:story-panels');
    expect(idle.blockNoteChannelId).toBe('internal:free-time:project:story-panels');
  });

  it('does not invoke the workspace resolver on a gate-skipped tick', async () => {
    const resolveWorkspaceChannelId = vi.fn(() => `${FREE_TIME_CHANNEL_PREFIX}project:story-panels`);
    // Recent partner activity closes the gate before any spend decision.
    const nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const { scheduler, sessionManager, invokeTurn, runtime } = buildRuntime({
      turnScript: ['should not run'],
      config: freeTimeConfig({
        quietHours: { enabled: true, checkIntervalMs: 1_000 },
        idle: { enabled: false, checkIntervalMs: 1_000, minIdleMinutes: 180 },
      }),
      now: () => nowMs,
    });
    runtime.resolveWorkspaceChannelId = resolveWorkspaceChannelId;
    sessionManager.resolveStartupSessionMetadata = () => ({
      sessionId: 'api:main',
      channelType: 'api',
      timestamp: nowMs - 30 * 60_000,
      lastRole: 'user',
    });
    registerFreeTimeTasks(runtime);

    const handler = scheduler.getTask(FREE_TIME_QUIET_HOURS_TASK_ID)?.handler;
    if (!handler) throw new Error('quiet-hours free-time task was not registered');
    await handler();

    expect(invokeTurn).not.toHaveBeenCalled();
    expect(resolveWorkspaceChannelId).not.toHaveBeenCalled();
  });
});

// ── Workspace-resolved return-note routing (bible §10.8, jp36.2.3.1) ──
// The return note is routed by the RESOLVED WORKSPACE return policy, never the
// latest eligible session. The disclosure destination fed to the summarizer
// projection and the append target are derived from the SAME return policy, so
// route and destination can never disagree. Unresolvable contact/room and
// projection collapse fail closed to a content-free private/self note. The note
// is always an attributed SYSTEM note (never partner speech) and non-initiating.

const ROUTING_INVITE_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'invite_only',
  audienceScope: 'group',
  audienceKnowledge: 'all_known',
  broadcast: false,
};

function routingDeps(overrides: Partial<FreeTimeWorkspaceResolverDeps> = {}): FreeTimeWorkspaceResolverDeps {
  return { projectDirectory: () => null, roomChannelResolver: () => null, ...overrides };
}

/** Wrap a resolved workspace in a chooser 'workspace' outcome the runtime consumes. */
function workspaceOutcome(workspace: FreeTimeWorkspace): FreeTimeChooserOutcome {
  return {
    kind: 'workspace',
    optionId: 'opt-test',
    label: 'my workspace',
    choice: { kind: 'private_wander' },
    workspace,
  };
}

/** A room-eligible lineage permitting exactly one room channel at public sensitivity. */
function roomDisclosureLineage(input: { ref: string; channelId: string }): DisclosureLineage {
  return accumulateDisclosureSource(
    beginDisclosureAccumulation({
      generationContextRef: `gen:${input.ref}`,
      classifierVersion: 'test',
      classifiedAt: '2026-07-20T00:00:00.000Z',
    }),
    {
      ref: input.ref,
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'invite_only_room', channelIds: [input.channelId] }],
      subjectContactIds: [],
      classified: true,
    },
  );
}

async function runActiveWorkspaceBlock(input: {
  workspace: FreeTimeWorkspace;
  transcript: SessionEntry[];
  configure?: (runtime: FreeTimeRuntimeOptions) => void;
}): Promise<{ appendContextSystemNote: ReturnType<typeof vi.fn>; summarizeActivity: ReturnType<typeof vi.fn>; invokeTurn: ReturnType<typeof vi.fn> }> {
  let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  try {
    const { scheduler, sessionManager, invokeTurn, runtime } = buildRuntime({
      turnScript: ['I made something.', REFLECTION_SILENT_TOKEN],
      freeTimeTranscript: input.transcript,
      now: () => nowMs,
    });
    const summarizeActivity = vi.fn(async (args: { entries: readonly SessionEntry[] }) =>
      args.entries.map(e => e.content).join(' | '));
    runtime.summarizeActivity = summarizeActivity;
    runtime.chooseWorkspace = async () => workspaceOutcome(input.workspace);
    input.configure?.(runtime);
    registerFreeTimeTasks(runtime);

    nowMs += 2_000;
    await scheduler.tick();
    return {
      appendContextSystemNote: sessionManager.appendContextSystemNote,
      summarizeActivity,
      invokeTurn,
    };
  } finally {
    nowSpy.mockRestore();
  }
}

describe('workspace-resolved return-note routing', () => {
  it('private_self workspace → full-fidelity content note on its internal session', async () => {
    const workspace = resolveFreeTimeWorkspace({ kind: 'private_wander' }, routingDeps());
    expect(workspace.returnPolicy).toEqual({ kind: 'private_self' });
    const { appendContextSystemNote, invokeTurn } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'a private poem' })],
    });
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
    const [channelId, note, source] = appendContextSystemNote.mock.calls[0];
    expect(channelId).toBe(invokeTurn.mock.calls[0]?.[0].channelId);
    expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true);
    expect(channelId).not.toBe('api:main');
    expect(source).toBe(FREE_TIME_RETURN_NOTE_SOURCE);
    expect(note).toContain('Here is what I got up to: a private poem');
  });

  it('contact-anchored workspace → content note routed to that contact\'s resolved DM', async () => {
    const workspace = resolveFreeTimeWorkspace(
      { kind: 'private_wander', returnTarget: { contactId: 'contact-a' } },
      routingDeps(),
    );
    expect(workspace.returnPolicy).toEqual({ kind: 'contact_dm', contactId: 'contact-a' });
    const { appendContextSystemNote, summarizeActivity } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'made for contact A' })],
      configure: (runtime) => {
        runtime.resolveContactDmSessionId = (id) => (id === 'contact-a' ? 'discord:dm-a' : null);
        runtime.resolveEntryDisclosureLineage = () => disclosureLineage({ ref: 'mem:a', permittedContactId: 'contact-a' });
      },
    });
    expect(summarizeActivity).toHaveBeenCalledTimes(1);
    const [channelId, note] = appendContextSystemNote.mock.calls[0];
    expect(channelId).toBe('discord:dm-a'); // routed to the contact's DM, not api:main
    expect(note).toContain('made for contact A');
  });

  it('contact-anchored workspace with NO DM resolver → fails closed to a content-free private note', async () => {
    const workspace = resolveFreeTimeWorkspace(
      { kind: 'private_wander', returnTarget: { contactId: 'contact-a' } },
      routingDeps(),
    );
    const { appendContextSystemNote, summarizeActivity, invokeTurn } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'made for contact A' })],
      configure: (runtime) => {
        // Contact-eligible lineage exists, but the DM cannot be resolved.
        runtime.resolveEntryDisclosureLineage = () => disclosureLineage({ ref: 'mem:a', permittedContactId: 'contact-a' });
      },
    });
    // Never a wrong-destination append: content-free note on the internal
    // private/self session.
    expect(summarizeActivity).not.toHaveBeenCalled();
    const [channelId, note] = appendContextSystemNote.mock.calls[0];
    expect(channelId).toBe(invokeTurn.mock.calls[0]?.[0].channelId);
    expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true);
    expect(channelId).not.toBe('api:main');
    expect(note).not.toContain('Here is what I got up to');
    expect(note).not.toContain('contact A');
  });

  it('room workspace → room-eligible content note routed into the same room session', async () => {
    const workspace = resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:mural', workspace: { kind: 'room', channelId: 'discord:room-1' } },
      routingDeps({ roomChannelResolver: () => ({ envelope: ROUTING_INVITE_ENVELOPE, disclosureCeiling: 'confidential' }) }),
    );
    expect(workspace.returnPolicy).toEqual({ kind: 'room', channelId: 'discord:room-1' });
    expect(workspace.retrievalPolicy.disclosureCeiling).toEqual({ kind: 'invite_only_room', channelId: 'discord:room-1' });
    const { appendContextSystemNote } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'mural progress' })],
      configure: (runtime) => {
        runtime.resolveEntryDisclosureLineage = () => roomDisclosureLineage({ ref: 'mem:room', channelId: 'discord:room-1' });
      },
    });
    const [channelId, note, source] = appendContextSystemNote.mock.calls[0];
    expect(channelId).toBe('discord:room-1'); // same room, not api:main
    expect(source).toBe(FREE_TIME_RETURN_NOTE_SOURCE);
    expect(note).toContain('mural progress');
  });

  it('publication workspace → STATE update on the workspace session, no partner disclosure, no content', async () => {
    const workspace = resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:zine', workspace: { kind: 'publication', mode: 'public_clean' } },
      routingDeps(),
    );
    expect(workspace.returnPolicy).toMatchObject({ kind: 'publication_state', mode: 'public_clean' });
    const { appendContextSystemNote, summarizeActivity } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'zine draft detail' })],
    });
    expect(summarizeActivity).not.toHaveBeenCalled(); // state, not transcript content
    const [channelId, note, source] = appendContextSystemNote.mock.calls[0];
    expect(channelId).not.toBe('api:main'); // no unrelated partner disclosure
    expect(channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)).toBe(true); // workspace's own session
    expect(source).toBe(FREE_TIME_RETURN_NOTE_SOURCE);
    expect(note).toContain('Publication workspace update');
    expect(note).not.toContain('zine draft detail');
  });

  it('return note is an attributed SYSTEM note, never partner speech (misattribution guard)', async () => {
    const workspace = resolveFreeTimeWorkspace({ kind: 'private_wander' }, routingDeps());
    const { appendContextSystemNote } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'a quiet sketch' })],
    });
    const [, note, source] = appendContextSystemNote.mock.calls[0];
    // System-note class: the runtime-owned source constant and system framing.
    expect(source).toBe(FREE_TIME_RETURN_NOTE_SOURCE);
    expect(note).toContain('This note comes from the runtime, not from you');
  });

  it('return note is non-initiating: a passive context note, no partner-channel turn', async () => {
    const workspace = resolveFreeTimeWorkspace({ kind: 'private_wander' }, routingDeps());
    const { appendContextSystemNote, invokeTurn } = await runActiveWorkspaceBlock({
      workspace,
      transcript: [entry({ id: 10, role: 'assistant', timestamp: 1, content: 'a small study' })],
    });
    // The note surfaces only as a context note; it never triggers an outbound turn.
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
    // Every free-time turn ran on the INTERNAL channel only — no partner-channel dispatch.
    for (const call of invokeTurn.mock.calls) {
      expect(isInternalSessionId(call[0].channelId)).toBe(true);
    }
  });
});

describe('rest-by-choice vs rest-by-failure visibility (psfn-framework-hrmrq.69)', () => {
  const baseResult = {
    lane: 'quiet_hours' as const,
    channelId: 'internal:free-time:main',
    turnsUsed: 0,
    activity: false,
    endReason: 'rested' as const,
    spentChargeUnits: 0,
    startedAtMs: 1,
    endedAtMs: 2,
  };

  it('a genuine companion_rested note still reads as a choice', () => {
    const note = buildFreeTimeBlockNote({ ...baseResult, restReason: 'companion_rested' });
    expect(note).toContain('resting is a valid way to spend the time');
    expect(note).not.toContain('system failure');
  });

  it('a fail-closed chooser rest names the failure and is not affirmed as a choice', () => {
    for (const restReason of [
      'chooser_disabled',
      'chooser_timeout',
      'chooser_error',
      'chooser_unparseable',
      'chooser_invalid_option',
      'resolve_failed',
    ] as const) {
      const note = buildFreeTimeBlockNote({ ...baseResult, restReason });
      expect(note).not.toContain('valid way to spend the time');
      expect(note).toContain(restReason);
      expect(note).toContain('not a choice');
    }
  });

  it('a rested result with no recorded reason fails closed to the honest framing', () => {
    const note = buildFreeTimeBlockNote({ ...baseResult });
    expect(note).not.toContain('valid way to spend the time');
    expect(note).toContain('reason unrecorded');
  });

  it('a non-rest loaf keeps the existing affirming framing', () => {
    const note = buildFreeTimeBlockNote({ ...baseResult, endReason: 'loafed' });
    expect(note).toContain('resting is a valid way to spend the time');
  });

  it.each([
    ['companion_rested', true],
    ['chooser_error', false],
  ] as const)('runtime carries restReason=%s through note, event, and block record', async (restReason, affirmed) => {
    let nowMs = Date.parse('2026-06-11T06:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const records: FreeTimeBlockRecord[] = [];
      const events: Array<{ endReason: string; restReason?: string }> = [];
      const { scheduler, sessionManager, runtime, eventBus } = buildRuntime({
        turnScript: ['should never run'],
        now: () => nowMs,
      });
      runtime.chooseWorkspace = async () => ({ kind: 'rest', reason: restReason });
      runtime.recordBlock = (record) => records.push(record);
      eventBus.on('scheduler.free_time.block', (payload) => events.push({
        endReason: payload.endReason,
        ...(payload.restReason !== undefined ? { restReason: payload.restReason } : {}),
      }));
      registerFreeTimeTasks(runtime);

      nowMs += 2_000; // let the poll interval elapse so the task is due
      await scheduler.tick();

      expect(events).toEqual([{ endReason: 'rested', restReason }]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ endReason: 'rested', restReason });

      const appendSystemNote = sessionManager.appendSystemNote as ReturnType<typeof vi.fn>;
      expect(appendSystemNote).toHaveBeenCalledTimes(1);
      const [, note] = appendSystemNote.mock.calls[0];
      if (affirmed) {
        expect(note).toContain('resting is a valid way to spend the time');
      } else {
        expect(note).not.toContain('valid way to spend the time');
        expect(note).toContain('chooser_error');
      }
    } finally {
      nowSpy.mockRestore();
    }
  });
});
