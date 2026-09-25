import { getRequestContext } from '../../primitives/llm/request-context.js';
import { normalizeChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../system/trust/types.js';
import {
  canViewerAccessSessionHit,
  type SessionSearchViewerContext,
} from './search-runtime.js';

/**
 * Viewer-side read gate for channel-derived content that a model turn can see
 * from a different channel: session listings (previews, author names), resumed
 * session summaries, raw recent messages, and focus transcripts. It applies the
 * exact trust/room disclosure policy transcript search and grep use
 * (canViewerAccessSessionHit), so no surface shows content the transcript read
 * gate would withhold (psfn-framework-k0sr0).
 */

function normalizeOptionalTrustLevel(value: unknown): TrustLevel | undefined {
  switch (value) {
    case 'primary':
    case 'trusted':
    case 'regular':
    case 'public':
      return value;
    default:
      return undefined;
  }
}

/**
 * The viewer of the current turn, taken only from the admitted request
 * context. Callers never supply their own trust or privacy.
 */
export function resolveViewerContextFromRequest(): SessionSearchViewerContext {
  const requestContext = getRequestContext();
  const channelId = typeof requestContext?.channelId === 'string' && requestContext.channelId.trim().length > 0
    ? requestContext.channelId.trim()
    : undefined;
  const trustLevel = normalizeOptionalTrustLevel(requestContext?.viewerTrustLevel);
  const channelVisibility = normalizeChannelPrivacy(requestContext?.viewerChannelPrivacy);
  return {
    ...(channelId ? { channelId } : {}),
    ...(trustLevel ? { trustLevel } : {}),
    ...(channelVisibility ? { channelVisibility } : {}),
    ...(typeof requestContext?.viewerIsDirectMessage === 'boolean'
      ? { isDirectMessage: requestContext.viewerIsDirectMessage }
      : {}),
  };
}

/**
 * Whether the viewer may read content derived from `channelId`. The viewer's
 * own conversation is always readable (it is already in the turn's context);
 * every other channel goes through the transcript disclosure policy using the
 * channel's classified visibility.
 */
export function canViewerReadSessionChannel(
  viewer: SessionSearchViewerContext,
  channelId: string,
): boolean {
  if (viewer.channelId !== undefined && viewer.channelId === channelId) return true;
  return canViewerAccessSessionHit(viewer, { channelId });
}

/**
 * Split channel-keyed summaries into the ones the viewer may read and a
 * content-free count of the ones withheld. Withheld entries are dropped whole:
 * their channel ids can name a sibling or contact.
 */
export function gateSessionSummariesForViewer<T extends { channelId: string }>(
  viewer: SessionSearchViewerContext,
  sessions: readonly T[],
): { visible: T[]; gatedOutCount: number } {
  const visible = sessions.filter(session => canViewerReadSessionChannel(viewer, session.channelId));
  return { visible, gatedOutCount: sessions.length - visible.length };
}
