import type { ContextCoherenceSessionContext } from '../../shared/contracts/context-coherence.js';
import type { SessionEntry } from '../session/types.js';

type ContextEntry = Pick<SessionEntry, 'role' | 'timestamp' | 'authorId'>;

export function deriveContextCoherenceSessionContext(
  entries: readonly ContextEntry[],
  messageTimestampMs: number,
  activeConcernCount: number | null,
): ContextCoherenceSessionContext {
  const priorConversationTimestamp = entries
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .map(entry => entry.timestamp)
    .filter(timestamp => Number.isFinite(timestamp) && timestamp < messageTimestampMs)
    .reduce<number | null>((latest, timestamp) => (
      latest === null || timestamp > latest ? timestamp : latest
    ), null);
  return {
    recentMirrorNoteCount: entries.filter(entry => entry.authorId === 'session-mirror').length,
    timeGapMs: priorConversationTimestamp === null
      ? null
      : Math.max(0, messageTimestampMs - priorConversationTimestamp),
    activeConcernCount,
  };
}
