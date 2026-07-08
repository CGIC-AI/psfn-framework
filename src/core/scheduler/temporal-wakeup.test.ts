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
import { SessionManager } from '../session/manager.js';
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
import { classifyIdleGapTexture } from './time-texture.js';

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
}): TemporalWakeupConfig {
  return {
    enabled: overrides?.enabled ?? true,
    morningWake: {
      ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake,
      timezone: 'utc',
      ...overrides?.morning,
    },
    idleRefresher: {
      ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher,
      ...overrides?.refresher,
    },
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
      nowMs: DAY2_MORNING,
    });
    expect(decision).toMatchObject({
      allowed: true,
      invokeFullTurn: false,
      timeTexture: { kind: 'multiple_days' },
    });
  });

  it('skips when the partner already spoke today', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY2_MORNING - 35 * 60_000 })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'partner_already_active_today' });
  });

  it('anti-loops when a wake note already landed today', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
      nowMs: DAY2_MORNING,
      lastWakeupNoteAtMs: DAY2_MORNING - 2 * 60 * 60_000,
    })).toMatchObject({ allowed: false, reason: 'anti_loop_note_today' });
  });

  it('requires partner activity and blocks internal/public sessions', () => {
    expect(evaluateMorningWakeEligibility({
      session,
      recentEntries: [entry({ role: 'assistant', timestamp: DAY1_NIGHT })],
      fullTurnMaxIdleMs: 1,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'no_partner_activity' });

    expect(evaluateMorningWakeEligibility({
      session: { sessionId: 'internal:reflection:daily', channelType: 'api', timestamp: DAY1_NIGHT },
      recentEntries: [entry({ role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 1,
      nowMs: DAY2_MORNING,
    })).toMatchObject({ allowed: false, reason: 'internal_session' });

    expect(evaluateMorningWakeEligibility({
      session: { sessionId: 'twitter:timeline', channelType: 'api', timestamp: DAY1_NIGHT },
      recentEntries: [entry({ channelId: 'twitter:timeline', role: 'user', timestamp: DAY1_EVENING })],
      fullTurnMaxIdleMs: 1,
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
  it('builds a new-day note with date, elapsed partner gap, and catch-up summary — no scripted greeting', () => {
    const texture = classifyIdleGapTexture({
      lastActivityAtMs: DAY1_EVENING,
      observedAtMs: DAY2_MORNING,
      timeZone: 'UTC',
    });
    const note = buildMorningWakeNote({
      nowMs: DAY2_MORNING,
      lastPartnerActivityAtMs: DAY1_EVENING,
      timeTexture: texture,
      catchUpSummary: 'You and Ada wrapped up the garden plans before bed.',
      timeZone: 'UTC',
    });
    expect(note).toContain('[Temporal wake]');
    expect(note).toContain('June 11, 2026');
    expect(note).toContain('08:05');
    expect(note).toContain('morning');
    expect(note).toContain('10 hours 7 minutes ago');
    expect(note).toContain('overnight gap');
    expect(note).toContain('You and Ada wrapped up the garden plans before bed.');
    expect(note).toContain('respond (or not) however you actually want');
    // Context, not a script: the runtime never puts greeting words in play.
    expect(note.toLowerCase()).not.toContain('good morning');
    expect(note).toContain('not from your partner');
  });

  it('builds a lighter time-of-day refresh note', () => {
    const lastAt = Date.parse('2026-06-11T09:00:00.000Z');
    const nowMs = Date.parse('2026-06-11T15:30:00.000Z');
    const note = buildTimeOfDayRefreshNote({
      nowMs,
      lastActivityAtMs: lastAt,
      timeTexture: classifyIdleGapTexture({ lastActivityAtMs: lastAt, observedAtMs: nowMs, timeZone: 'UTC' }),
      timeZone: 'UTC',
    });
    expect(note).toContain('[Time-of-day refresher]');
    expect(note).toContain('15:30');
    expect(note).toContain('afternoon');
    expect(note).toContain('6 hours 30 minutes');
    expect(note).toContain('long workday gap');
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
      nowMs: probeAt,
    });
    expect(wakeProbe).toMatchObject({
      allowed: true,
      lastPartnerActivityAtMs: DAY1_EVENING,
      lastActivityAtMs: DAY1_NIGHT,
    });

    // Re-firing is prevented by the persisted-note anti-loop scan, exactly as
    // the runtime resolves it (findLatestTemporalWakeupNoteAt over the store).
    const persistedNoteAt = findLatestTemporalWakeupNoteAt(mgr.getRecentSessionEntries('api:main', 32));
    expect(persistedNoteAt).toBe(DAY2_MORNING);
    expect(evaluateMorningWakeEligibility({
      session: mgr.resolveStartupSessionMetadata('reuse_latest_session'),
      recentEntries: mgr.getRecentMessages('api:main', 16),
      fullTurnMaxIdleMs: 72 * 60 * 60_000,
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

describe('idle refresher lane', () => {
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
    registerTemporalWakeupTasks({
      scheduler,
      sessionManager: port,
      config: makeWakeConfig({
        morning: { enabled: false },
        refresher: { enabled: true, checkIntervalMs: 900_000, minIdleMinutes: 240, minNoteIntervalMinutes: 240 },
      }),
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
