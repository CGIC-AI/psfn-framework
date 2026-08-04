import type { StartupSessionMetadata } from '../session/manager.js';
import type { SessionEntry } from '../session/types.js';
import type { IdleGapTexture } from './time-texture.js';

export type MorningWakeSkipReason =
  | 'no_recent_session'
  | 'internal_session'
  | 'privacy_boundary'
  | 'no_partner_activity'
  | 'partner_recently_active'
  | 'anti_loop_note_today'
  | 'no_activation_since_wake';

export type MorningWakeDecision =
  | {
    allowed: true;
    reason: 'eligible';
    nowMs: number;
    sessionId: string;
    lastPartnerActivityAtMs: number;
    lastActivityAtMs: number;
    timeTexture: IdleGapTexture;
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
  minPartnerIdleMs: number;
  nowMs?: number;
  timeZone?: string;
  lastWakeupNoteAtMs?: number;
}

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
