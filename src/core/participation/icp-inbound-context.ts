import type { SessionEntry } from '../session/types.js';
import type { ParticipationContextReader } from './passive-name-candidate.js';
import type { ParticipationContextMessage } from './types.js';

/**
 * Bounded conversation history for appraising an inbound ICP message
 * (psfn-framework-p6s1f). The reply/no-reply appraisal used to see only the
 * trigger line, so a typed decision backend judged a continuing sibling
 * conversation as a lone message and declined every one. This reads the
 * receiving companion's OWN companion-dm channel (the channel the message
 * arrived on): nothing from any other conversation is loaded, so no content
 * crosses a room boundary. Only conversational turns are kept; tool output and
 * internal ICP delivery records never reach the appraiser.
 */

export interface IcpAppraisalContextSource {
  reader: ParticipationContextReader;
  /** Owner-file bound (scheduler.json passiveNameCandidate.precedingContextMessages). */
  messageLimit: number;
}

function isConversationalTurn(entry: SessionEntry): boolean {
  return (entry.role === 'user' || entry.role === 'assistant') && entry.content.trim().length > 0;
}

export async function loadIcpAppraisalPrecedingContext(
  source: IcpAppraisalContextSource,
  trigger: { channelId: string; messageId: string; timestampMs: number },
): Promise<ParticipationContextMessage[]> {
  if (!Number.isInteger(source.messageLimit) || source.messageLimit < 0) {
    throw new Error('ICP appraisal context messageLimit must be a non-negative integer');
  }
  if (source.messageLimit === 0) return [];
  // Over-read so dropping tool/system entries and the trigger itself still
  // leaves up to messageLimit conversational turns.
  const entries = await source.reader.getRecent(trigger.channelId, source.messageLimit * 4);
  return entries
    .filter(entry => entry.channelId === trigger.channelId)
    .filter(isConversationalTurn)
    .filter(entry => entry.discordMessageId !== trigger.messageId)
    .filter(entry => entry.timestamp <= trigger.timestampMs)
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-source.messageLimit)
    .map(entry => ({
      messageId: entry.discordMessageId ?? String(entry.id),
      authorId: entry.authorId ?? '',
      authorName: entry.authorName ?? (entry.role === 'assistant' ? 'you' : 'peer companion'),
      content: entry.content,
      timestampMs: entry.timestamp,
    }));
}
