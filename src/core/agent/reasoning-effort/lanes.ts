import type { CorrelationMetadata } from '../../../shared/contracts/runtime.js';
import { isSocialOutreachChannelId } from '../../../shared/contracts/social-outreach-channel.js';
import type { ReasoningEffortLane } from '../../../system/config/reasoning-effort-config.js';
import { FREE_TIME_CHANNEL_PREFIX } from '../../session/session-id.js';

const INTERNAL_CHANNEL_PREFIX = 'internal:';
const REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';
const HEARTBEAT_CHANNEL_ID = 'internal:heartbeat';
const HEARTBEAT_CHANNEL_PREFIX = 'internal:heartbeat:';
const WORLD_EXPLORATION_CHANNEL_ID = 'internal:world-exploration';
const PLANNED_CHANNEL_PREFIX = 'internal:planned:';
// Delegated work runs on its own channels; it is neither conversation nor the
// companion's own time, so it keeps its slot tuning.
const DELEGATED_CHANNEL_PREFIXES = ['shard:', 'subagent:'] as const;

function hasSuffixAfter(channelId: string, prefix: string): boolean {
  return channelId.startsWith(prefix) && channelId.length > prefix.length;
}

/**
 * The reasoning lane of a model call, from the runtime-resolved channel of
 * the turn that makes it (never model supplied).
 *
 * - conversation channels (and per-contact social outreach, which composes a
 *   message to someone) are `chat`;
 * - `internal:free-time:*` is `freeTime`;
 * - `internal:reflection:*` (daily/weekly and companion-authored reflection
 *   templates, temporal wake-up, the dream pass) and the legacy
 *   `internal:heartbeat` channel are `reflection`;
 * - world exploration and companion-planned internal prompts are
 *   `selfDirected`.
 *
 * Delegated shard and subagent channels, and every other internal channel
 * (cogsec reviews, conformance probes, scheduler and memory machinery), have
 * no lane and keep their slot's own tuning.
 */
export function resolveReasoningEffortLane(
  context: Pick<Partial<CorrelationMetadata>, 'channelId'> | undefined,
): ReasoningEffortLane | null {
  const channelId = typeof context?.channelId === 'string' ? context.channelId.trim() : '';
  if (!channelId) return null;
  if (DELEGATED_CHANNEL_PREFIXES.some(prefix => channelId.startsWith(prefix))) return null;
  if (!channelId.startsWith(INTERNAL_CHANNEL_PREFIX)) return 'chat';
  if (isSocialOutreachChannelId(channelId)) return 'chat';
  if (hasSuffixAfter(channelId, FREE_TIME_CHANNEL_PREFIX)) return 'freeTime';
  if (
    hasSuffixAfter(channelId, REFLECTION_CHANNEL_PREFIX)
    || channelId === HEARTBEAT_CHANNEL_ID
    || hasSuffixAfter(channelId, HEARTBEAT_CHANNEL_PREFIX)
  ) {
    return 'reflection';
  }
  if (channelId === WORLD_EXPLORATION_CHANNEL_ID || hasSuffixAfter(channelId, PLANNED_CHANNEL_PREFIX)) {
    return 'selfDirected';
  }
  return null;
}

/** Own-time lanes: the companion's self-directed work, as opposed to conversation. */
export function isOwnTimeReasoningLane(lane: ReasoningEffortLane | null): boolean {
  return lane !== null && lane !== 'chat';
}
