import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import { classifyChannel } from '../../system/trust/policy.js';
import type { StartupSessionMetadata } from '../session/manager.js';
import { isInternalSessionId } from '../session/session-id.js';
import type { SessionEntry } from '../session/types.js';
import { evaluateRestWindowEligibility } from './rest-window.js';
import type { Scheduler } from './scheduler.js';
import { classifyIdleGapTexture, type IdleGapTexture } from './time-texture.js';

const log = createComponentLogger('AmbientPresence');

export const AMBIENT_PRESENCE_TASK_ID = 'ambient-presence';
export const AMBIENT_PRESENCE_TASK_NAME = 'Ambient Presence';
export const DEFAULT_AMBIENT_PRESENCE_TASK_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_AMBIENT_PRESENCE_MIN_IDLE_MS = 3 * 60 * 60_000;
export const DEFAULT_AMBIENT_PRESENCE_MIN_NOTE_INTERVAL_MS = 6 * 60 * 60_000;
const AMBIENT_PRESENCE_NOTE_SOURCE = 'ambient_presence';

export type AmbientPresenceDecisionReason =
  | 'eligible'
  | 'no_recent_session'
  | 'internal_session'
  | 'privacy_boundary'
  | 'no_conversational_activity'
  | 'below_idle_threshold'
  | 'outside_rest_window'
  | 'insufficient_inactivity'
  | 'anti_loop_recent_note';

export type AmbientPresenceDecision =
  | {
    allowed: true;
    reason: 'eligible';
    nowMs: number;
    sessionId: string;
    idleGapMs: number;
    lastActivityAtMs: number;
    lastUserActivityAtMs?: number;
    timeTexture: IdleGapTexture;
  }
  | {
    allowed: false;
    reason: Exclude<AmbientPresenceDecisionReason, 'eligible'>;
    nowMs: number;
    sessionId?: string;
    idleGapMs?: number;
    lastActivityAtMs?: number;
    lastUserActivityAtMs?: number;
    timeTexture?: IdleGapTexture;
    nextEligibleAtMs?: number;
  };

export interface AmbientPresenceEvaluateInput {
  session: StartupSessionMetadata | null;
  recentEntries: readonly SessionEntry[];
  restWindow?: EpisodicProcessingRestWindowConfig;
  nowMs?: number;
  minIdleMs?: number;
  minNoteIntervalMs?: number;
  lastAmbientNoteAtMs?: number;
}

export interface AmbientPresenceSessionManagerPort {
  resolveStartupSessionMetadata(behavior?: 'reuse_latest_session'): StartupSessionMetadata | null;
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  getRecentSessionEntries?(channelId: string, limit: number): SessionEntry[];
  appendSystemNote(channelId: string, note: string, source?: string): void;
}

export interface AmbientPresenceRuntimeOptions {
  scheduler: Scheduler;
  sessionManager: AmbientPresenceSessionManagerPort;
  restWindow?: EpisodicProcessingRestWindowConfig;
  eventBus?: EventBus;
  intervalMs?: number;
  minIdleMs?: number;
  minNoteIntervalMs?: number;
}

function latestEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
  return [...entries]
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);
}

function latestUserEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
  return [...entries]
    .filter(entry => entry.role === 'user')
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);
}

function parseAmbientNoteTimestamp(entry: SessionEntry): number | null {
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
  return source === AMBIENT_PRESENCE_NOTE_SOURCE ? entry.timestamp : null;
}

export function findLatestAmbientPresenceNoteAt(entries: readonly SessionEntry[]): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    const timestamp = parseAmbientNoteTimestamp(entry);
    if (timestamp === null) continue;
    latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}

export function evaluateAmbientPresenceEligibility(
  input: AmbientPresenceEvaluateInput,
): AmbientPresenceDecision {
  const nowMs = Math.max(0, Math.floor(input.nowMs ?? Date.now()));
  const minIdleMs = Math.max(0, Math.floor(input.minIdleMs ?? DEFAULT_AMBIENT_PRESENCE_MIN_IDLE_MS));
  const minNoteIntervalMs = Math.max(
    0,
    Math.floor(input.minNoteIntervalMs ?? DEFAULT_AMBIENT_PRESENCE_MIN_NOTE_INTERVAL_MS),
  );
  const sessionId = input.session?.sessionId;

  if (!sessionId) {
    return { allowed: false, reason: 'no_recent_session', nowMs };
  }
  if (isInternalSessionId(sessionId)) {
    return { allowed: false, reason: 'internal_session', nowMs, sessionId };
  }

  const visibility = classifyChannel(sessionId);
  if (visibility === 'public' || visibility === 'broadcast') {
    return { allowed: false, reason: 'privacy_boundary', nowMs, sessionId };
  }

  const lastActivity = latestEntry(input.recentEntries);
  if (!lastActivity) {
    return { allowed: false, reason: 'no_conversational_activity', nowMs, sessionId };
  }
  const lastUserActivity = latestUserEntry(input.recentEntries);
  const lastActivityAtMs = lastActivity.timestamp;
  const lastUserActivityAtMs = lastUserActivity?.timestamp;
  const idleGapMs = Math.max(0, nowMs - lastActivityAtMs);
  const timeTexture = classifyIdleGapTexture({
    lastActivityAtMs,
    observedAtMs: nowMs,
  });

  if (idleGapMs < minIdleMs) {
    return {
      allowed: false,
      reason: 'below_idle_threshold',
      nowMs,
      sessionId,
      idleGapMs,
      lastActivityAtMs,
      lastUserActivityAtMs,
      timeTexture,
    };
  }

  if (input.restWindow) {
    const restWindowDecision = evaluateRestWindowEligibility({
      config: input.restWindow,
      nowMs,
      lastUserActivityAtMs,
    });
    if (!restWindowDecision.allowed) {
      return {
        allowed: false,
        reason: restWindowDecision.reasonCode ?? 'outside_rest_window',
        nowMs,
        sessionId,
        idleGapMs,
        lastActivityAtMs,
        lastUserActivityAtMs,
        timeTexture,
        nextEligibleAtMs: restWindowDecision.nextEligibleAtMs,
      };
    }
  }

  if (
    input.lastAmbientNoteAtMs !== undefined
    && Number.isFinite(input.lastAmbientNoteAtMs)
    && nowMs - input.lastAmbientNoteAtMs < minNoteIntervalMs
  ) {
    return {
      allowed: false,
      reason: 'anti_loop_recent_note',
      nowMs,
      sessionId,
      idleGapMs,
      lastActivityAtMs,
      lastUserActivityAtMs,
      timeTexture,
    };
  }

  return {
    allowed: true,
    reason: 'eligible',
    nowMs,
    sessionId,
    idleGapMs,
    lastActivityAtMs,
    lastUserActivityAtMs,
    timeTexture,
  };
}

export function buildAmbientPresenceNote(decision: Extract<AmbientPresenceDecision, { allowed: true }>): string {
  return [
    '[Ambient presence]',
    `Quiet-time eligibility reached for ${decision.sessionId}.`,
    `Time texture: ${decision.timeTexture.label} (${decision.timeTexture.kind}).`,
    `Idle gap: ${Math.floor(decision.idleGapMs / 60_000)} minutes.`,
    `Reconnection warmth signal: ${decision.timeTexture.reconnectionWarmth}; ${decision.timeTexture.guidance}`,
    'No outbound message was sent and no LLM call was made.',
  ].join('\n');
}

export function registerAmbientPresenceTask(options: AmbientPresenceRuntimeOptions): void {
  const lastRecordedBySession = new Map<string, number>();
  const intervalMs = Math.max(
    1_000,
    Math.floor(options.intervalMs ?? DEFAULT_AMBIENT_PRESENCE_TASK_INTERVAL_MS),
  );

  options.scheduler.register({
    id: AMBIENT_PRESENCE_TASK_ID,
    name: AMBIENT_PRESENCE_TASK_NAME,
    type: 'every',
    intervalMs,
    handler: async () => {
      const session = options.sessionManager.resolveStartupSessionMetadata('reuse_latest_session');
      const sessionId = session?.sessionId;
      const recentEntries = sessionId
        ? options.sessionManager.getRecentMessages(sessionId, 8)
        : [];
      const persistedEntries = sessionId && options.sessionManager.getRecentSessionEntries
        ? options.sessionManager.getRecentSessionEntries(sessionId, 32)
        : [];
      const persistedLastNoteAt = findLatestAmbientPresenceNoteAt(persistedEntries);
      const inMemoryLastNoteAt = sessionId ? lastRecordedBySession.get(sessionId) : undefined;
      const lastAmbientNoteAtMs = Math.max(
        persistedLastNoteAt ?? 0,
        inMemoryLastNoteAt ?? 0,
      ) || undefined;
      const decision = evaluateAmbientPresenceEligibility({
        session,
        recentEntries,
        restWindow: options.restWindow,
        minIdleMs: options.minIdleMs,
        minNoteIntervalMs: options.minNoteIntervalMs,
        lastAmbientNoteAtMs,
      });

      if (!decision.allowed) {
        log.debug('Ambient presence skipped', {
          reason: decision.reason,
          sessionId: decision.sessionId,
          idleGapMs: decision.idleGapMs,
          nextEligibleAtMs: decision.nextEligibleAtMs,
        });
        return;
      }

      options.sessionManager.appendSystemNote(
        decision.sessionId,
        buildAmbientPresenceNote(decision),
        AMBIENT_PRESENCE_NOTE_SOURCE,
      );
      lastRecordedBySession.set(decision.sessionId, decision.nowMs);
    },
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  }, { skipFirstRun: true });
}
