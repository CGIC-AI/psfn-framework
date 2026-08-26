// ── Temporal wake-up lanes (E7.1) ──
// Two complementary paths move the companion's temporal frame forward:
//
//   1. Scheduled morning wake — a daily wall-clock task (default 08:00 local)
//      that may invoke one response turn for a warm private channel, then
//      persists the new-day note only as proof of that model delivery: current
//      date/time, elapsed time since the last channel exchange, and a
//      catch-up summary produced by the SHARED session summarization service
//      (summarizeRecentSessionEntries — injected as a port; no bespoke
//      summarizer here).
//   2. Active-turn temporal frame — after a configured idle gap, the session
//      context derives one fresh ephemeral frame when the channel next invokes
//      the model. Idle clock changes are never queued or persisted.
//
// Message-ontology invariants (charter 6.17, 8.1-8.2, law 19):
// - A morning note is persisted only after an actual wake model turn completes.
//   Active-turn frames are prompt-only context and never session rows.
// - Wake notes are refreshers, not partner activity: elapsed-time and
//   ambient-presence idle accounting derive from user/assistant entries only,
//   so system-role notes never reset them.
// - Any outward message rides the EXISTING proactive-outbound dispatcher and
//   quiet-hours time gate. A policy block cannot erase the already-completed
//   model delivery that authorized persistence of its morning frame.
//
// Spend posture: the active-turn frame is deterministic and adds no LLM call.
// The morning lane invokes at most one full response turn, and only when the
// last partner exchange is recent enough (morningWake.fullTurnMaxIdleHours).
// Dormant sessions receive no scheduler write or model call.

import { createComponentLogger } from '../../shared/logger.js';
import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';
import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';
import { supportsLiveWakeup } from '../../shared/contracts/channel-types.js';
import type { TemporalWakeupConfig } from '../../system/config/scheduler-config.js';
import { classifyChannelDisclosure } from '../../system/trust/policy.js';
import {
  evaluateProactiveOutboundTimeGate,
  type ProactiveQuietHoursConfig,
} from '../intention/proactive-time-gate.js';
import type { ProactiveOutboundDispatchResult } from '../intention/proactive-outbound.js';
import type { StartupSessionMetadata } from '../session/manager.js';
import { isInternalSessionId, isTestingSessionId } from '../session/session-id.js';
import {
  TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
  TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE,
} from '../session/session-lane-metadata.js';
import type { SessionEntry } from '../session/types.js';
import type { Scheduler } from './scheduler.js';
import {
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
  if (
    input.lastWakeupNoteAtMs !== undefined
    && Number.isFinite(input.lastWakeupNoteAtMs)
    && lastActivity.timestamp <= input.lastWakeupNoteAtMs
  ) {
    // A calendar change is not channel activation. Once a delivered morning
    // frame has been persisted, the channel must see a new real user/assistant
    // entry before another autonomous morning turn can add a durable row.
    return { allowed: false, reason: 'no_activation_since_wake', nowMs, sessionId };
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
// runtime speech, never Participant speech.

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
   * Recently-active conversational channels for wake-note fan-out (bead 2x37.3):
   * every channel with partner (role 'user') activity within `lookbackMs`,
   * most-recent-activity first. Wire to
   * SessionManager.listRecentlyActiveChannels. Optional for interface
   * tolerance; when absent the lanes fall back to the single latest session
   * (pre-fan-out behavior) so the module never assumes an enumeration surface
   * that a caller has not provided.
   *
   * Decision (bead 2x37.9 item 2): kept optional, matching the
   * `getRecentSessionEntries?` capability-not-assumed idiom used throughout this
   * port. Production always wires it (src/app/agent/main.ts); the fail-closed
   * single-latest-session fallback is a deliberate contract, not an accident.
   * Making it required would churn every test fake for no runtime benefit and
   * remove the graceful-degradation guarantee, so we decline that change.
   */
  listRecentlyActiveChannels?(input: { lookbackMs: number; nowMs?: number }): StartupSessionMetadata[];
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  getRecentSessionEntries?(channelId: string, limit: number): SessionEntry[];
  /** Context-visible system-note lane; see SessionManager.appendContextSystemNote. */
  appendContextSystemNote(channelId: string, note: string, source?: string): void;
  /** Configure the latest-only ephemeral frame derived on a real channel turn. */
  configureActiveTemporalFrame?(config: { enabled: boolean; minIdleMs: number }): void;
}

export type TemporalWakeupOutboundResult = ProactiveOutboundDispatchResult;

export interface TemporalWakeupRuntimeOptions {
  scheduler: Scheduler;
  sessionManager: TemporalWakeupSessionManagerPort;
  config: TemporalWakeupConfig;
  /** Quiet hours for outward delivery after the wake model turn. */
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
  /**
   * Per-recipient timezone resolver for the outward-delivery quiet-hours gate
   * (bead 2tli). Called with the wake channel's sessionId; wire to the
   * contact bound to that channel so quiet hours evaluate in the recipient's
   * local time. Optional; when absent or returning null the gate falls back to
   * the global window's zone.
   */
  resolveContactTimeZone?: (channelId: string) => Promise<string | null>;
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
  if (!supportsLiveWakeup(channel.channelType)) return false;
  return true;
}

/**
 * Channels feeding the habit estimator: every recently-active live channel with
 * partner activity inside habit.extendedWindowDays. Bounded —
 * listRecentlyActiveChannels is last-activity sorted and stops at the lookback
 * edge. Falls back to the latest session alone when the enumeration surface is
 * not wired. The most-recent session is no longer force-added when it is idle
 * past the lookback window (bead 7toj): an inactive channel must not
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
 * psfn-framework-2x37.3, narrowed by bead 7toj). When the session
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

interface EligibleWakeupChannel<TAllowed> {
  channel: StartupSessionMetadata;
  context: ResolvedWakeupSessionContext;
  decision: TAllowed;
}

/**
 * Shared per-channel fan-out pipeline for both wake lanes (bead 2x37.9 item 1).
 * Enumerates recently-active live channels, then for each runs the lane's
 * metadata preflight, resolves its per-channel context (recent entries +
 * anti-loop last-note timestamp), and evaluates the lane's real eligibility.
 * Denials from either phase are surfaced through `onSkip` (lane-specific
 * logging) and dropped; the survivors — with their resolved context and
 * allowed decision — are returned for the lane's own note-building/append work.
 * Extracting this removes the ~40-line per-channel shape that the morning and
 * refresher handlers previously duplicated.
 */
function collectEligibleWakeupChannels<TDecision extends { allowed: boolean }>(params: {
  options: TemporalWakeupRuntimeOptions;
  nowMs: number;
  inMemoryNoteBySession: Map<string, number>;
  noteSources: ReadonlySet<string>;
  recentLimit: number;
  runPreflight: (
    channel: StartupSessionMetadata,
    inMemoryLastNoteAt: number | undefined,
  ) => TDecision | null;
  evaluate: (context: ResolvedWakeupSessionContext) => TDecision;
  onSkip: (denial: Extract<TDecision, { allowed: false }>) => void;
}): Array<EligibleWakeupChannel<Extract<TDecision, { allowed: true }>>> {
  const eligible: Array<EligibleWakeupChannel<Extract<TDecision, { allowed: true }>>> = [];
  for (const channel of enumerateWakeupChannels(params.options, params.nowMs)) {
    const inMemoryLastNoteAt = params.inMemoryNoteBySession.get(channel.sessionId);
    // Preflight returns denials only (its documented contract); a non-null
    // result is always a terminal skip for this channel.
    const preflightDenial = params.runPreflight(channel, inMemoryLastNoteAt);
    if (preflightDenial) {
      params.onSkip(preflightDenial as Extract<TDecision, { allowed: false }>);
      continue;
    }
    const context = resolveWakeupChannelContext(
      params.options,
      params.inMemoryNoteBySession,
      channel,
      params.recentLimit,
      params.noteSources,
    );
    const decision = params.evaluate(context);
    if (!decision.allowed) {
      params.onSkip(decision as Extract<TDecision, { allowed: false }>);
      continue;
    }
    eligible.push({ channel, context, decision: decision as Extract<TDecision, { allowed: true }> });
  }
  return eligible;
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
  onWakeTurnDelivered: () => void,
): Promise<void> {
  if (!decision.invokeFullTurn || !options.invokeWakeTurn) {
    log.debug('Morning wake: no model turn, so no frame is persisted', {
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
  onWakeTurnDelivered();
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
  // has already landed regardless of this decision. Evaluate quiet hours in the
  // recipient's timezone when resolvable (2tli); fall back to the global window.
  const contactTimeZone = options.resolveContactTimeZone
    ? await options.resolveContactTimeZone(decision.sessionId)
    : null;
  const timeGate = evaluateProactiveOutboundTimeGate({
    nowMs: decision.nowMs,
    quietHours: options.quietHours ?? null,
    contactTimeZone,
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
    if (dispatchResult.reason === 'channel_not_approved_for_primary') {
      throw new Error(
        `Temporal wake proactive outbound refused: ${dispatchResult.reason}. `
        + `Refused channel: ${decision.sessionId}. `
        + 'Remedy: set channels.json.discord.heartbeatChannelId (or the companion account '
        + 'heartbeatChannelId) to this channel only if it is the approved primary private DM; '
        + 'otherwise keep the channel gated.',
      );
    }
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
  const morning = options.config.morningWake;
  const refresher = options.config.idleRefresher;
  options.sessionManager.configureActiveTemporalFrame?.({
    enabled: options.config.enabled && refresher.enabled,
    minIdleMs: refresher.minIdleMinutes * MINUTE_MS,
  });
  if (!options.config.enabled) {
    log.info('Temporal wake-up lanes disabled by scheduler.json temporalWakeup.enabled');
    return;
  }

  // Anti-loop state is lane-specific. An overnight refresher must not suppress
  // the morning summary, and a morning note must not reset the
  // refresher lane's own interval.
  const morningNoteBySession = new Map<string, number>();
  let morningFrameDateKey: string | undefined;

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
        // (bead 2x37.3), each gated by its own eligibility + anti-loop state via
        // the shared fan-out pipeline (bead 2x37.9 item 1). Outward delivery
        // stays single-target (below) to avoid multi-channel proactive spam.
        const nowMs = Date.now();
        const timeZone = resolveActiveTimezone();
        const currentFrameDateKey = temporalWakeupLocalDateKey(nowMs, timeZone);
        if (morningFrameDateKey === currentFrameDateKey) return;
        if (options.sessionManager.getRecentSessionEntries) {
          for (const channel of enumerateWakeupChannels(options, nowMs)) {
            const inMemoryLastNoteAt = morningNoteBySession.get(channel.sessionId);
            const preflightDenial = evaluateMorningWakePreflight({
              session: channel,
              fullTurnMaxIdleMs: morning.fullTurnMaxIdleHours * HOUR_MS,
              minPartnerIdleMs: morning.minPartnerIdleMinutes * MINUTE_MS,
              nowMs,
              evaluateEligibility: evaluateMorningWakeEligibility,
              ...(inMemoryLastNoteAt !== undefined
                ? { lastWakeupNoteAtMs: inMemoryLastNoteAt }
                : {}),
            });
            if (preflightDenial) continue;
            const persistedMorningAt = findLatestTemporalWakeupNoteAt(
              options.sessionManager.getRecentSessionEntries(channel.sessionId, 64),
              MORNING_WAKEUP_NOTE_SOURCES,
            );
            if (
              persistedMorningAt !== undefined
              && temporalWakeupLocalDateKey(persistedMorningAt, timeZone) === currentFrameDateKey
            ) {
              morningFrameDateKey = currentFrameDateKey;
              return;
            }
          }
        }
        const eligibleChannels = collectEligibleWakeupChannels<MorningWakeDecision>({
          options,
          nowMs,
          inMemoryNoteBySession: morningNoteBySession,
          noteSources: MORNING_WAKEUP_NOTE_SOURCES,
          recentLimit: Math.max(morning.catchUpEntryLimit, 8),
          runPreflight: (channel, inMemoryLastNoteAt) =>
            evaluateMorningWakePreflight({
              session: channel,
              fullTurnMaxIdleMs: morning.fullTurnMaxIdleHours * HOUR_MS,
              minPartnerIdleMs: morning.minPartnerIdleMinutes * MINUTE_MS,
              nowMs,
              evaluateEligibility: evaluateMorningWakeEligibility,
              ...(inMemoryLastNoteAt !== undefined
                ? { lastWakeupNoteAtMs: inMemoryLastNoteAt }
                : {}),
            }),
          evaluate: (context) =>
            evaluateMorningWakeEligibility({
              session: context.session,
              recentEntries: context.recentEntries,
              fullTurnMaxIdleMs: morning.fullTurnMaxIdleHours * HOUR_MS,
              minPartnerIdleMs: morning.minPartnerIdleMinutes * MINUTE_MS,
              ...(context.lastWakeupNoteAtMs !== undefined
                ? { lastWakeupNoteAtMs: context.lastWakeupNoteAtMs }
                : {}),
            }),
          // Fires at most once per day; log at info so a skipped morning wake is
          // visible without turning on debug.
          onSkip: (denial) => {
            log.info('Morning wake skipped', {
              reason: denial.reason,
              sessionId: denial.sessionId,
            });
          },
        });

        const turnCandidates = eligibleChannels.filter(
          candidate => candidate.decision.invokeFullTurn && options.invokeWakeTurn,
        );
        if (turnCandidates.length === 0) {
          log.debug('Morning wake: no active model-turn candidate; no frame persisted');
          return;
        }

        // A durable wake note is proof of an actual model delivery, so choose
        // the one outward target before summaries, note construction, or any
        // append. Other eligible channels get their fresh ephemeral frame when
        // they next become active; idle scheduler ticks never fan rows out.
        const outwardTarget = turnCandidates.reduce((best, candidate) =>
          candidate.decision.lastPartnerActivityAtMs > best.decision.lastPartnerActivityAtMs
            ? candidate
            : best,
        );
        const refresherAlreadyDeliveredCatchUpToday =
          didTemporalWakeupNoteWithContentLandOnLocalDate({
            persistedEntries: outwardTarget.context.persistedEntries,
            sources: REFRESHER_WAKEUP_NOTE_SOURCES,
            contentMarker: CATCH_UP_NOTE_PREFIX,
            observedAtMs: outwardTarget.decision.nowMs,
            timeZone,
          });
        const catchUpSummary = refresherAlreadyDeliveredCatchUpToday
          ? ''
          : await buildCatchUpSummary(
            options,
            outwardTarget.decision.sessionId,
            outwardTarget.context.recentEntries,
          );
        const note = buildMorningWakeNote({
          nowMs: outwardTarget.decision.nowMs,
          lastActivityAtMs: outwardTarget.decision.lastActivityAtMs,
          ...(catchUpSummary ? { catchUpSummary } : {}),
        });
        const channelType = resolveWakeupChannelType(outwardTarget.channel.channelType);
        try {
          await runOutwardPhase(
            options,
            outwardTarget.decision,
            channelType,
            note,
            () => {
              options.sessionManager.appendContextSystemNote(
                outwardTarget.decision.sessionId,
                note,
                TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE,
              );
              morningNoteBySession.set(
                outwardTarget.decision.sessionId,
                outwardTarget.decision.nowMs,
              );
              morningFrameDateKey = currentFrameDateKey;
              log.info('Morning wake note persisted after model delivery', {
                sessionId: outwardTarget.decision.sessionId,
                texture: outwardTarget.decision.timeTexture.kind,
                hasCatchUpSummary: Boolean(catchUpSummary),
              });
            },
          );
        } catch (error) {
          log.error('Morning wake model/outward phase failed', {
            sessionId: outwardTarget.decision.sessionId,
            error: String(error),
          });
          throw error;
        }
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
  }

  log.info('Temporal wake-up lanes registered', {
    morningEnabled: morning.enabled,
    morningLocalTime: morning.localTime,
    activeTurnFrameEnabled: refresher.enabled,
    activeTurnFrameMinIdleMinutes: refresher.minIdleMinutes,
  });
}
