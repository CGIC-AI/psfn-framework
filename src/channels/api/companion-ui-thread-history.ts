import type { SessionManager } from '../../core/session/manager.js';
import { COMPANION_UI_PROTOCOL_LIMITS } from '../../boundary/fleet-auth/companion-ui-action.js';

export interface CompanionUiThreadHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: number;
}

/**
 * Bounded main-thread transcript for one already-authorized Companion UI
 * caller (psfn-framework-jtr6e). The caller passes the exact source channel
 * its own turns are written to; it never comes from the browser. The read is
 * the durable TurnRecord window (tombstoned turns are already excluded) of
 * that channel only, sized by the companion's owned session-history window
 * and cut newest-first at the protocol frame bound, returned oldest first. A
 * message larger than the reply ceiling is omitted: the browser rejects such
 * a reply on the live path, so it was never displayed.
 */
export function readCompanionUiThreadHistory(
  sessions: Pick<SessionManager, 'getSourceTurnRecordsInHistoryWindow'>,
  sourceChannelId: string,
): readonly CompanionUiThreadHistoryMessage[] {
  const records = sessions
    .getSourceTurnRecordsInHistoryWindow(sourceChannelId)
    .filter(record => record.status === 'completed')
    .sort((left, right) => right.startedAt - left.startedAt);
  const newestFirst: CompanionUiThreadHistoryMessage[] = [];
  let characters = 0;
  for (const record of records) {
    const turn = [record.assistantMessage, record.userMessage]
      .filter((message): message is NonNullable<typeof message> => message !== undefined)
      .filter(message => (message.role === 'user' || message.role === 'assistant')
        && message.content.length > 0
        && message.content.length <= COMPANION_UI_PROTOCOL_LIMITS.maxTextCharacters)
      .map(message => Object.freeze({
        role: message.role as 'user' | 'assistant',
        content: message.content,
        createdAt: message.timestamp,
      }));
    const turnCharacters = turn.reduce((total, message) => total + message.content.length, 0);
    if (characters + turnCharacters > COMPANION_UI_PROTOCOL_LIMITS.maxFrameBytes) break;
    characters += turnCharacters;
    newestFirst.push(...turn);
  }
  return Object.freeze(newestFirst.reverse());
}
