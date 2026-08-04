import { formatActiveDateTimeIso } from '../../shared/time/active-timezone.js';
import type { ChannelMeta } from '../../system/trust/policy.js';
import { classifyChannelDisclosure } from '../../system/trust/policy.js';
import { classifyIdleGapTexture } from '../scheduler/time-texture.js';
import type { TurnOrientationSnapshot } from '../turns/snapshot.js';
import { isInternalSessionId } from './session-id.js';
import type { SessionEntry } from './types.js';

export interface ActiveTemporalFrameConfig {
  enabled: boolean;
  minIdleMs: number;
}

export interface ActiveTemporalFrameInput extends ActiveTemporalFrameConfig {
  channelId: string;
  sourceChannelId: string;
  channelMeta?: ChannelMeta;
  recentEntries: readonly SessionEntry[];
  /** Persisted current-turn row to exclude; absent for deferred-persistence turns. */
  currentTurnEntryId?: number;
  nowMs?: number;
}

/**
 * Derive the latest temporal frame at the only point where it is useful: an
 * active model turn. The result is prompt context, never a queued journal row.
 * Repeated clock/frame changes while a channel is idle therefore collapse into
 * this one derivation from the current clock and the last conversational entry.
 */
export function buildActiveTemporalFrame(
  input: ActiveTemporalFrameInput,
): TurnOrientationSnapshot | undefined {
  if (!input.enabled) return undefined;
  if (isInternalSessionId(input.channelId)) return undefined;
  if (
    classifyChannelDisclosure(input.sourceChannelId, input.channelMeta).channelPrivacy
      === 'public'
  ) {
    return undefined;
  }

  const nowMs = Math.max(0, Math.floor(input.nowMs ?? Date.now()));
  const conversational = input.recentEntries
    .filter(entry => (
      (entry.role === 'user' || entry.role === 'assistant')
      && entry.id !== input.currentTurnEntryId
    ))
    .sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
  const lastActivity = conversational.at(-1);
  if (!lastActivity || !Number.isFinite(lastActivity.timestamp) || lastActivity.timestamp <= 0) {
    return undefined;
  }

  const idleThresholdMs = Math.max(0, Math.floor(input.minIdleMs));
  const idleGapMs = Math.max(0, nowMs - lastActivity.timestamp);
  if (idleGapMs < idleThresholdMs) return undefined;

  const timeTexture = classifyIdleGapTexture({
    lastActivityAtMs: lastActivity.timestamp,
    observedAtMs: nowMs,
  });
  const noteText = [
    '<temporal_frame_update source="active_turn" persistence="ephemeral">',
    `<last_activity_at_iso>${formatActiveDateTimeIso(new Date(lastActivity.timestamp))}</last_activity_at_iso>`,
    `<elapsed_since_last_activity_ms>${idleGapMs}</elapsed_since_last_activity_ms>`,
    `<time_texture_kind>${timeTexture.kind}</time_texture_kind>`,
    '<current_time_authority>runtime.current_datetime</current_time_authority>',
    '<delivery_scope>This frame was derived for this active model turn only; no idle-time frames are queued or replayed.</delivery_scope>',
    '</temporal_frame_update>',
  ].join('\n');

  return {
    fired: true,
    reason: 'idle_gap_exceeded',
    observedAt: nowMs,
    idleThresholdMs,
    lastActivityAt: lastActivity.timestamp,
    idleGapMs,
    noteText,
    timeTexture,
    sourceCounts: {
      session: conversational.length,
      continuity: 0,
      focusKnowledge: 0,
    },
  };
}
