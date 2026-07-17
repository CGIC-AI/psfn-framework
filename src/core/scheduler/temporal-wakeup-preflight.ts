import type { StartupSessionMetadata } from '../session/manager.js';
import type { SessionEntry } from '../session/types.js';
import {
  conversationalEntryFromSessionMetadata,
  latestSessionActivityAtOrBefore,
} from './session-metadata-preflight.js';
import type {
  IdleRefresherDecision,
  IdleRefresherEvaluateInput,
  MorningWakeDecision,
  MorningWakeEvaluateInput,
} from './temporal-wakeup-contracts.js';

// These preflights return denials only. Any metadata state that cannot prove
// the pure evaluator's ordered reason falls through to the real entry reads.

export function evaluateMorningWakePreflight(input: {
  session: StartupSessionMetadata;
  fullTurnMaxIdleMs: number;
  minPartnerIdleMs: number;
  nowMs: number;
  lastWakeupNoteAtMs?: number;
  evaluateEligibility: (input: MorningWakeEvaluateInput) => MorningWakeDecision;
}): MorningWakeDecision | null {
  const evaluate = (recentEntries: readonly SessionEntry[]): MorningWakeDecision =>
    input.evaluateEligibility({
      session: input.session,
      recentEntries,
      fullTurnMaxIdleMs: input.fullTurnMaxIdleMs,
      minPartnerIdleMs: input.minPartnerIdleMs,
      nowMs: input.nowMs,
      ...(input.lastWakeupNoteAtMs !== undefined
        ? { lastWakeupNoteAtMs: input.lastWakeupNoteAtMs }
        : {}),
    });
  const structuralDecision = evaluate([]);
  if (
    !structuralDecision.allowed
    && (
      structuralDecision.reason === 'internal_session'
      || structuralDecision.reason === 'privacy_boundary'
    )
  ) {
    return structuralDecision;
  }

  const latestConversation = conversationalEntryFromSessionMetadata(input.session);
  if (latestConversation?.role === 'user') {
    const metadataDecision = evaluate([latestConversation]);
    if (!metadataDecision.allowed) return metadataDecision;
  }

  if (
    input.lastWakeupNoteAtMs === undefined
    || !latestSessionActivityAtOrBefore(input.session, input.lastWakeupNoteAtMs)
  ) {
    return null;
  }
  const provenPartnerEntry: SessionEntry = {
    id: 0,
    channelId: input.session.sessionId,
    role: 'user',
    content: '',
    timestamp: Math.min(
      input.session.timestamp,
      input.nowMs - Math.max(0, input.minPartnerIdleMs),
    ),
  };
  const antiLoopDecision = evaluate([provenPartnerEntry]);
  return !antiLoopDecision.allowed && antiLoopDecision.reason === 'anti_loop_note_today'
    ? antiLoopDecision
    : null;
}

export function evaluateIdleRefresherPreflight(input: {
  session: StartupSessionMetadata;
  minIdleMs: number;
  minNoteIntervalMs: number;
  nowMs: number;
  lastWakeupNoteAtMs?: number;
  evaluateEligibility: (input: IdleRefresherEvaluateInput) => IdleRefresherDecision;
}): IdleRefresherDecision | null {
  const evaluate = (recentEntries: readonly SessionEntry[]): IdleRefresherDecision =>
    input.evaluateEligibility({
      session: input.session,
      recentEntries,
      minIdleMs: input.minIdleMs,
      minNoteIntervalMs: input.minNoteIntervalMs,
      nowMs: input.nowMs,
      ...(input.lastWakeupNoteAtMs !== undefined
        ? { lastWakeupNoteAtMs: input.lastWakeupNoteAtMs }
        : {}),
    });
  const structuralDecision = evaluate([]);
  if (
    !structuralDecision.allowed
    && (
      structuralDecision.reason === 'internal_session'
      || structuralDecision.reason === 'privacy_boundary'
    )
  ) {
    return structuralDecision;
  }

  const latestConversation = conversationalEntryFromSessionMetadata(input.session);
  if (latestConversation) {
    const metadataDecision = evaluate([latestConversation]);
    if (!metadataDecision.allowed) return metadataDecision;
  }

  if (
    input.lastWakeupNoteAtMs === undefined
    || !latestSessionActivityAtOrBefore(input.session, input.lastWakeupNoteAtMs)
  ) {
    return null;
  }
  const provenConversationEntry: SessionEntry = {
    id: 0,
    channelId: input.session.sessionId,
    role: 'assistant',
    content: '',
    timestamp: Math.min(
      input.session.timestamp,
      input.nowMs - Math.max(0, input.minIdleMs),
    ),
  };
  const antiLoopDecision = evaluate([provenConversationEntry]);
  return !antiLoopDecision.allowed && antiLoopDecision.reason === 'anti_loop_recent_note'
    ? antiLoopDecision
    : null;
}
