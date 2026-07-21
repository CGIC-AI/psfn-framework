// ── Temporal wake-up lanes (E7.1) ──
// Two scheduler lanes that actively move the companion's temporal frame
// forward instead of relying on passive datetime anchors:
//
//   1. Scheduled morning wake — a daily wall-clock task (default 08:00 local)
//      that injects an explicit system note establishing the new day: current
//      date/time, elapsed time since the last channel exchange, and a
//      catch-up summary produced by the SHARED session summarization service
//      (summarizeRecentSessionEntries — injected as a port; no bespoke
//      summarizer here).
//   2. Idle time-of-day refresher — a polling task that, after a long
//      same-day gap, injects a lighter note refreshing the time-of-day frame
//      using the existing time-texture classification. Overnight/multi-day
//      textures escalate to the full new-day framing.
//
// Message-ontology invariants (charter 6.17, 8.1-8.2, law 19):
// - Both lanes emit SYSTEM NOTES via SessionManager.appendContextSystemNote —
//   role 'system', authorId 'system', sessionLane kind 'system_note' — which
//   participate in ordinary context builds as attributed `[SYSTEM: ...]`
//   speech, so the frame update is actually visible to the companion while
//   the attribution guard keeps it out of partner speech.
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
import { isInternalSessionId, isTestingSessionId } from '../session/session-id.js';
import {
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
} from '../session/session-lane-metadata.js';
import type { SessionEntry } from '../session/types.js';
import type { Scheduler } from './scheduler.js';
import {
  evaluateIdleRefresherPreflight,
  evaluateMorningWakePreflight,
} from './temporal-wakeup-preflight.js';
import {
  didTemporalWakeupNoteWithContentLandOnLocalDate,
  findLatestTemporalWakeupNoteAt as findLatestTemporalWakeupNoteAtForSources,
  latestTemporalWakeupTimestamp,
  temporalWakeupLocalDateKey,
} from './temporal-wakeup-note-history.js';
import { classifyIdleGapTexture } from './time-texture.js';
import {
  estimateWakeWindow,
  formatMinuteOfDay,
  minuteOfDayToHourMinute,
  type WakeWindowEstimate,
  type WakeWindowInsufficientReason,
} from './wake-window-estimator.js';
import type { TemporalWakeupMorningConfig } from '../../system/config/scheduler-config.js';
import type {
  IdleRefresherDecision,
  IdleRefresherEvaluateInput,
  IdleRefresherNoteKind,
  MorningWakeDecision,
  MorningWakeEvaluateInput,
} from './temporal-wakeup-contracts.js';

const log = createComponentLogger('TemporalWakeup');

export const TEMPORAL_WAKEUP_MORNING_TASK_ID = 'temporal-wakeup:morning';
export const TEMPORAL_WAKEUP_MORNING_TASK_NAME = 'Temporal Wake-Up (Morning)';
export const TEMPORAL_WAKEUP_REFRESHER_TASK_ID = 'temporal-wakeup:idle-refresher';
export const TEMPORAL_WAKEUP_REFRESHER_TASK_NAME = 'Temporal Wake-Up (Idle Refresher)';

export {
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
} from '../session/session-lane-metadata.js';

const WAKEUP_NOTE_SOURCES: ReadonlySet<string> = new Set([
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
]);
const MORNING_WAKEUP_NOTE_SOURCES: ReadonlySet<string> = new Set([
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
]);
const REFRESHER_WAKEUP_NOTE_SOURCES: ReadonlySet<string> = new Set([
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
]);

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const CATCH_UP_NOTE_PREFIX = 'Catch-up on where things left off:';

// ── Shared helpers ──

/**
 * Latest wake-lane note timestamp in `entries`. `sources` selects which lane's
 * notes count. The default combined set is for observability; runtime anti-loop
 * checks pass their lane's source set explicitly.
 */
export function findLatestTemporalWakeupNoteAt(
  entries: readonly SessionEntry[],
  sources: ReadonlySet<string> = WAKEUP_NOTE_SOURCES,
): number | undefined {
  return findLatestTemporalWakeupNoteAtForSources(entries, sources);
}

// ── Shared helpers ──

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
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = Object.fromEntries(
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

// ── Habit-derived wake window (E7.2) ──
// A single snapshot builder is the ONE source of truth for the effective wake
// time, shared by (a) daily-task registration, which sets the scheduler cadence
// to the resolved hour/minute, and (b) the Garden admin read route, which
// surfaces the live estimate and data sufficiency. Keeping both on the same
// function means the operator sees exactly what the scheduler will use.

export type WakeWindowSnapshotSource = 'fixed' | 'habit' | 'habit_fallback';

export interface WakeWindowSnapshot {
  /** Configured timing mode ('fixed' or 'habit'). */
  timingMode: 'fixed' | 'habit';
  /** Where the effective wake time actually came from this snapshot. */
  source: WakeWindowSnapshotSource;
  /** Effective daily wake slot the scheduler cadence uses. */
  effective: {
    hour: number;
    minute: number;
    /** HH:mm rendering of the effective wake slot. */
    localTime: string;
  };
  /** Local zone the estimate/cadence is expressed in. */
  timeZone: string;
  /**
   * Deterministic estimated window (visibility only; the cadence always fires
   * at the median). Present only when a habit estimate succeeded.
   */
  window?: {
    startLocalTime: string;
    endLocalTime: string;
    medianLocalTime: string;
  };
  /** Distinct sample days the estimate drew on (0 when no history). */
  sampleDays: number;
  /** Why a habit estimate fell back to the fixed time (absent when not fallback). */
  fallbackReason?: WakeWindowInsufficientReason;
  /** The fixed configured HH:mm — the habit fallback target. */
  configuredLocalTime: string;
}

export interface WakeWindowSnapshotInput {
  morning: TemporalWakeupMorningConfig;
  /** Partner (role 'user') timestamps in ms; ignored in 'fixed' mode. */
  partnerTimestampsMs: readonly number[];
  nowMs: number;
  timeZone: string;
}

/**
 * Resolve the effective morning wake slot for the current timing mode.
 * Deterministic: 'habit' fires at the weighted-median estimated wake time;
 * insufficient history falls back to the fixed `localTime` with a visible
 * reason. Pure — no I/O, no clock reads beyond the supplied `nowMs`.
 */
export function buildWakeWindowSnapshot(input: WakeWindowSnapshotInput): WakeWindowSnapshot {
  const { morning, timeZone } = input;
  const fixed = parseWakeLocalTime(morning.localTime);

  if (morning.timing !== 'habit') {
    return {
      timingMode: 'fixed',
      source: 'fixed',
      effective: { hour: fixed.hour, minute: fixed.minute, localTime: morning.localTime },
      timeZone,
      sampleDays: 0,
      configuredLocalTime: morning.localTime,
    };
  }

  const estimate: WakeWindowEstimate = estimateWakeWindow({
    partnerTimestampsMs: input.partnerTimestampsMs,
    nowMs: input.nowMs,
    timeZone,
    config: morning.habit,
  });

  if (!estimate.sufficient) {
    return {
      timingMode: 'habit',
      source: 'habit_fallback',
      effective: { hour: fixed.hour, minute: fixed.minute, localTime: morning.localTime },
      timeZone,
      sampleDays: estimate.sampleDays,
      fallbackReason: estimate.reason,
      configuredLocalTime: morning.localTime,
    };
  }

  const { hour, minute } = minuteOfDayToHourMinute(estimate.wakeMinuteOfDay);
  return {
    timingMode: 'habit',
    source: 'habit',
    effective: { hour, minute, localTime: formatMinuteOfDay(estimate.wakeMinuteOfDay) },
    timeZone,
    window: {
      startLocalTime: formatMinuteOfDay(estimate.windowStartMinuteOfDay),
      endLocalTime: formatMinuteOfDay(estimate.windowEndMinuteOfDay),
      medianLocalTime: formatMinuteOfDay(estimate.wakeMinuteOfDay),
    },
    sampleDays: estimate.sampleDays,
    configuredLocalTime: morning.localTime,
  };
}

/** Zone the habit estimate/cadence is expressed in, matching the cadence slot. */
export function resolveWakeEstimateTimeZone(morning: TemporalWakeupMorningConfig): string {
  return morning.timezone === 'utc' ? 'UTC' : resolveActiveTimezone();
}

/** Partner (role 'user') timestamps from recent session entries, bounded by the scan cap. */
export function partnerTimestampsFromEntries(entries: readonly SessionEntry[]): number[] {
  return entries
    .filter(entry => entry.role === 'user')
    .map(entry => entry.timestamp)
    .filter(ts => Number.isFinite(ts));
}

// ── Morning wake eligibility ──

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

  const lastActivity = latestConversationalEntry(input.recentEntries) ?? lastPartner;
  const channelIdleMs = Math.max(0, nowMs - lastActivity.timestamp);
  const partnerIdleMs = Math.max(0, nowMs - lastPartner.timestamp);
  // Recency guard, not a calendar-date guard: any participant activity right
  // now suppresses the note. A channel whose last exchange was overnight
  // (before the wake slot) is exactly where the new-day frame matters.
  if (channelIdleMs < Math.max(0, input.minPartnerIdleMs)) {
    return { allowed: false, reason: 'partner_recently_active', nowMs, sessionId };
  }
  const todayKey = temporalWakeupLocalDateKey(nowMs, timeZone);
  if (
    input.lastWakeupNoteAtMs !== undefined
    && Number.isFinite(input.lastWakeupNoteAtMs)
    && temporalWakeupLocalDateKey(input.lastWakeupNoteAtMs, timeZone) === todayKey
  ) {
    // A MORNING note already landed today (the runtime feeds morning-source
    // notes only) — the double-fire guard.
    return { allowed: false, reason: 'anti_loop_note_today', nowMs, sessionId };
  }

  const timeTexture = classifyIdleGapTexture({
    lastActivityAtMs: lastActivity.timestamp,
    observedAtMs: nowMs,
    timeZone,
  });

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
// The notes are context, not scripts: they establish the temporal frame
// without prescribing a greeting, feeling, or response. They must read as
// runtime speech, never partner speech.

const NOTE_ATTRIBUTION = 'Runtime context note; this is not a message from your partner.';

export interface MorningWakeNoteInput {
  nowMs: number;
  lastActivityAtMs: number;
  catchUpSummary?: string;
  timeZone?: string;
}

export function buildMorningWakeNote(input: MorningWakeNoteInput): string {
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const moment = describeLocalMoment(input.nowMs, timeZone);
  const elapsed = formatElapsedApprox(input.nowMs - input.lastActivityAtMs);
  const summary = input.catchUpSummary?.trim() ?? '';
  return [
    '[Temporal wake]',
    `A new day has started: it is now ${moment.weekday}, ${moment.date}, ${moment.time} (${timeZone}) — ${moment.partOfDay}.`,
    `Last exchange here: ${elapsed} ago.`,
    ...(summary
      ? [`${CATCH_UP_NOTE_PREFIX} ${summary}`]
      : []),
    NOTE_ATTRIBUTION,
  ].join('\n');
}

export interface TimeOfDayRefreshNoteInput {
  nowMs: number;
  lastActivityAtMs: number;
  catchUpSummary?: string;
  timeZone?: string;
}

export function buildTimeOfDayRefreshNote(input: TimeOfDayRefreshNoteInput): string {
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const moment = describeLocalMoment(input.nowMs, timeZone);
  const elapsed = formatElapsedApprox(input.nowMs - input.lastActivityAtMs);
  const summary = input.catchUpSummary?.trim() ?? '';
  return [
    '[Time-of-day refresher]',
    `Temporal frame update: it is now ${moment.weekday} ${moment.time} (${timeZone}) — ${moment.partOfDay}.`,
    `${elapsed} since the last exchange here; the conversation above is from earlier, not the present moment.`,
    ...(summary
      ? [`${CATCH_UP_NOTE_PREFIX} ${summary}`]
      : []),
    NOTE_ATTRIBUTION,
  ].join('\n');
}

// ── Runtime registration ──

export interface TemporalWakeupSessionManagerPort {
  resolveStartupSessionMetadata(behavior?: 'reuse_latest_session'): StartupSessionMetadata | null;
  /**
   * Recently-active conversational channels for wake-note fan-out (bead
   * psfn-framework-2x37.3): every channel with partner (role 'user') activity
   * within `lookbackMs`, most-recent-activity first. Wire to
   * SessionManager.listRecentlyActiveChannels. Optional for interface
   * tolerance; when absent the lanes fall back to the single latest session
   * (pre-fan-out behavior) so the module never assumes an enumeration surface
   * that a caller has not provided.
   */
  listRecentlyActiveChannels?(input: { lookbackMs: number; nowMs?: number }): StartupSessionMetadata[];
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  getRecentSessionEntries?(channelId: string, limit: number): SessionEntry[];
  /** Context-visible system-note lane; see SessionManager.appendContextSystemNote. */
  appendContextSystemNote(channelId: string, note: string, source?: string): void;
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
  /**
   * Typed notification of how the morning wake slot was resolved (E7.2). Fires
   * once at registration with the effective snapshot — 'fixed', a successful
   * 'habit' estimate, or a 'habit_fallback' to the fixed time with a reason.
   * Lets callers surface the decision (event bus, telemetry) without this
   * module depending on any bus.
   */
  onWakeTimingResolved?: (snapshot: WakeWindowSnapshot) => void;
}

function resolveWakeupChannelType(value: string | undefined): ChannelType {
  return value !== undefined && (CHANNEL_TYPES as readonly string[]).includes(value)
    ? value as ChannelType
    : 'api';
}

/**
 * Pull partner (role 'user') message timestamps for the habit estimator and
 * build the effective wake snapshot for the current timing mode. When the
 * session manager can enumerate recently-active channels the estimator sees a
 * cross-channel projection — every channel with partner activity inside
 * habit.extendedWindowDays, each scanned up to maxSamplesScanned entries — so a
 * low-traffic or api/PWA last-active channel no longer starves the estimate to
 * a habit_fallback (psfn-framework-7grh). Without enumeration it falls back to
 * the single latest session, never assuming a capability the caller did not
 * wire. In 'fixed' mode no history is read.
 *
 * Shared by daily-task registration and the Garden admin read route so both
 * see the same effective wake slot.
 */
export function resolveMorningWakeSnapshot(input: {
  sessionManager: TemporalWakeupSessionManagerPort;
  morning: TemporalWakeupMorningConfig;
  nowMs?: number;
}): WakeWindowSnapshot {
  const { sessionManager, morning } = input;
  const nowMs = input.nowMs ?? Date.now();
  const timeZone = resolveWakeEstimateTimeZone(morning);
  if (morning.timing !== 'habit') {
    return buildWakeWindowSnapshot({ morning, partnerTimestampsMs: [], nowMs, timeZone });
  }
  const scanLimit = Math.max(1, morning.habit.maxSamplesScanned);
  const partnerTimestampsMs: number[] = [];
  for (const sessionId of resolveHabitWakeChannelIds(sessionManager, morning, nowMs)) {
    const entries = sessionManager.getRecentSessionEntries
      ? sessionManager.getRecentSessionEntries(sessionId, scanLimit)
      : sessionManager.getRecentMessages(sessionId, scanLimit);
    for (const timestamp of partnerTimestampsFromEntries(entries)) {
      partnerTimestampsMs.push(timestamp);
    }
  }
  return buildWakeWindowSnapshot({ morning, partnerTimestampsMs, nowMs, timeZone });
}

// Channel types that are never a live conversational partner surface for
// autonomous wake fan-out: the local dev terminal, the internal subagent lane,
// and the inter-companion lane. Group chats/DMs (discord, telegram, api),
// satellites (voice/PWA, which infer to an undefined channelType), and
// companion-ui remain eligible.
const NON_LIVE_WAKEUP_CHANNEL_TYPES: ReadonlySet<string> = new Set([
  'terminal',
  'subagent',
  'companion',
]);

/**
 * Fail-closed gate for wake fan-out: a channel receives an autonomous wake note
 * only when it is an actively-used live conversational surface — an active group
 * chat, DM, or satellite. Testing/internal/public-broadcast sessions and
 * non-conversational channel types are excluded here (downstream eligibility
 * also rejects most of these; this keeps the fan-out set itself narrow so an
 * idle or non-live channel is never even considered).
 */
function isLiveWakeupFanoutChannel(channel: StartupSessionMetadata): boolean {
  const sessionId = channel.sessionId;
  if (!sessionId) return false;
  if (isTestingSessionId(sessionId)) return false;
  if (isInternalSessionId(sessionId)) return false;
  if (classifyChannelDisclosure(sessionId).channelPrivacy === 'public') return false;
  if (channel.channelType !== undefined && NON_LIVE_WAKEUP_CHANNEL_TYPES.has(channel.channelType)) {
    return false;
  }
  return true;
}

/**
 * Channels feeding the habit estimator: every recently-active live channel with
 * partner activity inside habit.extendedWindowDays. Bounded —
 * listRecentlyActiveChannels is last-activity sorted and stops at the lookback
 * edge. Falls back to the latest session alone when the enumeration surface is
 * not wired. The most-recent session is no longer force-added when it is idle
 * past the lookback window (psfn-framework-7toj): an inactive channel must not
 * feed the estimate.
 */
function resolveHabitWakeChannelIds(
  sessionManager: TemporalWakeupSessionManagerPort,
  morning: TemporalWakeupMorningConfig,
  nowMs: number,
): string[] {
  const latest = sessionManager.resolveStartupSessionMetadata('reuse_latest_session');
  if (!sessionManager.listRecentlyActiveChannels) {
    return latest && isLiveWakeupFanoutChannel(latest) ? [latest.sessionId] : [];
  }
  const lookbackMs = Math.max(0, morning.habit.extendedWindowDays) * 24 * HOUR_MS;
  const ids = new Set<string>();
  for (const channel of sessionManager.listRecentlyActiveChannels({ lookbackMs, nowMs })) {
    if (isLiveWakeupFanoutChannel(channel)) ids.add(channel.sessionId);
  }
  return [...ids];
}

interface ResolvedWakeupSessionContext {
  session: StartupSessionMetadata;
  recentEntries: SessionEntry[];
  persistedEntries: SessionEntry[];
  lastWakeupNoteAtMs?: number;
}

/**
 * Recently-active live channels the wake lanes fan out to (bead
 * psfn-framework-2x37.3, narrowed by psfn-framework-7toj). When the session
 * manager exposes enumeration, every actively-used live conversational channel
 * (group chat / DM / satellite) with partner activity inside
 * `activeChannelLookbackHours` is a candidate; per-channel eligibility
 * (idle/anti-loop) still gates each one downstream. The most-recent session is
 * NOT force-added when it is idle past the lookback window — fanning a wake note
 * to a channel with no recent partner activity is exactly the over-broad
 * behavior this lane must avoid (fail closed: when in doubt, exclude). Without
 * the enumeration surface the module falls back to the single latest session
 * (still gated as a live channel), so it never assumes a capability the caller
 * did not wire.
 */
function enumerateWakeupChannels(
  options: TemporalWakeupRuntimeOptions,
  nowMs: number,
): StartupSessionMetadata[] {
  const latest = options.sessionManager.resolveStartupSessionMetadata('reuse_latest_session');
  if (!options.sessionManager.listRecentlyActiveChannels) {
    return latest && isLiveWakeupFanoutChannel(latest) ? [latest] : [];
  }
  const lookbackMs = Math.max(0, options.config.activeChannelLookbackHours) * HOUR_MS;
  return options.sessionManager
    .listRecentlyActiveChannels({ lookbackMs, nowMs })
    .filter(isLiveWakeupFanoutChannel);
}

/**
 * Per-channel wake context: the recent entries the eligibility check reads plus
 * the anti-loop last-note timestamp for THAT channel (persisted-note scan +
 * in-memory map, both keyed by the channel's own sessionId).
 */
function resolveWakeupChannelContext(
  options: TemporalWakeupRuntimeOptions,
  inMemoryNoteBySession: Map<string, number>,
  channel: StartupSessionMetadata,
  recentLimit: number,
  noteSources: ReadonlySet<string> = WAKEUP_NOTE_SOURCES,
): ResolvedWakeupSessionContext {
  const sessionId = channel.sessionId;
  const recentEntries = options.sessionManager.getRecentMessages(sessionId, recentLimit);
  const persistedEntries = options.sessionManager.getRecentSessionEntries
    ? options.sessionManager.getRecentSessionEntries(sessionId, 64)
    : [];
  const persistedLastNoteAt = findLatestTemporalWakeupNoteAt(persistedEntries, noteSources);
  const inMemoryLastNoteAt = inMemoryNoteBySession.get(sessionId);
  const lastWakeupNoteAtMs = latestTemporalWakeupTimestamp(
    persistedLastNoteAt,
    inMemoryLastNoteAt,
  );
  return {
    session: channel,
    recentEntries,
    persistedEntries,
    ...(lastWakeupNoteAtMs !== undefined ? { lastWakeupNoteAtMs } : {}),
  };
}

async function buildCatchUpSummary(
  options: TemporalWakeupRuntimeOptions,
  channelId: string,
  recentEntries: readonly SessionEntry[],
): Promise<string> {
  if (!options.summarizeCatchUp) return '';
  const conversational = recentEntries.filter(
    entry => entry.role === 'user' || entry.role === 'assistant',
  );
  if (conversational.length === 0) return '';
  // Day-scope the catch-up (bead psfn-framework-2x37.5): the wake note should
  // summarize the LATEST chat day only, not an all-time last-N tail. Keep just
  // the entries sharing the local date of the most recent conversational entry,
  // then apply the count cap. Same active timezone the note builders render in.
  const timeZone = resolveActiveTimezone();
  const latestConversational = conversational.reduce(
    (latest, entry) => (entry.timestamp > latest.timestamp ? entry : latest),
  );
  const latestDayKey = temporalWakeupLocalDateKey(latestConversational.timestamp, timeZone);
  const sameDay = conversational
    .filter(entry => temporalWakeupLocalDateKey(entry.timestamp, timeZone) === latestDayKey)
    .slice(-Math.max(1, options.config.morningWake.catchUpEntryLimit));
  if (sameDay.length === 0) return '';
  try {
    return (await options.summarizeCatchUp({ channelId, entries: sameDay })).trim();
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

  // Anti-loop state is lane-specific. An overnight refresher must not suppress
  // the morning summary, and a morning note must not reset the
  // refresher lane's own interval.
  const morningNoteBySession = new Map<string, number>();
  const refresherNoteBySession = new Map<string, number>();
  const refresherCatchUpNoteBySession = new Map<string, number>();
  const morning = options.config.morningWake;
  const refresher = options.config.idleRefresher;

  if (morning.enabled) {
    // Resolve the daily wake slot for the configured timing mode. In 'habit'
    // mode this reads the partner's own message-timestamp history (via the
    // cheapest existing session surface) and fires at the deterministic
    // weighted-median wake time; insufficient history falls back to the fixed
    // localTime with a visible reason. The estimate is resolved once here (at
    // registration / process start); the Garden admin route recomputes it live
    // so operators see habit drift before the next restart applies it.
    const registrationSnapshot = resolveMorningWakeSnapshot({
      sessionManager: options.sessionManager,
      morning,
    });
    const { hour, minute } = registrationSnapshot.effective;
    if (options.onWakeTimingResolved) {
      options.onWakeTimingResolved(registrationSnapshot);
    }
    log.info('Morning wake timing resolved', {
      timingMode: registrationSnapshot.timingMode,
      source: registrationSnapshot.source,
      effectiveLocalTime: registrationSnapshot.effective.localTime,
      timeZone: registrationSnapshot.timeZone,
      sampleDays: registrationSnapshot.sampleDays,
      ...(registrationSnapshot.fallbackReason
        ? { fallbackReason: registrationSnapshot.fallbackReason }
        : {}),
      ...(registrationSnapshot.window
        ? { window: `${registrationSnapshot.window.startLocalTime}-${registrationSnapshot.window.endLocalTime}` }
        : {}),
    });
    options.scheduler.register({
      id: TEMPORAL_WAKEUP_MORNING_TASK_ID,
      name: TEMPORAL_WAKEUP_MORNING_TASK_NAME,
      type: 'every',
      intervalMs: 24 * HOUR_MS,
      cadence: { kind: 'daily', hour, minute, timezone: morning.timezone },
      handler: async () => {
        // Fan the internal new-day frame out to EVERY recently-active channel
        // (bead psfn-framework-2x37.3), each gated by its own eligibility +
        // anti-loop state. Outward delivery stays single-target (below) to
        // avoid multi-channel proactive spam.
        const channels = enumerateWakeupChannels(options, Date.now());
        const eligible: Array<{
          decision: Extract<MorningWakeDecision, { allowed: true }>;
          note: string;
          channelType: ChannelType;
        }> = [];

        for (const channel of channels) {
          const inMemoryLastNoteAt = morningNoteBySession.get(channel.sessionId);
          const preflightDecision = evaluateMorningWakePreflight({
            session: channel,
            fullTurnMaxIdleMs: morning.fullTurnMaxIdleHours * HOUR_MS,
            minPartnerIdleMs: morning.minPartnerIdleMinutes * MINUTE_MS,
            nowMs: Date.now(),
            evaluateEligibility: evaluateMorningWakeEligibility,
            ...(inMemoryLastNoteAt !== undefined
              ? { lastWakeupNoteAtMs: inMemoryLastNoteAt }
              : {}),
          });
          if (preflightDecision) {
            log.info('Morning wake skipped', {
              reason: preflightDecision.reason,
              sessionId: preflightDecision.sessionId,
            });
            continue;
          }
          const context = resolveWakeupChannelContext(
            options,
            morningNoteBySession,
            channel,
            Math.max(morning.catchUpEntryLimit, 8),
            MORNING_WAKEUP_NOTE_SOURCES,
          );
          const decision = evaluateMorningWakeEligibility({
            session: context.session,
            recentEntries: context.recentEntries,
            fullTurnMaxIdleMs: morning.fullTurnMaxIdleHours * HOUR_MS,
            minPartnerIdleMs: morning.minPartnerIdleMinutes * MINUTE_MS,
            ...(context.lastWakeupNoteAtMs !== undefined
              ? { lastWakeupNoteAtMs: context.lastWakeupNoteAtMs }
              : {}),
          });
          if (!decision.allowed) {
            // Fires at most once per day; log at info so a skipped morning wake
            // is visible without turning on debug.
            log.info('Morning wake skipped', {
              reason: decision.reason,
              sessionId: decision.sessionId,
            });
            continue;
          }

          const timeZone = resolveActiveTimezone();
          const refresherAlreadyDeliveredCatchUpToday =
            didTemporalWakeupNoteWithContentLandOnLocalDate({
              persistedEntries: context.persistedEntries,
              sources: REFRESHER_WAKEUP_NOTE_SOURCES,
              contentMarker: CATCH_UP_NOTE_PREFIX,
              inMemoryNoteAtMs: refresherCatchUpNoteBySession.get(decision.sessionId),
              observedAtMs: decision.nowMs,
              timeZone,
            });
          // Keep the morning frame after a post-midnight refresher. Reuse the
          // fresh state by omitting only catch-up content that actually landed.
          const catchUpSummary = refresherAlreadyDeliveredCatchUpToday
            ? ''
            : await buildCatchUpSummary(
              options,
              decision.sessionId,
              context.recentEntries,
            );
          const note = buildMorningWakeNote({
            nowMs: decision.nowMs,
            lastActivityAtMs: decision.lastActivityAtMs,
            ...(catchUpSummary ? { catchUpSummary } : {}),
          });

          // Internal frame update FIRST — outward delivery failures must never
          // undo or block it.
          options.sessionManager.appendContextSystemNote(
            decision.sessionId,
            note,
            TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
          );
          morningNoteBySession.set(decision.sessionId, decision.nowMs);
          log.info('Morning wake note injected', {
            sessionId: decision.sessionId,
            texture: decision.timeTexture.kind,
            invokeFullTurn: decision.invokeFullTurn,
            hasCatchUpSummary: Boolean(catchUpSummary),
          });

          eligible.push({
            decision,
            note,
            channelType: resolveWakeupChannelType(channel.channelType),
          });
        }

        if (eligible.length === 0) return;

        // Single outward target: the channel with the most recent partner
        // activity. Only the internal frame notes fan out; proactive outbound
        // stays one-target so a multi-channel wake never spams every surface.
        const outwardTarget = eligible.reduce((best, candidate) =>
          candidate.decision.lastPartnerActivityAtMs > best.decision.lastPartnerActivityAtMs
            ? candidate
            : best,
        );
        try {
          await runOutwardPhase(
            options,
            outwardTarget.decision,
            outwardTarget.channelType,
            outwardTarget.note,
          );
        } catch (error) {
          log.error('Morning wake outward phase failed; internal frame update stands', {
            sessionId: outwardTarget.decision.sessionId,
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
        // Fan the time-of-day refresh out to every recently-active channel
        // (bead psfn-framework-2x37.3); each channel keeps its own idle guard
        // and anti-loop spacing. No outward delivery on this lane.
        const channels = enumerateWakeupChannels(options, Date.now());
        for (const channel of channels) {
          const inMemoryLastNoteAt = refresherNoteBySession.get(channel.sessionId);
          const preflightDecision = evaluateIdleRefresherPreflight({
            session: channel,
            minIdleMs: refresher.minIdleMinutes * MINUTE_MS,
            minNoteIntervalMs: refresher.minNoteIntervalMinutes * MINUTE_MS,
            nowMs: Date.now(),
            evaluateEligibility: evaluateIdleRefresherEligibility,
            ...(inMemoryLastNoteAt !== undefined
              ? { lastWakeupNoteAtMs: inMemoryLastNoteAt }
              : {}),
          });
          if (preflightDecision) {
            log.debug('Idle refresher skipped', {
              reason: preflightDecision.reason,
              sessionId: preflightDecision.sessionId,
              idleGapMs: preflightDecision.idleGapMs,
            });
            continue;
          }
          const context = resolveWakeupChannelContext(
            options,
            refresherNoteBySession,
            channel,
            32,
            REFRESHER_WAKEUP_NOTE_SOURCES,
          );
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
            continue;
          }

          const catchUpSummary = await buildCatchUpSummary(
            options,
            decision.sessionId,
            context.recentEntries,
          );
          let note: string;
          if (decision.kind === 'new_day') {
            // Overnight/multi-day texture: full new-day framing, including the
            // shared catch-up summary when available.
            note = buildMorningWakeNote({
              nowMs: decision.nowMs,
              lastActivityAtMs: decision.lastActivityAtMs,
              ...(catchUpSummary ? { catchUpSummary } : {}),
            });
          } else {
            note = buildTimeOfDayRefreshNote({
              nowMs: decision.nowMs,
              lastActivityAtMs: decision.lastActivityAtMs,
              ...(catchUpSummary ? { catchUpSummary } : {}),
            });
          }

          options.sessionManager.appendContextSystemNote(
            decision.sessionId,
            note,
            TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
          );
          refresherNoteBySession.set(decision.sessionId, decision.nowMs);
          if (catchUpSummary) {
            refresherCatchUpNoteBySession.set(decision.sessionId, decision.nowMs);
          }
          log.info('Idle time-of-day refresher note injected', {
            sessionId: decision.sessionId,
            kind: decision.kind,
            texture: decision.timeTexture.kind,
            idleGapMs: decision.idleGapMs,
          });
        }
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
  }

  log.info('Temporal wake-up lanes registered', {
    morningEnabled: morning.enabled,
    morningLocalTime: morning.localTime,
    refresherEnabled: refresher.enabled,
    refresherMinIdleMinutes: refresher.minIdleMinutes,
  });
}
