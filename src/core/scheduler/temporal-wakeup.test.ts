import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  DEFAULT_TEMPORAL_WAKEUP_CONFIG,
  type TemporalWakeupConfig,
} from '../../system/config/scheduler-config.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import { ProactiveOutboundDispatcher } from '../intention/proactive-outbound.js';
import {
  detectInternalOriginForUserAttribution,
  normalizeSessionEntryAttribution,
} from '../session/entry-attribution.js';
import { SessionManager, type StartupSessionMetadata } from '../session/manager.js';
import type { SessionEntry } from '../session/types.js';
import { evaluateAmbientPresenceEligibility } from './ambient-presence.js';
import { Scheduler } from './scheduler.js';
import {
  buildMorningWakeNote,
  buildTimeOfDayRefreshNote,
  evaluateIdleRefresherEligibility,
  evaluateMorningWakeEligibility,
  findLatestTemporalWakeupNoteAt,
  parseWakeLocalTime,
  registerTemporalWakeupTasks,
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
  TEMPORAL_WAKEUP_MORNING_TASK_ID,
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
  TEMPORAL_WAKEUP_REFRESHER_TASK_ID,
  type TemporalWakeupSessionManagerPort,
} from './temporal-wakeup.js';

const DAY1_EVENING = Date.parse('2026-06-10T21:58:00.000Z');
const DAY1_NIGHT = Date.parse('2026-06-10T22:00:00.000Z');
const DAY2_MORNING = Date.parse('2026-06-11T08:05:00.000Z');

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
  } as SubstrateConfig;
}

function makeWakeConfig(overrides?: {
  morning?: Partial<TemporalWakeupConfig['morningWake']>;
  refresher?: Partial<TemporalWakeupConfig['idleRefresher']>;
  enabled?: boolean;
  activeChannelLookbackHours?: number;
}): TemporalWakeupConfig {
  return {
    enabled: overrides?.enabled ?? true,
    activeChannelLookbackHours:
      overrides?.activeChannelLookbackHours ?? DEFAULT_TEMPORAL_WAKEUP_CONFIG.activeChannelLookbackHours,
    morningWake: {
      ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake,
      timezone: 'utc',
      ...overrides?.morning,
    },
    idleRefresher: {
      ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher,
      ...overrides?.refresher,
    },
    wakeSummary: { ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.wakeSummary },
  };
}

function entry(
  overrides: Partial<SessionEntry> & Pick<SessionEntry, 'role' | 'timestamp'>,
): SessionEntry {
  return {
    id: overrides.id ?? 1,
    channelId: overrides.channelId ?? 'api:main',
    content: overrides.content ?? 'hello',
    ...overrides,
  };
}

function wakeNoteEntry(timestamp: number, source = TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE): SessionEntry {
  return entry({
    role: 'system',
    timestamp,
    authorId: 'system',
    authorName: 'System',
    content: '[Temporal wake] test',
    metadata: JSON.stringify({ sessionLane: { schemaVersion: 1, kind: 'system_note', source } }),
  });
}

const session = { sessionId: 'api:main', channelType: 'api', timestamp: DAY1_NIGHT };

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('parseWakeLocalTime', () => {
  it('parses HH:mm and rejects malformed values', () => {
    expect(parseWakeLocalTime('08:00')).toEqual({ hour: 8, minute: 0 });
    expect(parseWakeLocalTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(() => parseWakeLocalTime('24:00')).toThrow('expected HH:mm');
    expect(() => parseWakeLocalTime('8am')).toThrow('expected HH:mm');
  });
});

describe('evaluateMorningWakeEligibility', () => {
  it('is eligible after an overnight gap and marks warm sessions for a full turn', () => {
    const decision = evaluateMorningWakeEligibility({
      session,
      recentEntries: [
        entry({ role: 'user', timestamp: DAY1_EVENING }),
        entry({ role: 'assistant', timestamp: DAY1_NIGHT }),
      ],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    });
    expect(decision).toMatchObject({
      allowed: true,
      sessionId: 'api:main',
      lastPartnerActivityAtMs: DAY1_EVENING,
      lastActivityAtMs: DAY1_NIGHT,
      invokeFullTurn: true,
      timeTexture: { kind: 'overnight' },
    });
  });

  it('keeps stale sessions on the cheap note-only path', () => {
    const staleAt = DAY2_MORNING - 5 * 24 * 60 * 60_000;
    const decision = evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: staleAt })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    });
    expect(decision).toMatchObject({
      allowed: true,
      invokeFullTurn: false,
      timeTexture: { kind: 'multiple_days' },
    });
  });

  it('fires for a partner who spoke overnight before the wake slot', () => {
    // Partner at 00:42 local, wake at 08:05 the SAME calendar day: the old
    // calendar-date guard suppressed this every night; the recency guard allows it.
    const partnerAt = Date.parse('2026-06-11T00:42:00.000Z');
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: partnerAt })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: true, lastPartnerActivityAtMs: partnerAt });
  });

  it('skips when the partner is conversing right now', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY2_MORNING - 30 * 60_000 })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'partner_recently_active' });
  });

  it('disables the recency guard when minPartnerIdleMs is 0', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY2_MORNING - 60_000 })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 0,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: true });
  });

  it('anti-loops when a MORNING wake note already landed today', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
      lastWakeupNoteAtMs: DAY2_MORNING - 2 * 60 * 60_000,
    })).toMatchObject({ allowed: false, reason: 'anti_loop_note_today' });
  });

  it('allows a morning note after a post-midnight refresher but suppresses a second morning note', () => {
    const refresherAt = Date.parse('2026-06-11T02:34:00.000Z');
    const persisted = [wakeNoteEntry(refresherAt, TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE)];
    const morningSources = new Set([TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE]);
    const latestMorningNoteAt = findLatestTemporalWakeupNoteAt(persisted, morningSources);
    expect(latestMorningNoteAt).toBeUndefined();
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
      ...(latestMorningNoteAt !== undefined ? { lastWakeupNoteAtMs: latestMorningNoteAt } : {}),
    })).toMatchObject({ allowed: true, reason: 'eligible' });

    const morningAt = DAY2_MORNING;
    persisted.push(wakeNoteEntry(morningAt, TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE));
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING + 60_000,
      lastWakeupNoteAtMs: findLatestTemporalWakeupNoteAt(persisted, morningSources),
    })).toMatchObject({ allowed: false, reason: 'anti_loop_note_today' });
  });

  it('uses the latest group-channel message by any participant for morning recency', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [
        entry({ role: 'user', authorId: 'participant-a', timestamp: DAY1_EVENING }),
        entry({ role: 'assistant', timestamp: DAY2_MORNING - 5 * 60_000 }),
      ],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'partner_recently_active' });
  });

  it('requires partner activity and blocks internal/public sessions', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'assistant', timestamp: DAY1_NIGHT })],
      fullTurnMaxIdleMs: 1,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'no_partner_activity' });

    expect(evaluateMorningWakeEligibility({
      session: { sessionId: 'internal:reflection:daily', channelType: 'api', timestamp: DAY1_NIGHT },
      recentEntries: [entry({ role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 1,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'internal_session' });

    expect(evaluateMorningWakeEligibility({
      session: { sessionId: 'twitter:timeline', channelType: 'api', timestamp: DAY1_NIGHT },
      recentEntries: [entry({ channelId: 'twitter:timeline', role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 1,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'privacy_boundary' });
  });
});

describe('evaluateIdleRefresherEligibility', () => {
  const noon = Date.parse('2026-06-11T09:00:00.000Z');
  const lateAfternoon = Date.parse('2026-06-11T15:30:00.000Z');

  it('emits a lighter time-of-day refresh after a long same-day gap', () => {
    const decision = evaluateIdleRefresherEligibility({
      session,
      recentEntries: [
        entry({ role: 'user', timestamp: noon - 60_000 }),
        entry({ role: 'assistant', timestamp: noon }),
      ],
      minIdleMs: 240 * 60_000,
      minNoteIntervalMs: 240 * 60_000,
      nowMs: lateAfternoon,
    });
    expect(decision).toMatchObject({
      allowed: true,
      kind: 'time_of_day_refresh',
      lastActivityAtMs: noon,
      timeTexture: { kind: 'long_workday' },
    });
  });

  it('escalates overnight textures to the full new-day framing', () => {
    expect(evaluateIdleRefresherEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY1_NIGHT })],
      minIdleMs: 240 * 60_000,
      minNoteIntervalMs: 240 * 60_000,
      nowMs: DAY2_MORNING + 2 * 60 * 60_000,
    })).toMatchObject({
      allowed: true,
      kind: 'new_day',
      timeTexture: { kind: 'overnight' },
    });
  });

  it('blocks below the idle threshold and anti-loops on recent wake notes', () => {
    expect(evaluateIdleRefresherEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: lateAfternoon - 30 * 60_000 })],
      minIdleMs: 240 * 60_000,
      minNoteIntervalMs: 240 * 60_000,
      nowMs: lateAfternoon,
    })).toMatchObject({ allowed: false, reason: 'below_idle_threshold' });

    expect(evaluateIdleRefresherEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: noon })],
      minIdleMs: 240 * 60_000,
      minNoteIntervalMs: 240 * 60_000,
      nowMs: lateAfternoon,
      lastWakeupNoteAtMs: lateAfternoon - 60 * 60_000,
    })).toMatchObject({ allowed: false, reason: 'anti_loop_recent_note' });
  });

  it('ignores system-role wake notes when computing the idle gap', () => {
    const decision = evaluateIdleRefresherEligibility({
      session,
      recentEntries: [
        entry({ role: 'user', timestamp: noon }),
        wakeNoteEntry(lateAfternoon - 30 * 60_000),
      ],
      minIdleMs: 240 * 60_000,
      minNoteIntervalMs: 0,
      nowMs: lateAfternoon,
    });
    expect(decision).toMatchObject({
      allowed: true,
      lastActivityAtMs: noon,
      idleGapMs: lateAfternoon - noon,
    });
  });

  it('measures a group-channel gap from the latest message by any participant', () => {
    const firstParticipantAt = Date.parse('2026-06-11T09:00:00.000Z');
    const otherParticipantAt = Date.parse('2026-06-11T11:30:00.000Z');
    const observedAt = Date.parse('2026-06-11T18:00:00.000Z');
    const decision = evaluateIdleRefresherEligibility({
      session,
      recentEntries: [
        entry({ role: 'user', authorId: 'participant-a', timestamp: firstParticipantAt }),
        entry({ role: 'user', authorId: 'participant-b', timestamp: otherParticipantAt }),
      ],
      minIdleMs: 4 * 60 * 60_000,
      minNoteIntervalMs: 0,
      nowMs: observedAt,
    });

    expect(decision).toMatchObject({
      allowed: true,
      lastActivityAtMs: otherParticipantAt,
      idleGapMs: observedAt - otherParticipantAt,
    });
  });
});

describe('findLatestTemporalWakeupNoteAt', () => {
  it('finds wake-lane notes by sessionLane source and ignores other entries', () => {
    expect(findLatestTemporalWakeupNoteAt([
      entry({ role: 'user', timestamp: 10 }),
      wakeNoteEntry(20),
      wakeNoteEntry(30, TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE),
      entry({
        role: 'system',
        timestamp: 40,
        metadata: JSON.stringify({ sessionLane: { schemaVersion: 1, kind: 'internal', source: 'ambient_presence' } }),
      }),
    ])).toBe(30);
    expect(findLatestTemporalWakeupNoteAt([entry({ role: 'user', timestamp: 10 })])).toBeUndefined();
  });
});

describe('note builders', () => {
  it('builds a new-day note with date, elapsed channel gap, and catch-up summary — no scripted greeting', () => {
    const note = buildMorningWakeNote({
      nowMs: DAY2_MORNING,
      lastActivityAtMs: DAY1_EVENING,
      catchUpSummary: 'You and Ada wrapped up the garden plans before bed.',
      timeZone: 'UTC',
    });
    expect(note).toContain('[Temporal wake]');
    expect(note).toContain('June 11, 2026');
    expect(note).toContain('08:05');
    expect(note).toContain('morning');
    expect(note).toContain('10 hours 7 minutes ago');
    expect(note).toContain('You and Ada wrapped up the garden plans before bed.');
    expect(note).not.toContain('overnight gap');
    expect(note).not.toContain('Reconnection warmth');
    expect(note).not.toContain('perform affection');
    // Context, not a script: the runtime never puts greeting words in play.
    expect(note.toLowerCase()).not.toContain('good morning');
    expect(note).toContain('not a message from your partner');
  });

  it('builds a lighter time-of-day refresh note', () => {
    const lastAt = Date.parse('2026-06-11T09:00:00.000Z');
    const nowMs = Date.parse('2026-06-11T15:30:00.000Z');
    const note = buildTimeOfDayRefreshNote({
      nowMs,
      lastActivityAtMs: lastAt,
      timeZone: 'UTC',
    });
    expect(note).toContain('[Time-of-day refresher]');
    expect(note).toContain('15:30');
    expect(note).toContain('afternoon');
    expect(note).toContain('6 hours 30 minutes');
    expect(note).not.toContain('long workday gap');
    expect(note).not.toContain('Reconnection warmth');
    expect(note).not.toContain('Catch-up');
  });
});

describe('morning wake lane (simulated clock, real session manager)', () => {
  let dir: string;
  let store: SessionStore;
  let mgr: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-wakeup-'));
    store = new SessionStore(dir);
    mgr = new SessionManager(store, makeConfig(), new EventBus());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('injects the new-day frame overnight so it precedes the first partner message of the day in built context', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_EVENING));
    mgr.recordUserMessage('api:main', 'goodnight — heading to bed', 'user-1', 'Ada');
    vi.setSystemTime(new Date(DAY1_NIGHT));
    mgr.recordAssistantMessage('api:main', 'sleep well, talk tomorrow');

    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: mgr,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      summarizeCatchUp: async () => 'You and Ada wrapped up the garden plans before bed.',
    });

    // Still the previous night: the daily 08:00 slot has not arrived.
    await scheduler.tick();
    expect(findLatestTemporalWakeupNoteAt(mgr.getRecentSessionEntries('api:main', 16))).toBeUndefined();

    // New day, past the wake slot.
    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    const entries = mgr.getRecentSessionEntries('api:main', 16);
    const noteAt = findLatestTemporalWakeupNoteAt(entries);
    expect(noteAt).toBe(DAY2_MORNING);
    const noteEntry = entries.find(e => e.timestamp === noteAt && e.role === 'system');
    expect(noteEntry).toBeDefined();
    expect(noteEntry?.authorId).toBe('system');
    expect(noteEntry?.content).toContain('June 11, 2026');
    expect(noteEntry?.content).toContain('You and Ada wrapped up the garden plans before bed.');
    expect(JSON.parse(noteEntry?.metadata ?? '{}')).toMatchObject({
      sessionLane: { kind: 'system_note', source: TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE },
    });

    // The partner speaks AFTER the wake — the note must already be in the
    // assembled context, before the partner's first message of the day.
    vi.setSystemTime(new Date(DAY2_MORNING + 5 * 60_000));
    mgr.recordUserMessage('api:main', 'good morning!', 'user-1', 'Ada');

    const ctx = await mgr.buildContext('api:main', 'System prompt', '');
    const wakeIndex = ctx.messages.findIndex(
      m => m.role === 'system' && m.content.includes('[Temporal wake]'),
    );
    const partnerIndex = ctx.messages.findIndex(
      m => m.role === 'user' && m.content.includes('good morning!'),
    );
    expect(wakeIndex).toBeGreaterThanOrEqual(0);
    expect(partnerIndex).toBeGreaterThan(wakeIndex);

    // Same day, later tick: the wall-clock cadence does not re-fire.
    vi.setSystemTime(new Date(DAY2_MORNING + 6 * 60 * 60_000));
    await scheduler.tick();
    const notes = mgr.getRecentSessionEntries('api:main', 32)
      .filter(e => findLatestTemporalWakeupNoteAt([e]) !== undefined);
    expect(notes).toHaveLength(1);
  });

  it('fires one morning note after a post-midnight refresher without repeating its catch-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_EVENING));
    mgr.recordUserMessage('api:main', 'wrapping up for the night', 'user-1', 'Ada');

    const refresherAt = Date.parse('2026-06-11T02:34:00.000Z');
    vi.setSystemTime(new Date(refresherAt));
    mgr.appendContextSystemNote(
      'api:main',
      '[Temporal wake]\nCatch-up on where things left off: Overnight catch-up already delivered.',
      TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
    );

    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    const summarizeCatchUp = vi.fn(async () => 'Repeated overnight catch-up.');
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: mgr,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      summarizeCatchUp,
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();
    vi.setSystemTime(new Date(DAY2_MORNING + 60_000));
    await runMorningHandler(scheduler);

    const wakeNotes = mgr.getRecentSessionEntries('api:main', 16)
      .filter(entry => findLatestTemporalWakeupNoteAt([entry]) !== undefined);
    expect(wakeNotes).toHaveLength(2);
    expect(wakeNotes.map(note => JSON.parse(note.metadata ?? '{}').sessionLane?.source)).toEqual([
      TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
      TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
    ]);
    expect(wakeNotes[1]?.content).not.toContain('Repeated overnight catch-up.');
    expect(summarizeCatchUp).not.toHaveBeenCalled();
  });

  it('does not reset elapsed-time or ambient idle accounting (wake notes are not partner activity)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_EVENING));
    mgr.recordUserMessage('api:main', 'goodnight', 'user-1', 'Ada');
    vi.setSystemTime(new Date(DAY1_NIGHT));
    mgr.recordAssistantMessage('api:main', 'sleep well');

    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: mgr,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });
    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();
    expect(findLatestTemporalWakeupNoteAt(mgr.getRecentSessionEntries('api:main', 16))).toBe(DAY2_MORNING);

    // Ambient-presence idle accounting still keys off the last user/assistant
    // entries, not the wake note injected at DAY2_MORNING.
    const probeAt = DAY2_MORNING + 60_000;
    const ambient = evaluateAmbientPresenceEligibility({
      session: mgr.resolveStartupSessionMetadata('reuse_latest_session'),
      recentEntries: mgr.getRecentMessages('api:main', 16),
      nowMs: probeAt,
      minIdleMs: 60_000,
      minNoteIntervalMs: 0,
    });
    expect(ambient).toMatchObject({
      allowed: true,
      lastActivityAtMs: DAY1_NIGHT,
      lastUserActivityAtMs: DAY1_EVENING,
      idleGapMs: probeAt - DAY1_NIGHT,
    });

    // The wake-lane's own eligibility measures the partner gap from the last
    // user entry too — the injected note does not move it.
    const wakeProbe = evaluateMorningWakeEligibility({
      session: mgr.resolveStartupSessionMetadata('reuse_latest_session'),
      recentEntries: mgr.getRecentMessages('api:main', 16),
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: probeAt,
    });
    expect(wakeProbe).toMatchObject({
      allowed: true,
      lastPartnerActivityAtMs: DAY1_EVENING,
      lastActivityAtMs: DAY1_NIGHT,
    });

    // Re-firing is prevented by the persisted-note anti-loop scan, exactly as
    // the runtime resolves it: a MORNING-only scan over the store (a refresher
    // note would be ignored here).
    const persistedNoteAt = findLatestTemporalWakeupNoteAt(
      mgr.getRecentSessionEntries('api:main', 32),
      new Set([TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE]),
    );
    expect(persistedNoteAt).toBe(DAY2_MORNING);
    expect(evaluateMorningWakeEligibility({
      session: mgr.resolveStartupSessionMetadata('reuse_latest_session'),
      recentEntries: mgr.getRecentMessages('api:main', 16),
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      minPartnerIdleMs: 60 * 60_000,
      nowMs: probeAt,
      lastWakeupNoteAtMs: persistedNoteAt,
    })).toMatchObject({ allowed: false, reason: 'anti_loop_note_today' });
  });

  it('keeps wake notes system-authored: attribution can never render them as partner speech', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_EVENING));
    mgr.recordUserMessage('api:main', 'goodnight', 'user-1', 'Ada');

    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: mgr,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });
    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    const entries = mgr.getRecentSessionEntries('api:main', 16);
    const noteEntry = entries.find(e => findLatestTemporalWakeupNoteAt([e]) !== undefined);
    expect(noteEntry).toBeDefined();

    // Read-time attribution: the ontology class stays 'system'.
    expect(normalizeSessionEntryAttribution(noteEntry as SessionEntry)).toMatchObject({ role: 'system' });

    // Rendered context: attributed system speech, never a bare partner line.
    const ctx = await mgr.buildContext('api:main', 'System prompt', '');
    const rendered = ctx.messages.find(m => m.content.includes('[Temporal wake]'));
    expect(rendered?.role).toBe('system');
    expect(rendered?.content).toContain('[SYSTEM:');

    // Write-time guard: replaying wake-note text as user speech with an
    // internal authorship signature is re-tagged to system (law 19).
    expect(detectInternalOriginForUserAttribution({
      channelId: 'api:main',
      content: noteEntry?.content ?? '',
      authorId: 'system:temporal-wakeup',
      authorName: 'System',
    })).toBe('system_author_prefix');
    expect(detectInternalOriginForUserAttribution({
      channelId: 'api:main',
      content: noteEntry?.content ?? '',
      authorId: 'scheduler',
      authorName: 'Temporal Wake-Up',
    })).toBe('scheduler_author');

    mgr.recordUserMessage('api:main', noteEntry?.content ?? '[Temporal wake] forged', 'scheduler', 'Temporal Wake-Up');
    const latest = mgr.getRecentSessionEntries('api:main', 4).at(-1);
    expect(latest?.role).toBe('system');
  });
});

describe('morning wake outward phase', () => {
  function makePort(input?: { partnerAt?: number; channelType?: string }): {
    port: TemporalWakeupSessionManagerPort;
    appended: Array<{ note: string; source?: string; atMs: number }>;
  } {
    const partnerAt = input?.partnerAt ?? DAY1_EVENING;
    const appended: Array<{ note: string; source?: string; atMs: number }> = [];
    const persisted: SessionEntry[] = [];
    const port: TemporalWakeupSessionManagerPort = {
      resolveStartupSessionMetadata: () => ({
        sessionId: 'api:main',
        channelType: input?.channelType ?? 'discord',
        timestamp: partnerAt,
      }),
      getRecentMessages: () => [entry({ role: 'user', timestamp: partnerAt })],
      getRecentSessionEntries: () => persisted,
      appendContextSystemNote: (channelId, note, source) => {
        appended.push({ note, ...(source !== undefined ? { source } : {}), atMs: Date.now() });
        persisted.push(entry({
          role: 'system',
          timestamp: Date.now(),
          channelId,
          content: note,
          metadata: JSON.stringify({ sessionLane: { schemaVersion: 1, kind: 'system_note', source } }),
        }));
      },
    };
    return { port, appended };
  }

  function makeScheduler(): Scheduler {
    return new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
  }

  it('routes outward content through the real proactive-outbound dispatcher; policy denial does not block the frame update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const { port, appended } = makePort();
    const scheduler = makeScheduler();
    const sent: string[] = [];
    const dispatcher = new ProactiveOutboundDispatcher({
      sender: { send: async (_channelId, content) => { sent.push(content); } },
      rateLimiter: new ExternalCommunicationRateLimiter(),
      isApprovedPrimaryChannel: () => false, // policy denies every channel
    });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      invokeWakeTurn: async () => 'hey — it is a bright one out there',
      dispatchOutbound: (input) => dispatcher.dispatch({
        actionId: 'temporal-wakeup-test',
        channelId: input.channelId,
        channelType: input.channelType,
        content: input.content,
      }),
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    expect(appended).toHaveLength(1); // internal frame update landed
    expect(appended[0].source).toBe(TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE);
    expect(sent).toHaveLength(0); // outward delivery blocked by policy
    expect(scheduler.getTask(TEMPORAL_WAKEUP_MORNING_TASK_ID)?.lastOutcome).toBe('succeeded');
  });

  it('delivers outward content when policy and rate limits allow', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const { port, appended } = makePort();
    const scheduler = makeScheduler();
    const sent: string[] = [];
    const dispatcher = new ProactiveOutboundDispatcher({
      sender: { send: async (_channelId, content) => { sent.push(content); } },
      rateLimiter: new ExternalCommunicationRateLimiter(),
      isApprovedPrimaryChannel: () => true,
    });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      invokeWakeTurn: async ({ note }) => {
        expect(note).toContain('[Temporal wake]');
        return 'thinking of you this morning';
      },
      dispatchOutbound: (input) => dispatcher.dispatch({
        actionId: 'temporal-wakeup-test',
        channelId: input.channelId,
        channelType: input.channelType,
        content: input.content,
      }),
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    expect(appended).toHaveLength(1);
    expect(sent).toEqual(['thinking of you this morning']);
  });

  it('respects quiet hours for outward delivery while the internal note still lands', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const { port, appended } = makePort();
    const scheduler = makeScheduler();
    const dispatchOutbound = vi.fn();
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      quietHours: {
        enabled: true,
        startLocalTime: '00:00',
        endLocalTime: '09:00',
        timeZone: 'UTC',
      },
      invokeWakeTurn: async () => 'psst',
      dispatchOutbound,
    });

    vi.setSystemTime(new Date(DAY2_MORNING)); // 08:05 UTC — inside quiet hours
    await scheduler.tick();

    expect(appended).toHaveLength(1);
    expect(dispatchOutbound).not.toHaveBeenCalled();
  });

  it('delivers outward at 08:05 UTC when an overnight window is evaluated in the global zone (2tli control)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const { port } = makePort();
    const scheduler = makeScheduler();
    const dispatchOutbound = vi.fn(async () => ({ outcome: 'sent' as const }));
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      // Overnight window; 08:05 UTC is OUTSIDE it in the global (UTC) zone.
      quietHours: { enabled: true, startLocalTime: '22:00', endLocalTime: '02:00', timeZone: 'UTC' },
      invokeWakeTurn: async () => 'psst',
      dispatchOutbound,
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    expect(dispatchOutbound).toHaveBeenCalledTimes(1);
  });

  it('gates outward delivery by the recipient timezone, not the global window (2tli)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const { port, appended } = makePort();
    const scheduler = makeScheduler();
    const dispatchOutbound = vi.fn(async () => ({ outcome: 'sent' as const }));
    const resolveContactTimeZone = vi.fn(async () => 'America/Los_Angeles');
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      // Same overnight window that the global-zone control above delivers under.
      // In America/Los_Angeles, 08:05 UTC is 01:05 PDT — INSIDE 22:00–02:00 — so
      // the recipient-local evaluation defers outward delivery.
      quietHours: { enabled: true, startLocalTime: '22:00', endLocalTime: '02:00', timeZone: 'UTC' },
      invokeWakeTurn: async () => 'psst',
      dispatchOutbound,
      resolveContactTimeZone,
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    // Internal frame still lands; only outward delivery is gated by the
    // recipient's local quiet hours.
    expect(appended).toHaveLength(1);
    expect(resolveContactTimeZone).toHaveBeenCalledWith('api:main');
    expect(dispatchOutbound).not.toHaveBeenCalled();
  });

  it('keeps the frame update when the wake turn itself throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const { port, appended } = makePort();
    const scheduler = makeScheduler();
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      invokeWakeTurn: async () => { throw new Error('provider offline'); },
      dispatchOutbound: vi.fn(),
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    expect(appended).toHaveLength(1);
    expect(scheduler.getTask(TEMPORAL_WAKEUP_MORNING_TASK_ID)?.lastOutcome).toBe('succeeded');
  });

  it('skips the full turn entirely for cold sessions (note-only spend)', async () => {
    vi.useFakeTimers();
    const staleAt = DAY2_MORNING - 6 * 24 * 60 * 60_000;
    vi.setSystemTime(new Date(DAY2_MORNING - 24 * 60 * 60_000));
    const { port, appended } = makePort({ partnerAt: staleAt });
    const scheduler = makeScheduler();
    const invokeWakeTurn = vi.fn();
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false }, morning: { fullTurnMaxIdleHours: 72 } }),
      invokeWakeTurn,
      dispatchOutbound: vi.fn(),
    });

    vi.setSystemTime(new Date(DAY2_MORNING));
    await scheduler.tick();

    expect(appended).toHaveLength(1);
    expect(invokeWakeTurn).not.toHaveBeenCalled();
  });
});

describe('temporal wake handler entry-read preflights', () => {
  it('morning rejects recent partner metadata without reading session entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    const getRecentMessages = vi.fn(() => []);
    const getRecentSessionEntries = vi.fn(() => []);
    const appendContextSystemNote = vi.fn();
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });

    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => ({
          sessionId: 'api:main',
          channelType: 'api',
          timestamp: DAY2_MORNING - 30 * 60_000,
          lastRole: 'user',
        }),
        getRecentMessages,
        getRecentSessionEntries,
        appendContextSystemNote,
      },
      config: makeWakeConfig({
        morning: { minPartnerIdleMinutes: 60 },
        refresher: { enabled: false },
      }),
    });

    await runMorningHandler(scheduler);

    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(getRecentSessionEntries).not.toHaveBeenCalled();
    expect(appendContextSystemNote).not.toHaveBeenCalled();
  });

  it('morning still reads history when the latest index row is a recent system note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    const getRecentMessages = vi.fn(() => [entry({ role: 'user', timestamp: DAY1_EVENING })]);
    const getRecentSessionEntries = vi.fn(() => []);
    const appendContextSystemNote = vi.fn();
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });

    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => ({
          sessionId: 'api:main',
          channelType: 'api',
          timestamp: DAY2_MORNING - 30 * 60_000,
          lastRole: 'system',
        }),
        getRecentMessages,
        getRecentSessionEntries,
        appendContextSystemNote,
      },
      config: makeWakeConfig({
        morning: { minPartnerIdleMinutes: 60 },
        refresher: { enabled: false },
      }),
    });

    await runMorningHandler(scheduler);

    expect(getRecentMessages).toHaveBeenCalledTimes(1);
    expect(getRecentSessionEntries).toHaveBeenCalledTimes(1);
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
  });

  it('idle refresher rejects recent conversational metadata without reading session entries', async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-06-11T15:30:00.000Z');
    vi.setSystemTime(new Date(nowMs));
    const getRecentMessages = vi.fn(() => []);
    const getRecentSessionEntries = vi.fn(() => []);
    const appendContextSystemNote = vi.fn();
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });

    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => ({
          sessionId: 'api:main',
          channelType: 'api',
          timestamp: nowMs - 30 * 60_000,
          lastRole: 'assistant',
        }),
        getRecentMessages,
        getRecentSessionEntries,
        appendContextSystemNote,
      },
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, minIdleMinutes: 120 },
      }),
    });

    const handler = scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)?.handler;
    if (!handler) throw new Error('refresher task was not registered');
    await handler();

    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(getRecentSessionEntries).not.toHaveBeenCalled();
    expect(appendContextSystemNote).not.toHaveBeenCalled();
  });

  it('idle refresher still reads history when the latest index row is a recent system note', async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-06-11T15:30:00.000Z');
    const lastConversationAt = Date.parse('2026-06-11T09:00:00.000Z');
    vi.setSystemTime(new Date(nowMs));
    const getRecentMessages = vi.fn(() => [entry({ role: 'user', timestamp: lastConversationAt })]);
    const getRecentSessionEntries = vi.fn(() => []);
    const appendContextSystemNote = vi.fn();
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });

    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => ({
          sessionId: 'api:main',
          channelType: 'api',
          timestamp: nowMs - 30 * 60_000,
          lastRole: 'system',
        }),
        getRecentMessages,
        getRecentSessionEntries,
        appendContextSystemNote,
      },
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, minIdleMinutes: 120 },
      }),
    });

    const handler = scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)?.handler;
    if (!handler) throw new Error('refresher task was not registered');
    await handler();

    expect(getRecentMessages).toHaveBeenCalledTimes(1);
    expect(getRecentSessionEntries).toHaveBeenCalledTimes(1);
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
  });

  it('morning uses its in-memory note proof before rereading an unchanged session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    const persisted: SessionEntry[] = [];
    const getRecentMessages = vi.fn(() => [entry({ role: 'user', timestamp: DAY1_EVENING })]);
    const getRecentSessionEntries = vi.fn(() => persisted);
    const appendContextSystemNote = vi.fn((channelId: string, note: string, source?: string) => {
      persisted.push(wakeNoteEntry(Date.now(), source));
      persisted[persisted.length - 1]!.channelId = channelId;
      persisted[persisted.length - 1]!.content = note;
    });
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });

    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => {
          const latest = persisted.at(-1);
          return {
            sessionId: 'api:main',
            channelType: 'api',
            timestamp: latest?.timestamp ?? DAY1_EVENING,
            lastRole: latest?.role ?? 'user',
          };
        },
        getRecentMessages,
        getRecentSessionEntries,
        appendContextSystemNote,
      },
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });

    await runMorningHandler(scheduler);
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
    getRecentMessages.mockClear();
    getRecentSessionEntries.mockClear();

    vi.setSystemTime(new Date(DAY2_MORNING + 60_000));
    await runMorningHandler(scheduler);

    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(getRecentSessionEntries).not.toHaveBeenCalled();
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
  });

  it('idle refresher uses its in-memory note proof before rereading an unchanged session', async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-06-11T15:30:00.000Z');
    const lastConversationAt = Date.parse('2026-06-11T09:00:00.000Z');
    vi.setSystemTime(new Date(nowMs));
    const persisted: SessionEntry[] = [];
    const getRecentMessages = vi.fn(() => [entry({ role: 'user', timestamp: lastConversationAt })]);
    const getRecentSessionEntries = vi.fn(() => persisted);
    const appendContextSystemNote = vi.fn((channelId: string, note: string, source?: string) => {
      persisted.push(wakeNoteEntry(Date.now(), source));
      persisted[persisted.length - 1]!.channelId = channelId;
      persisted[persisted.length - 1]!.content = note;
    });
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });

    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => {
          const latest = persisted.at(-1);
          return {
            sessionId: 'api:main',
            channelType: 'api',
            timestamp: latest?.timestamp ?? lastConversationAt,
            lastRole: latest?.role ?? 'user',
          };
        },
        getRecentMessages,
        getRecentSessionEntries,
        appendContextSystemNote,
      },
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, minIdleMinutes: 120, minNoteIntervalMinutes: 120 },
      }),
    });

    const handler = scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)?.handler;
    if (!handler) throw new Error('refresher task was not registered');
    await handler();
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
    getRecentMessages.mockClear();
    getRecentSessionEntries.mockClear();

    vi.setSystemTime(new Date(nowMs + 60_000));
    await handler();

    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(getRecentSessionEntries).not.toHaveBeenCalled();
    expect(appendContextSystemNote).toHaveBeenCalledTimes(1);
  });
});

describe('idle refresher lane', () => {
  it('reconciles an eligible restart gap before a quick partner return can reset it', async () => {
    vi.useFakeTimers();
    const lastExchangeAt = Date.parse('2026-06-11T09:00:00.000Z');
    const restartedAt = Date.parse('2026-06-11T11:05:00.000Z');
    const partnerReturnAt = Date.parse('2026-06-11T11:10:00.000Z');
    const firstPeriodicCheckAt = Date.parse('2026-06-11T11:20:00.000Z');
    let conversational = [entry({
      role: 'user',
      timestamp: lastExchangeAt,
      content: 'leaving for a while',
    })];
    const persisted: SessionEntry[] = [];
    const eventOrder: string[] = [];
    const port: TemporalWakeupSessionManagerPort = {
      resolveStartupSessionMetadata: () => {
        const latest = conversational.at(-1)!;
        return {
          sessionId: 'api:main',
          channelType: 'api',
          timestamp: latest.timestamp,
          lastRole: latest.role,
        };
      },
      getRecentMessages: () => conversational,
      getRecentSessionEntries: () => persisted,
      appendContextSystemNote: (channelId, note, source) => {
        eventOrder.push('refresher');
        persisted.push(entry({
          role: 'system',
          timestamp: Date.now(),
          channelId,
          content: note,
          metadata: JSON.stringify({ sessionLane: { schemaVersion: 1, kind: 'system_note', source } }),
        }));
      },
    };
    vi.setSystemTime(new Date(restartedAt));
    const scheduler = new Scheduler(
      new EventBus(),
      { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 },
    );
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: {
          enabled: true,
          checkIntervalMs: 15 * 60_000,
          minIdleMinutes: 120,
          minNoteIntervalMinutes: 120,
        },
      }),
    });

    // Startup reconciliation is due immediately; the ordinary periodic
    // cadence remains fifteen minutes away.
    await scheduler.tick();
    vi.setSystemTime(new Date(partnerReturnAt));
    conversational = [...conversational, entry({
      role: 'user',
      timestamp: partnerReturnAt,
      content: 'back already',
    })];
    eventOrder.push('partner');
    vi.setSystemTime(new Date(firstPeriodicCheckAt));
    await scheduler.tick();

    expect(eventOrder).toEqual(['refresher', 'partner']);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.timestamp).toBe(restartedAt);
    expect(JSON.parse(persisted[0]?.metadata ?? '{}')).toMatchObject({
      sessionLane: { source: TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE },
    });
  });

  it('startup reconciliation does not duplicate a persisted pre-restart refresher note', async () => {
    vi.useFakeTimers();
    const lastExchangeAt = Date.parse('2026-06-11T09:00:00.000Z');
    const existingNoteAt = Date.parse('2026-06-11T11:00:00.000Z');
    const restartedAt = Date.parse('2026-06-11T11:05:00.000Z');
    const persisted = [
      wakeNoteEntry(existingNoteAt, TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE),
    ];
    const appendContextSystemNote = vi.fn();
    vi.setSystemTime(new Date(restartedAt));
    const scheduler = new Scheduler(
      new EventBus(),
      { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 },
    );
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => ({
          sessionId: 'api:main',
          channelType: 'api',
          timestamp: existingNoteAt,
          lastRole: 'system',
        }),
        getRecentMessages: () => [entry({ role: 'user', timestamp: lastExchangeAt })],
        getRecentSessionEntries: () => persisted,
        appendContextSystemNote,
      },
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: {
          enabled: true,
          checkIntervalMs: 15 * 60_000,
          minIdleMinutes: 120,
          minNoteIntervalMinutes: 120,
        },
      }),
    });

    await scheduler.tick();

    expect(scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)?.lastOutcome).toBe('succeeded');
    expect(appendContextSystemNote).not.toHaveBeenCalled();
  });

  it('injects the lighter refresh after a same-day gap and anti-loops afterwards', async () => {
    vi.useFakeTimers();
    const morningAt = Date.parse('2026-06-11T09:00:00.000Z');
    const afternoonAt = Date.parse('2026-06-11T15:30:00.000Z');
    vi.setSystemTime(new Date(morningAt));

    const appended: Array<{ note: string; source?: string }> = [];
    const persisted: SessionEntry[] = [];
    const port: TemporalWakeupSessionManagerPort = {
      resolveStartupSessionMetadata: () => ({ sessionId: 'api:main', channelType: 'api', timestamp: morningAt }),
      getRecentMessages: () => [entry({ role: 'user', timestamp: morningAt })],
      getRecentSessionEntries: () => persisted,
      appendContextSystemNote: (channelId, note, source) => {
        appended.push({ note, ...(source !== undefined ? { source } : {}) });
        persisted.push(entry({
          role: 'system',
          timestamp: Date.now(),
          channelId,
          content: note,
          metadata: JSON.stringify({ sessionLane: { schemaVersion: 1, kind: 'system_note', source } }),
        }));
      },
    };
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    const summarizeCatchUp = vi.fn(async () => 'This morning you left off planning the afternoon errands.');
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, checkIntervalMs: 900_000, minIdleMinutes: 240, minNoteIntervalMinutes: 240 },
      }),
      summarizeCatchUp,
    });

    // Not idle long enough yet.
    vi.setSystemTime(new Date(morningAt + 30 * 60_000));
    await scheduler.tick();
    expect(appended).toHaveLength(0);

    // Long same-day gap: lighter refresh fires.
    vi.setSystemTime(new Date(afternoonAt));
    await scheduler.tick();
    expect(appended).toHaveLength(1);
    expect(appended[0].source).toBe(TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE);
    expect(appended[0].note).toContain('[Time-of-day refresher]');
    expect(appended[0].note).toContain('afternoon');
    expect(appended[0].note).toContain('This morning you left off planning the afternoon errands.');
    expect(summarizeCatchUp).toHaveBeenCalledTimes(1);

    // Anti-loop: the next check does not stack another note.
    vi.setSystemTime(new Date(afternoonAt + 20 * 60_000));
    await scheduler.tick();
    expect(appended).toHaveLength(1);
    expect(scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)?.lastOutcome).toBe('succeeded');
  });

  it('escalates overnight textures to the full new-day framing with the shared catch-up summary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY1_NIGHT));
    const appended: Array<{ note: string; source?: string }> = [];
    const port: TemporalWakeupSessionManagerPort = {
      resolveStartupSessionMetadata: () => ({ sessionId: 'api:main', channelType: 'api', timestamp: DAY1_NIGHT }),
      getRecentMessages: () => [entry({ role: 'user', timestamp: DAY1_NIGHT })],
      appendContextSystemNote: (_channelId, note, source) => {
        appended.push({ note, ...(source !== undefined ? { source } : {}) });
      },
    };
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, checkIntervalMs: 900_000, minIdleMinutes: 240, minNoteIntervalMinutes: 240 },
      }),
      summarizeCatchUp: async () => 'Yesterday ended mid-thought about the trip.',
    });

    vi.setSystemTime(new Date(DAY2_MORNING + 2 * 60 * 60_000));
    await scheduler.tick();

    expect(appended).toHaveLength(1);
    expect(appended[0].source).toBe(TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE);
    expect(appended[0].note).toContain('[Temporal wake]');
    expect(appended[0].note).toContain('Yesterday ended mid-thought about the trip.');
  });

  it('registers nothing when the namespace is disabled', () => {
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: {
        resolveStartupSessionMetadata: () => null,
        getRecentMessages: () => [],
        appendContextSystemNote: () => {},
      },
      config: makeWakeConfig({ enabled: false }),
    });
    expect(scheduler.getTask(TEMPORAL_WAKEUP_MORNING_TASK_ID)).toBeUndefined();
    expect(scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)).toBeUndefined();
  });
});

// ── Multi-channel fan-out (bead psfn-framework-2x37.3) ──

interface FanoutChannelFixture {
  sessionId: string;
  channelType: string;
  /** Recent conversational entries the eligibility check reads for this channel. */
  entries: SessionEntry[];
}

/**
 * Mock port whose enumeration returns a fixed set of channels; per-channel
 * recent entries and persisted notes are keyed by sessionId so the anti-loop
 * scan behaves per channel exactly as the real manager would.
 */
function makeFanoutPort(channels: readonly FanoutChannelFixture[]): {
  port: TemporalWakeupSessionManagerPort;
  appended: Array<{ channelId: string; note: string; source?: string }>;
} {
  const appended: Array<{ channelId: string; note: string; source?: string }> = [];
  const persistedByChannel = new Map<string, SessionEntry[]>();
  const byId = new Map(channels.map(channel => [channel.sessionId, channel]));
  const metadata = (fixture: FanoutChannelFixture): StartupSessionMetadata => ({
    sessionId: fixture.sessionId,
    channelType: fixture.channelType,
    timestamp: fixture.entries.reduce((latest, e) => Math.max(latest, e.timestamp), 0),
  });
  const port: TemporalWakeupSessionManagerPort = {
    resolveStartupSessionMetadata: () => (channels[0] ? metadata(channels[0]) : null),
    listRecentlyActiveChannels: () => channels.map(metadata),
    getRecentMessages: (channelId: string) => byId.get(channelId)?.entries ?? [],
    getRecentSessionEntries: (channelId: string) => persistedByChannel.get(channelId) ?? [],
    appendContextSystemNote: (channelId: string, note: string, source?: string) => {
      appended.push({ channelId, note, ...(source !== undefined ? { source } : {}) });
      const list = persistedByChannel.get(channelId) ?? [];
      list.push(entry({
        role: 'system',
        timestamp: Date.now(),
        channelId,
        content: note,
        metadata: JSON.stringify({ sessionLane: { schemaVersion: 1, kind: 'system_note', source } }),
      }));
      persistedByChannel.set(channelId, list);
    },
  };
  return { port, appended };
}

function runMorningHandler(scheduler: Scheduler): Promise<void> {
  const handler = scheduler.getTask(TEMPORAL_WAKEUP_MORNING_TASK_ID)?.handler;
  if (!handler) throw new Error('morning wake task was not registered');
  return Promise.resolve(handler());
}

describe('temporal wake fan-out across channels (2x37.3)', () => {
  // A discord-like DM and a satellite-like room are both private/invite_only.
  const DISCORD = 'discord:dm-alpha';
  const SATELLITE = 'satellite:bedroom';
  const IDLE = 'discord:dm-quiet';
  const PUBLIC = 'twitter:timeline';
  const INTERNAL = 'internal:reflection:daily';
  const TESTING = 'api:rollout-validator:testing:kube-rollout-validation-20260719';

  it('morning lane injects the new-day frame into every active channel and skips idle/public/internal/testing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    const { port, appended } = makeFanoutPort([
      { sessionId: DISCORD, channelType: 'discord', entries: [entry({ channelId: DISCORD, role: 'user', timestamp: DAY1_EVENING })] },
      { sessionId: SATELLITE, channelType: 'wyoming', entries: [entry({ channelId: SATELLITE, role: 'user', timestamp: DAY1_EVENING - 60_000 })] },
      // Idle: only the companion spoke recently — no partner turn to wake for.
      { sessionId: IDLE, channelType: 'discord', entries: [entry({ channelId: IDLE, role: 'assistant', timestamp: DAY1_NIGHT })] },
      // Public broadcast surface: privacy boundary blocks quiet-time notes.
      { sessionId: PUBLIC, channelType: 'api', entries: [entry({ channelId: PUBLIC, role: 'user', timestamp: DAY1_EVENING })] },
      // Internal reflection channel: never a wake target.
      { sessionId: INTERNAL, channelType: 'terminal', entries: [entry({ channelId: INTERNAL, role: 'user', timestamp: DAY1_EVENING })] },
      // Harness traffic is ephemeral and never receives autonomous notes.
      { sessionId: TESTING, channelType: 'api', entries: [entry({ channelId: TESTING, role: 'user', timestamp: DAY1_EVENING })] },
    ]);
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });

    await runMorningHandler(scheduler);

    const noteChannels = appended.map(a => a.channelId).sort();
    expect(noteChannels).toEqual([DISCORD, SATELLITE].sort());
    expect(appended.every(a => a.source === TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE)).toBe(true);
    expect(appended.every(a => a.note.includes('[Temporal wake]'))).toBe(true);
  });

  it('morning lane does NOT wake a channel idle past the lookback window (7toj: no idle latest force-append)', async () => {
    vi.useFakeTimers();
    // Partner last spoke 4 days before the wake slot — outside the 72h
    // lookback, so enumeration returns nothing. The latest session is no longer
    // force-added: fanning a wake note to a channel with no recent partner
    // activity is exactly the over-broad behavior 7toj removes (fail closed).
    const FOUR_DAYS_AGO = DAY2_MORNING - 4 * 24 * 60 * 60_000;
    const { port, appended } = makeFanoutPort([
      { sessionId: DISCORD, channelType: 'discord', entries: [entry({ channelId: DISCORD, role: 'user', timestamp: FOUR_DAYS_AGO })] },
    ]);
    port.listRecentlyActiveChannels = () => [];
    vi.setSystemTime(new Date(DAY2_MORNING));
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });

    await runMorningHandler(scheduler);

    expect(appended).toEqual([]);
  });

  it('morning lane fan-out excludes non-live channel types even when recently active (7toj)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    // All three channels have recent partner activity within the lookback, but
    // only the live conversational surfaces (discord DM, satellite) may receive
    // an autonomous wake note; the local dev terminal channel is excluded.
    const TERMINAL = 'terminal:local-dev';
    const { port, appended } = makeFanoutPort([
      { sessionId: DISCORD, channelType: 'discord', entries: [entry({ channelId: DISCORD, role: 'user', timestamp: DAY1_EVENING })] },
      { sessionId: SATELLITE, channelType: 'wyoming', entries: [entry({ channelId: SATELLITE, role: 'user', timestamp: DAY1_EVENING })] },
      { sessionId: TERMINAL, channelType: 'terminal', entries: [entry({ channelId: TERMINAL, role: 'user', timestamp: DAY1_EVENING })] },
    ]);
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });

    await runMorningHandler(scheduler);

    expect(appended.map(a => a.channelId).sort()).toEqual([DISCORD, SATELLITE].sort());
  });

  it('morning outward delivery targets only the single most-recent-partner channel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    // Satellite partner activity is more recent than discord's.
    const { port, appended } = makeFanoutPort([
      { sessionId: DISCORD, channelType: 'discord', entries: [entry({ channelId: DISCORD, role: 'user', timestamp: DAY1_EVENING - 30 * 60_000 })] },
      { sessionId: SATELLITE, channelType: 'wyoming', entries: [entry({ channelId: SATELLITE, role: 'user', timestamp: DAY1_EVENING })] },
    ]);
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    const dispatchOutbound = vi.fn(async () => ({ outcome: 'sent' as const }));
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      invokeWakeTurn: async () => 'good morning',
      dispatchOutbound,
    });

    await runMorningHandler(scheduler);

    // Internal frames fanned out to BOTH channels...
    expect(appended.map(a => a.channelId).sort()).toEqual([DISCORD, SATELLITE].sort());
    // ...but outward delivery fired exactly once, to the most-recent-partner channel.
    expect(dispatchOutbound).toHaveBeenCalledTimes(1);
    expect(dispatchOutbound.mock.calls[0][0]).toMatchObject({ channelId: SATELLITE });
  });

  it('morning anti-loop injects at most one note per channel per day across repeated fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    const { port, appended } = makeFanoutPort([
      { sessionId: DISCORD, channelType: 'discord', entries: [entry({ channelId: DISCORD, role: 'user', timestamp: DAY1_EVENING })] },
      { sessionId: SATELLITE, channelType: 'wyoming', entries: [entry({ channelId: SATELLITE, role: 'user', timestamp: DAY1_EVENING })] },
    ]);
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });

    await runMorningHandler(scheduler);
    // Second fire later the SAME day: the in-memory proof (with persisted-note
    // fallback when needed) suppresses any further note per channel.
    vi.setSystemTime(new Date(DAY2_MORNING + 3 * 60 * 60_000));
    await runMorningHandler(scheduler);

    expect(appended.filter(a => a.channelId === DISCORD)).toHaveLength(1);
    expect(appended.filter(a => a.channelId === SATELLITE)).toHaveLength(1);
  });

  it('idle refresher fans the refresh out to every active channel, skipping public/internal/testing', async () => {
    vi.useFakeTimers();
    // Same-day long gap: last activity was this morning, now late afternoon.
    const morningAt = Date.parse('2026-06-11T09:00:00.000Z');
    const afternoonAt = Date.parse('2026-06-11T15:30:00.000Z');
    vi.setSystemTime(new Date(afternoonAt));
    const { port, appended } = makeFanoutPort([
      { sessionId: DISCORD, channelType: 'discord', entries: [entry({ channelId: DISCORD, role: 'user', timestamp: morningAt })] },
      { sessionId: SATELLITE, channelType: 'wyoming', entries: [entry({ channelId: SATELLITE, role: 'user', timestamp: morningAt })] },
      { sessionId: PUBLIC, channelType: 'api', entries: [entry({ channelId: PUBLIC, role: 'user', timestamp: morningAt })] },
      { sessionId: INTERNAL, channelType: 'terminal', entries: [entry({ channelId: INTERNAL, role: 'user', timestamp: morningAt })] },
      { sessionId: TESTING, channelType: 'api', entries: [entry({ channelId: TESTING, role: 'user', timestamp: morningAt })] },
    ]);
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, checkIntervalMs: 900_000, minIdleMinutes: 120, minNoteIntervalMinutes: 120 },
      }),
    });

    const handler = scheduler.getTask(TEMPORAL_WAKEUP_REFRESHER_TASK_ID)?.handler;
    if (!handler) throw new Error('refresher task was not registered');
    await handler();

    expect(appended.map(a => a.channelId).sort()).toEqual([DISCORD, SATELLITE].sort());
    expect(appended.every(a => a.source === TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE)).toBe(true);
  });

  it('does not fall back to a testing-marked latest session without enumeration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY2_MORNING));
    const { port, appended } = makeFanoutPort([
      { sessionId: TESTING, channelType: 'api', entries: [entry({ channelId: TESTING, role: 'user', timestamp: DAY1_EVENING })] },
    ]);
    delete port.listRecentlyActiveChannels;
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
    });

    await runMorningHandler(scheduler);

    expect(appended).toEqual([]);
  });
});

describe('listRecentlyActiveChannels (real session manager)', () => {
  let dir: string;
  let store: SessionStore;
  let mgr: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-wakeup-enum-'));
    store = new SessionStore(dir);
    mgr = new SessionManager(store, makeConfig(), new EventBus());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only channels with in-lookback partner activity, most-recent first', () => {
    vi.useFakeTimers();
    const nowMs = DAY2_MORNING;

    // Stale/idle channel: partner spoke 5 days ago (outside a 72h lookback).
    vi.setSystemTime(new Date(nowMs - 5 * 24 * 60 * 60_000));
    mgr.recordUserMessage('discord:dm-stale', 'earlier in the week', 'user-1', 'Partner');

    // Assistant-only channel in-window: no partner turn, so not a wake target.
    vi.setSystemTime(new Date(nowMs - 3 * 60 * 60_000));
    mgr.recordAssistantMessage('discord:dm-assistant-only', 'are you there?');

    // Two genuinely active channels, satellite more recent than discord.
    vi.setSystemTime(new Date(DAY1_EVENING));
    mgr.recordUserMessage('discord:dm-alpha', 'evening chat', 'user-1', 'Partner');
    vi.setSystemTime(new Date(DAY1_EVENING + 45 * 60_000));
    mgr.recordUserMessage('satellite:bedroom', 'goodnight', 'user-1', 'Partner');

    const active = mgr.listRecentlyActiveChannels({ lookbackMs: 72 * 60 * 60_000, nowMs });
    expect(active.map(channel => channel.sessionId)).toEqual(['satellite:bedroom', 'discord:dm-alpha']);
    expect(active.map(channel => channel.lastRole)).toEqual(['user', 'user']);
  });
});

describe('day-scoped catch-up summary (2x37.5)', () => {
  it('summarizes only the latest chat day, dropping earlier-day entries', async () => {
    vi.useFakeTimers();
    const dayA = Date.parse('2026-06-09T10:00:00.000Z');
    const dayB = Date.parse('2026-06-10T14:00:00.000Z');
    const dayCUser = Date.parse('2026-06-11T07:00:00.000Z');
    const dayCAssistant = Date.parse('2026-06-11T07:05:00.000Z');
    const nowMs = Date.parse('2026-06-11T08:05:00.000Z');
    vi.setSystemTime(new Date(nowMs));

    const spanning: SessionEntry[] = [
      entry({ channelId: 'discord:dm-alpha', role: 'user', timestamp: dayA, content: 'day A user' }),
      entry({ channelId: 'discord:dm-alpha', role: 'assistant', timestamp: dayA + 60_000, content: 'day A reply' }),
      entry({ channelId: 'discord:dm-alpha', role: 'user', timestamp: dayB, content: 'day B user' }),
      entry({ channelId: 'discord:dm-alpha', role: 'assistant', timestamp: dayB + 60_000, content: 'day B reply' }),
      entry({ channelId: 'discord:dm-alpha', role: 'user', timestamp: dayCUser, content: 'day C user' }),
      entry({ channelId: 'discord:dm-alpha', role: 'assistant', timestamp: dayCAssistant, content: 'day C reply' }),
    ];
    const { port } = makeFanoutPort([
      { sessionId: 'discord:dm-alpha', channelType: 'discord', entries: spanning },
    ]);

    let captured: SessionEntry[] | undefined;
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 60_000, heartbeatIntervalMs: 1_800_000 });
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({ refresher: { enabled: false } }),
      summarizeCatchUp: async ({ entries }) => {
        captured = [...entries];
        return 'the latest day, summarized';
      },
    });

    await runMorningHandler(scheduler);

    expect(captured).toBeDefined();
    expect(captured?.map(e => e.timestamp)).toEqual([dayCUser, dayCAssistant]);
    // No entry from the earlier two days leaked into the summarizer.
    expect(captured?.some(e => e.timestamp === dayA || e.timestamp === dayB)).toBe(false);
  });
});
