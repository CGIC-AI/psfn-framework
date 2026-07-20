import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';

const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;
const INTERNAL_REFLECTION_SESSION_PREFIX = 'internal:reflection:';
export const TESTING_SESSION_NAMESPACE = 'testing';

/**
 * Canonical partition prefix for free-time continuity sessions. The scheduler
 * trigger lane (quiet-hours vs idle) must NOT appear in the identity: both
 * lanes resume the SAME chosen workspace session under this one prefix
 * (bible §10.4 — "Scheduler trigger lane must not determine transcript
 * identity"). Every free-time call site (session identity classification,
 * retrieval access scope, self-audience derivation, ICP candidate source,
 * scheduler channel resolution) reads this single constant so the identity
 * scheme cannot drift across sites.
 */
export const FREE_TIME_CHANNEL_PREFIX = 'internal:free-time:';
const EXPERIENTIAL_SELF_DIRECTED_SESSION_PREFIXES: readonly string[] = [
  FREE_TIME_CHANNEL_PREFIX,
  INTERNAL_REFLECTION_SESSION_PREFIX,
];
export type InferredSessionChannelType = ChannelType | 'subagent';

function normalizePrefix(prefix: string): string | null {
  const normalized = prefix.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isInternalSessionId(sessionId: string): boolean {
  return sessionId.startsWith('internal:')
    || sessionId.startsWith('subagent:')
    || sessionId.startsWith('shard:');
}

/**
 * Internal streams where an assistant turn can be evidence about the
 * companion's own lived activity. Operational heartbeat/maintenance streams
 * stay excluded even though they are also internal.
 */
export function isExperientialSelfDirectedSessionId(sessionId: string): boolean {
  return EXPERIENTIAL_SELF_DIRECTED_SESSION_PREFIXES.some(prefix => sessionId.startsWith(prefix));
}

export function isInternalReflectionSessionId(sessionId: string): boolean {
  return sessionId.startsWith(INTERNAL_REFLECTION_SESSION_PREFIX);
}

/**
 * Test harness sessions reserve a `testing` namespace segment after the
 * existing channel prefix: `<channel-prefix>:testing:<name>`. This composes
 * with prefixes that carry routing identity (for example
 * `api:<principal>:testing:<name>`) without matching ordinary names that
 * merely contain the word "testing".
 */
export function isTestingSessionId(sessionId: string): boolean {
  const segments = sessionId.split(':');
  const markerIndex = segments.indexOf(TESTING_SESSION_NAMESPACE);
  return markerIndex > 0
    && markerIndex < segments.length - 1
    && segments[markerIndex + 1]!.trim().length > 0;
}

export function inferSessionChannelType(sessionId: string): InferredSessionChannelType | undefined {
  if (sessionId.startsWith('subagent:')) return 'subagent';
  if (sessionId.startsWith('discord-voice:')) return 'discord';
  if (DISCORD_CHANNEL_ID_PATTERN.test(sessionId)) return 'discord';

  const separatorIndex = sessionId.indexOf(':');
  if (separatorIndex > 0) {
    const prefix = normalizePrefix(sessionId.slice(0, separatorIndex));
    if (!prefix) return undefined;
    return CHANNEL_TYPES.includes(prefix as ChannelType)
      ? prefix as ChannelType
      : undefined;
  }

  return undefined;
}
