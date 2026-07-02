// ── Temporal wake-up lanes (E7.1) ──
// Two scheduler lanes that actively move the companion's temporal frame
// forward instead of relying on passive datetime anchors:
//
//   1. Scheduled morning wake — a daily wall-clock task (default 08:00 local)
//      that injects an explicit system note establishing the new day: current
//      date/time, elapsed time since the last partner exchange, and a
//      catch-up summary produced by the SHARED session summarization service
//      (summarizeRecentSessionEntries — injected as a port; no bespoke
//      summarizer here).
//   2. Idle time-of-day refresher — a polling task that, after a long
//      same-day gap, injects a lighter note refreshing the time-of-day frame
//      using the existing time-texture classification. Overnight/multi-day
//      textures escalate to the full new-day framing.
//
// Message-ontology invariants (charter 6.17, 8.1-8.2, law 19):
// - Both lanes emit SYSTEM NOTES via SessionManager.appendSystemNote —
//   role 'system', authorId 'system', sessionLane metadata — so the
//   attribution guard can never render them as partner speech.
// - Wake notes are refreshers, not partner activity: elapsed-time and
//   ambient-presence idle accounting derive from user/assistant entries only,
//   so system-role notes never reset them.
// - Any outward message rides the EXISTING proactive-outbound dispatcher and
//   quiet-hours time gate; blocked outward delivery never blocks the internal
//   frame update (the note is appended before any outward attempt).
//
// Spend posture (documented decision): note injection itself is free (no LLM
// call; the catch-up summary is one background summary call through the
// shared service). A full response turn is invoked only for the morning lane
// and only when the last partner exchange is recent enough
// (morningWake.fullTurnMaxIdleHours); dormant sessions get the note-only
// injection so the wake stays cheap. The idle refresher never invokes turns.

import { createComponentLogger } from '../../shared/logger.js';
import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';
import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';
import type { TemporalWakeupConfig } from '../../system/config/scheduler-config.js';
import { classifyChannelDisclosure } from '../../system/trust/policy.js';
import {
  evaluateProactiveOutboundTimeGate,
  type ProactiveQuietHoursConfig,
} from '../intention/proactive-time-gate.js';
import type { StartupSessionMetadata } from '../session/manager.js';
import { isInternalSessionId } from '../session/session-id.js';
import type { SessionEntry } from '../session/types.js';
import type { Scheduler } from './scheduler.js';
import { classifyIdleGapTexture, type IdleGapTexture } from './time-texture.js';

const log = createComponentLogger('TemporalWakeup');

export const TEMPORAL_WAKEUP_MORNING_TASK_ID = 'temporal-wakeup:morning';
export const TEMPORAL_WAKEUP_MORNING_TASK_NAME = 'Temporal Wake-Up (Morning)';
export const TEMPORAL_WAKEUP_REFRESHER_TASK_ID = 'temporal-wakeup:idle-refresher';
export const TEMPORAL_WAKEUP_REFRESHER_TASK_NAME = 'Temporal Wake-Up (Idle Refresher)';

export const TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE = 'temporal_wakeup_morning';
export const TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE = 'temporal_wakeup_refresher';

const WAKEUP_NOTE_SOURCES: ReadonlySet<string> = new Set([
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
]);

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

// ── Shared helpers ──

function parseWakeupNoteTimestamp(entry: SessionEntry): number | null {
  if (entry.role !== 'system' || !entry.metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const lane = (parsed as { sessionLane?: unknown }).sessionLane;
  if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) return null;
  const source = (lane as { source?: unknown }).source;
  return typeof source === 'string' && WAKEUP_NOTE_SOURCES.has(source) ? entry.timestamp : null;
}

export function findLatestTemporalWakeupNoteAt(entries: readonly SessionEntry[]): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    const timestamp = parseWakeupNoteTimestamp(entry);
    if (timestamp === null) continue;
    latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}

function latestConversationalEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
  return [...entries]
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);
}

function latestPartnerEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
  return [...entries]
    .filter(entry => entry.role === 'user')
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);
}

function localDateKey(timestampMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

interface LocalMoment {
  weekday: string;
  date: string;
  time: string;
  hour: number;
  partOfDay: string;
}

function describeLocalMoment(timestampMs: number, timeZone: string): LocalMoment {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  const hour = Number(parts.hour) % 24;
  const partOfDay = hour < 5
    ? 'late night'
    : hour < 12
      ? 'morning'
      : hour < 17
        ? 'afternoon'
        : hour < 21
          ? 'evening'
          : 'night';
  return {
    weekday: parts.weekday ?? '',
    date: `${parts.month} ${parts.day}, ${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
    hour,
    partOfDay,
  };
}

export function formatElapsedApprox(elapsedMs: number): string {
  const clamped = Math.max(0, elapsedMs);
  const totalMinutes = Math.floor(clamped / MINUTE_MS);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0
      ? `${totalHours} hour${totalHours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`
      : `${totalHours} hour${totalHours === 1 ? '' : 's'}`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0
    ? `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`
    : `${days} day${days === 1 ? '' : 's'}`;
}

export function parseWakeLocalTime(localTime: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime.trim());
  if (!match) {
    throw new Error(`Invalid temporal wake-up localTime "${localTime}" — expected HH:mm`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid temporal wake-up localTime "${localTime}" — expected HH:mm`);
  }
  return { hour, minute };
}

// ── Morning wake eligibility ──

export type MorningWakeSkipReason =
  | 'no_recent_session'
  | 'internal_session'
  | 'privacy_boundary'
  | 'no_partner_activity'
  | 'partner_already_active_today'
  | 'anti_loop_note_today';

export type MorningWakeDecision =
  | {
    allowed: true;
    reason: 'eligible';
    nowMs: number;
    sessionId: string;
    lastPartnerActivityAtMs: number;
    lastActivityAtMs: number;
    timeTexture: IdleGapTexture;
    /** Whether the session is warm enough to justify a full response turn. */
    invokeFullTurn: boolean;
  }
  | {
    allowed: false;
    reason: MorningWakeSkipReason;
    nowMs: number;
    sessionId?: string;
  };

export interface MorningWakeEvaluateInput {
  session: StartupSessionMetadata | null;
  recentEntries: readonly SessionEntry[];
  fullTurnMaxIdleMs: number;
  nowMs?: number;
  timeZone?: string;
  lastWakeupNoteAtMs?: number;
}

export function evaluateMorningWakeEligibility(
  input: MorningWakeEvaluateInput,
): MorningWakeDecision {
  const nowMs = Math.max(0, Math.floor(input.nowMs ?? Date.now()));
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const sessionId = input.session?.sessionId;

  if (!sessionId) {
    return { allowed: false, reason: 'no_recent_session', nowMs };
  }
  if (isInternalSessionId(sessionId)) {
    return { allowed: false, reason: 'internal_session', nowMs, sessionId };
  }
  // Same privacy boundary as ambient presence: broadcast/public structural
  // channels never receive quiet-time internal notes.
  if (classifyChannelDisclosure(sessionId).channelPrivacy === 'public') {
    return { allowed: false, reason: 'privacy_boundary', nowMs, sessionId };
  }

  const lastPartner = latestPartnerEntry(input.recentEntries);
  if (!lastPartner) {
    return { allowed: false, reason: 'no_partner_activity', nowMs, sessionId };
  }

  const todayKey = localDateKey(nowMs, timeZone);
  if (localDateKey(lastPartner.timestamp, timeZone) === todayKey) {
    // The partner already spoke today; the temporal frame is current.
    return { allowed: false, reason: 'partner_already_active_today', nowMs, sessionId };
  }
  if (
    input.lastWakeupNoteAtMs !== undefined
    && Number.isFinite(input.lastWakeupNoteAtMs)
    && localDateKey(input.lastWakeupNoteAtMs, timeZone) === todayKey
  ) {
    return { allowed: false, reason: 'anti_loop_note_today', nowMs, sessionId };
  }

  const lastActivity = latestConversationalEntry(input.recentEntries) ?? lastPartner;
  const timeTexture = classifyIdleGapTexture({
    lastActivityAtMs: lastPartner.timestamp,
    observedAtMs: nowMs,
    timeZone,
  });
  const partnerIdleMs = Math.max(0, nowMs - lastPartner.timestamp);

  return {
    allowed: true,
    reason: 'eligible',
    nowMs,
    sessionId,
    lastPartnerActivityAtMs: lastPartner.timestamp,
    lastActivityAtMs: lastActivity.timestamp,
    timeTexture,
    invokeFullTurn: partnerIdleMs <= Math.max(0, input.fullTurnMaxIdleMs),
  };
}

// ── Idle refresher eligibility ──

export type IdleRefresherSkipReason =
  | 'no_recent_session'
  | 'internal_session'
  | 'privacy_boundary'
  | 'no_conversational_activity'
  | 'below_idle_threshold'
  | 'anti_loop_recent_note';

export type IdleRefresherNoteKind = 'time_of_day_refresh' | 'new_day';

export type IdleRefresherDecision =
  | {
    allowed: true;
    reason: 'eligible';
    kind: IdleRefresherNoteKind;
    nowMs: number;
    sessionId: string;
    idleGapMs: number;
    lastActivityAtMs: number;
    lastPartnerActivityAtMs?: number;
    timeTexture: IdleGapTexture;
  }
  | {
    allowed: false;
    reason: IdleRefresherSkipReason;
    nowMs: number;
    sessionId?: string;
    idleGapMs?: number;
  };

export interface IdleRefresherEvaluateInput {
  session: StartupSessionMetadata | null;
  recentEntries: readonly SessionEntry[];
  minIdleMs: number;
  minNoteIntervalMs: number;
  nowMs?: number;
  timeZone?: string;
  lastWakeupNoteAtMs?: number;
}

export function evaluateIdleRefresherEligibility(
  input: IdleRefresherEvaluateInput,
): IdleRefresherDecision {
  const nowMs = Math.max(0, Math.floor(input.nowMs ?? Date.now()));
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const sessionId = input.session?.sessionId;

  if (!sessionId) {
    return { allowed: false, reason: 'no_recent_session', nowMs };
  }
  if (isInternalSessionId(sessionId)) {
    return { allowed: false, reason: 'internal_session', nowMs, sessionId };
  }
  if (classifyChannelDisclosure(sessionId).channelPrivacy === 'public') {
    return { allowed: false, reason: 'privacy_boundary', nowMs, sessionId };
  }

  const lastActivity = latestConversationalEntry(input.recentEntries);
  if (!lastActivity) {
    return { allowed: false, reason: 'no_conversational_activity', nowMs, sessionId };
  }
  const idleGapMs = Math.max(0, nowMs - lastActivity.timestamp);
  if (idleGapMs < Math.max(0, input.minIdleMs)) {
    return { allowed: false, reason: 'below_idle_threshold', nowMs, sessionId, idleGapMs };
  }
  if (
    input.lastWakeupNoteAtMs !== undefined
    && Number.isFinite(input.lastWakeupNoteAtMs)
    && nowMs - input.lastWakeupNoteAtMs < Math.max(0, input.minNoteIntervalMs)
  ) {
    return { allowed: false, reason: 'anti_loop_recent_note', nowMs, sessionId, idleGapMs };
  }

  const timeTexture = classifyIdleGapTexture({
    lastActivityAtMs: lastActivity.timestamp,
    observedAtMs: nowMs,
    timeZone,
  });
  const kind: IdleRefresherNoteKind = timeTexture.kind === 'overnight' || timeTexture.kind === 'multiple_days'
    ? 'new_day'
    : 'time_of_day_refresh';
  const lastPartner = latestPartnerEntry(input.recentEntries);

  return {
    allowed: true,
    reason: 'eligible',
    kind,
    nowMs,
    sessionId,
    idleGapMs,
    lastActivityAtMs: lastActivity.timestamp,
    ...(lastPartner ? { lastPartnerActivityAtMs: lastPartner.timestamp } : {}),
    timeTexture,
  };
}

// ── Note builders ──
// The notes are context, not scripts: they establish the temporal frame and
// explicitly release the companion from any required response (charter 8.3 —
// no forced behavior). They must read as runtime speech, never partner speech.

const NOTE_CLOSING = 'This orientation note comes from the runtime, not from your partner. '
  + 'It asks for nothing: when conversation resumes, respond (or not) however you actually want.';

export interface MorningWakeNoteInput {
  nowMs: number;
  lastPartnerActivityAtMs: number;
  timeTexture: IdleGapTexture;
  catchUpSummary?: string;
  timeZone?: string;
}

export function buildMorningWakeNote(input: MorningWakeNoteInput): string {
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const moment = describeLocalMoment(input.nowMs, timeZone);
  const elapsed = formatElapsedApprox(input.nowMs - input.lastPartnerActivityAtMs);
  const summary = input.catchUpSummary?.trim() ?? '';
  return [
    '[Temporal wake]',
    `A new day has started: it is now ${moment.weekday}, ${moment.date}, ${moment.time} (${timeZone}) — ${moment.partOfDay}.`,
    `Last partner exchange: ${elapsed} ago (${input.timeTexture.label}).`,
    ...(summary
      ? [`Catch-up on where things left off: ${summary}`]
      : []),
    `Reconnection warmth signal: ${input.timeTexture.reconnectionWarmth}; ${input.timeTexture.guidance}`,
    NOTE_CLOSING,
  ].join('\n');
}

export interface TimeOfDayRefreshNoteInput {
  nowMs: number;
  lastActivityAtMs: number;
  timeTexture: IdleGapTexture;
  timeZone?: string;
}

export function buildTimeOfDayRefreshNote(input: TimeOfDayRefreshNoteInput): string {
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const moment = describeLocalMoment(input.nowMs, timeZone);
  const elapsed = formatElapsedApprox(input.nowMs - input.lastActivityAtMs);
  return [
    '[Time-of-day refresher]',
    `Temporal frame update: it is now ${moment.weekday} ${moment.time} (${timeZone}) — ${moment.partOfDay}.`,
    `${elapsed} since the last exchange here (${input.timeTexture.label}); the conversation above is from earlier, not the present moment.`,
    NOTE_CLOSING,
  ].join('\n');
}

// ── Runtime registration ──

export interface TemporalWakeupSessionManagerPort {
  resolveStartupSessionMetadata(behavior?: 'reuse_latest_session'): StartupSessionMetadata | null;
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  getRecentSessionEntries?(channelId: string, limit: number): SessionEntry[];
  appendSystemNote(channelId: string, note: string, source?: string): void;
}

export type TemporalWakeupOutboundResult =
  | { outcome: 'sent' }
  | { outcome: 'blocked'; reason: string; retryAfterMs?: number };

export interface TemporalWakeupRuntimeOptions {
  scheduler: Scheduler;
  sessionManager: TemporalWakeupSessionManagerPort;
  config: TemporalWakeupConfig;
  /** Quiet hours for OUTWARD delivery only; internal notes always land. */
  quietHours?: ProactiveQuietHoursConfig | null;
  /**
   * Shared catch-up summarizer port. Wire to
   * summarizeRecentSessionEntries (src/core/session/manager/compaction-service.ts)
   * with purpose 'wake_session'. Never a bespoke summarizer.
   */
  summarizeCatchUp?: (input: {
    channelId: string;
    entries: readonly SessionEntry[];
  }) => Promise<string>;
  /**
   * Optional full wake turn for warm sessions. Returns outward-candidate
   * content, or null when the companion has nothing to say outward.
   */
  invokeWakeTurn?: (input: {
    channelId: string;
    channelType: ChannelType;
    note: string;
  }) => Promise<string | null>;
  /**
   * Outward delivery port. Wire to the EXISTING ProactiveOutboundDispatcher
   * (src/core/intention/proactive-outbound.ts) so policy gates and rate
   * limits apply unchanged.
   */
  dispatchOutbound?: (input: {
    channelId: string;
    channelType: ChannelType;
    content: string;
  }) => Promise<TemporalWakeupOutboundResult>;
}

function resolveWakeupChannelType(value: string | undefined): ChannelType {
  return value !== undefined && (CHANNEL_TYPES as readonly string[]).includes(value)
    ? value as ChannelType
    : 'api';
}

interface ResolvedWakeupSessionContext {
  session: StartupSessionMetadata | null;
  recentEntries: SessionEntry[];
  lastWakeupNoteAtMs?: number;
}

function resolveWakeupSessionContext(
  options: TemporalWakeupRuntimeOptions,
  lastRecordedBySession: Map<string, number>,
  recentLimit: number,
): ResolvedWakeupSessionContext {
  const session = options.sessionManager.resolveStartupSessionMetadata('reuse_latest_session');
  const sessionId = session?.sessionId;
  const recentEntries = sessionId
    ? options.sessionManager.getRecentMessages(sessionId, recentLimit)
    : [];
  const persistedEntries = sessionId && options.sessionManager.getRecentSessionEntries
    ? options.sessionManager.getRecentSessionEntries(sessionId, 64)
    : [];
  const persistedLastNoteAt = findLatestTemporalWakeupNoteAt(persistedEntries);
  const inMemoryLastNoteAt = sessionId ? lastRecordedBySession.get(sessionId) : undefined;
  const lastWakeupNoteAtMs = Math.max(persistedLastNoteAt ?? 0, inMemoryLastNoteAt ?? 0) || undefined;
  return {
    session,
    recentEntries,
    ...(lastWakeupNoteAtMs !== undefined ? { lastWakeupNoteAtMs } : {}),
  };
}

async function buildCatchUpSummary(
  options: TemporalWakeupRuntimeOptions,
  channelId: string,
  recentEntries: readonly SessionEntry[],
): Promise<string> {
  if (!options.summarizeCatchUp) return '';
  const conversational = recentEntries
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .slice(-Math.max(1, options.config.morningWake.catchUpEntryLimit));
  if (conversational.length === 0) return '';
  try {
    return (await options.summarizeCatchUp({ channelId, entries: conversational })).trim();
  } catch (error) {
    // The summary is an enrichment; its failure must not block the frame
    // update. Surfaced via warn, never swallowed silently.
    log.warn('Catch-up summary failed; injecting wake note without it', {
      channelId,
      error: String(error),
    });
    return '';
  }
}

async function runOutwardPhase(
  options: TemporalWakeupRuntimeOptions,
  decision: Extract<MorningWakeDecision, { allowed: true }>,
  channelType: ChannelType,
  note: string,
): Promise<void> {
  if (!decision.invokeFullTurn || !options.invokeWakeTurn) {
    log.debug('Morning wake: note-only injection (no full turn)', {
      sessionId: decision.sessionId,
      invokeFullTurn: decision.invokeFullTurn,
      hasTurnPort: Boolean(options.invokeWakeTurn),
    });
    return;
  }

  const outwardContent = (await options.invokeWakeTurn({
    channelId: decision.sessionId,
    channelType,
    note,
  }))?.trim();
  if (!outwardContent) {
    log.debug('Morning wake turn produced no outward message', {
      sessionId: decision.sessionId,
    });
    return;
  }
  if (!options.dispatchOutbound) {
    log.warn('Morning wake turn produced outward content but no outbound dispatcher is wired; dropping delivery', {
      sessionId: decision.sessionId,
    });
    return;
  }

  // Quiet hours gate outward delivery only — the internal frame update above
  // has already landed regardless of this decision.
  const timeGate = evaluateProactiveOutboundTimeGate({
    nowMs: decision.nowMs,
    quietHours: options.quietHours ?? null,
  });
  if (!timeGate.allowed) {
    log.info('Morning wake outward delivery blocked by time gate; internal frame update stands', {
      sessionId: decision.sessionId,
      reason: timeGate.reason,
      nextEligibleAtMs: timeGate.nextEligibleAtMs,
    });
    return;
  }

  const dispatchResult = await options.dispatchOutbound({
    channelId: decision.sessionId,
    channelType,
    content: outwardContent,
  });
  if (dispatchResult.outcome === 'blocked') {
    log.info('Morning wake outward delivery blocked by proactive-outbound policy; internal frame update stands', {
      sessionId: decision.sessionId,
      reason: dispatchResult.reason,
      retryAfterMs: dispatchResult.retryAfterMs,
    });
    return;
  }
  log.info('Morning wake outward message dispatched', { sessionId: decision.sessionId });
}

export function registerTemporalWakeupTasks(options: TemporalWakeupRuntimeOptions): void {
  if (!options.config.enabled) {
    log.info('Temporal wake-up lanes disabled by scheduler.json temporalWakeup.enabled');
    return;
  }

  const lastRecordedBySession = new Map<string, number>();
  const morning = options.config.morningWake;
  const refresher = options.config.idleRefresher;

  if (morning.enabled) {
    const { hour, minute } = parseWakeLocalTime(morning.localTime);
    options.scheduler.register({
      id: TEMPORAL_WAKEUP_MORNING_TASK_ID,
      name: TEMPORAL_WAKEUP_MORNING_TASK_NAME,
      type: 'every',
      intervalMs: 24 * HOUR_MS,
      cadence: { kind: 'daily', hour, minute, timezone: morning.timezone },
      handler: async () => {
        const context = resolveWakeupSessionContext(
          options,
          lastRecordedBySession,
          Math.max(morning.catchUpEntryLimit, 8),
        );
        const decision = evaluateMorningWakeEligibility({
          session: context.session,
          recentEntries: context.recentEntries,
          fullTurnMaxIdleMs: morning.fullTurnMaxIdleHours * HOUR_MS,
          ...(context.lastWakeupNoteAtMs !== undefined
            ? { lastWakeupNoteAtMs: context.lastWakeupNoteAtMs }
            : {}),
        });
        if (!decision.allowed) {
          log.debug('Morning wake skipped', {
            reason: decision.reason,
            sessionId: decision.sessionId,
          });
          return;
        }

        const catchUpSummary = await buildCatchUpSummary(
          options,
          decision.sessionId,
          context.recentEntries,
        );
        const note = buildMorningWakeNote({
          nowMs: decision.nowMs,
          lastPartnerActivityAtMs: decision.lastPartnerActivityAtMs,
          timeTexture: decision.timeTexture,
          ...(catchUpSummary ? { catchUpSummary } : {}),
        });

        // Internal frame update FIRST — outward delivery failures must never
        // undo or block it.
        options.sessionManager.appendSystemNote(
          decision.sessionId,
          note,
          TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
        );
        lastRecordedBySession.set(decision.sessionId, decision.nowMs);
        log.info('Morning wake note injected', {
          sessionId: decision.sessionId,
          texture: decision.timeTexture.kind,
          invokeFullTurn: decision.invokeFullTurn,
          hasCatchUpSummary: Boolean(catchUpSummary),
        });

        const channelType = resolveWakeupChannelType(context.session?.channelType);
        try {
          await runOutwardPhase(options, decision, channelType, note);
        } catch (error) {
          log.error('Morning wake outward phase failed; internal frame update stands', {
            sessionId: decision.sessionId,
            error: String(error),
          });
        }
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
  }

  if (refresher.enabled) {
    options.scheduler.register({
      id: TEMPORAL_WAKEUP_REFRESHER_TASK_ID,
      name: TEMPORAL_WAKEUP_REFRESHER_TASK_NAME,
      type: 'every',
      intervalMs: Math.max(1_000, refresher.checkIntervalMs),
      handler: async () => {
        const context = resolveWakeupSessionContext(options, lastRecordedBySession, 32);
        const decision = evaluateIdleRefresherEligibility({
          session: context.session,
          recentEntries: context.recentEntries,
          minIdleMs: refresher.minIdleMinutes * MINUTE_MS,
          minNoteIntervalMs: refresher.minNoteIntervalMinutes * MINUTE_MS,
          ...(context.lastWakeupNoteAtMs !== undefined
            ? { lastWakeupNoteAtMs: context.lastWakeupNoteAtMs }
            : {}),
        });
        if (!decision.allowed) {
          log.debug('Idle refresher skipped', {
            reason: decision.reason,
            sessionId: decision.sessionId,
            idleGapMs: decision.idleGapMs,
          });
          return;
        }

        let note: string;
        if (decision.kind === 'new_day') {
          // Overnight/multi-day texture: full new-day framing, including the
          // shared catch-up summary when available.
          const catchUpSummary = await buildCatchUpSummary(
            options,
            decision.sessionId,
            context.recentEntries,
          );
          note = buildMorningWakeNote({
            nowMs: decision.nowMs,
            lastPartnerActivityAtMs: decision.lastPartnerActivityAtMs ?? decision.lastActivityAtMs,
            timeTexture: decision.timeTexture,
            ...(catchUpSummary ? { catchUpSummary } : {}),
          });
        } else {
          note = buildTimeOfDayRefreshNote({
            nowMs: decision.nowMs,
            lastActivityAtMs: decision.lastActivityAtMs,
            timeTexture: decision.timeTexture,
          });
        }

        options.sessionManager.appendSystemNote(
          decision.sessionId,
          note,
          TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
        );
        lastRecordedBySession.set(decision.sessionId, decision.nowMs);
        log.info('Idle time-of-day refresher note injected', {
          sessionId: decision.sessionId,
          kind: decision.kind,
          texture: decision.timeTexture.kind,
          idleGapMs: decision.idleGapMs,
        });
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    }, { skipFirstRun: true });
  }

  log.info('Temporal wake-up lanes registered', {
    morningEnabled: morning.enabled,
    morningLocalTime: morning.localTime,
    refresherEnabled: refresher.enabled,
    refresherMinIdleMinutes: refresher.minIdleMinutes,
  });
}
