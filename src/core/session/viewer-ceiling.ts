import { getRequestContext } from '../../primitives/llm/request-context.js';
import { normalizeChannelPrivacy, type ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../system/trust/types.js';
import { TRUST_LEVELS, trustOrd } from '../../system/trust/types.js';
import type { ConversationScope } from './conversation-scope.js';

/**
 * Viewer ceiling for delegated workers (psfn-framework-mzytp).
 *
 * A subagent or shard runs its own turns in its own channel. Without a
 * ceiling it resolved its own viewer (a system author at regular trust in an
 * invite-only worker channel, or the companion itself), so a worker spawned
 * from a public room could read personal or private companion-wide material
 * and hand it back into that room. The spawning conversation's viewer is
 * captured at spawn and every worker turn runs at no more than it: the lower
 * trust level and the more restrictive room privacy. A spawn without an
 * admitted viewer context is refused.
 */
export interface ViewerCeiling {
  readonly trustLevel: TrustLevel;
  readonly channelPrivacy: ChannelPrivacy;
  /** The conversation the worker was spawned from. */
  readonly sourceChannelId: string;
}

/** Room privacy from least to most disclosing. */
const CHANNEL_PRIVACY_DISCLOSURE: Readonly<Record<ChannelPrivacy, number>> = {
  public: 0,
  invite_only: 1,
  private: 2,
};

function normalizeTrustLevel(value: unknown): TrustLevel | undefined {
  return (TRUST_LEVELS as readonly unknown[]).includes(value) ? value as TrustLevel : undefined;
}

/**
 * The ceiling of the conversation spawning a worker, from the admitted
 * request context. Throws when the viewer's trust, room privacy, or channel
 * is missing: a worker never runs without a known ceiling.
 */
export function captureViewerCeilingFromRequest(workerKind: string): ViewerCeiling {
  const context = getRequestContext();
  const trustLevel = normalizeTrustLevel(context?.viewerTrustLevel);
  const channelPrivacy = normalizeChannelPrivacy(context?.viewerChannelPrivacy);
  const sourceChannelId = typeof context?.channelId === 'string' ? context.channelId.trim() : '';
  if (!trustLevel || !channelPrivacy || sourceChannelId.length === 0) {
    throw new Error(
      `${workerKind} refused: the spawning conversation has no admitted viewer context, `
      + 'so the worker\'s trust ceiling cannot be established.',
    );
  }
  return { trustLevel, channelPrivacy, sourceChannelId };
}

/** Whether the current request carries an admitted viewer (trust and room). */
export function hasAdmittedViewerContext(): boolean {
  const context = getRequestContext();
  return normalizeTrustLevel(context?.viewerTrustLevel) !== undefined
    && normalizeChannelPrivacy(context?.viewerChannelPrivacy) !== undefined;
}

export function capTrustLevelToCeiling(level: TrustLevel, ceiling: ViewerCeiling): TrustLevel {
  return trustOrd(level) <= trustOrd(ceiling.trustLevel) ? level : ceiling.trustLevel;
}

export function capChannelPrivacyToCeiling(privacy: ChannelPrivacy, ceiling: ViewerCeiling): ChannelPrivacy {
  return CHANNEL_PRIVACY_DISCLOSURE[privacy] <= CHANNEL_PRIVACY_DISCLOSURE[ceiling.channelPrivacy]
    ? privacy
    : ceiling.channelPrivacy;
}

/** The turn's conversation scope with its room privacy held to the ceiling. */
export function capConversationScopeToCeiling(
  scope: ConversationScope,
  ceiling: ViewerCeiling,
): ConversationScope {
  const channelPrivacy = capChannelPrivacyToCeiling(scope.envelope.channelPrivacy, ceiling);
  if (channelPrivacy === scope.envelope.channelPrivacy) return scope;
  return { ...scope, envelope: { ...scope.envelope, channelPrivacy } };
}
