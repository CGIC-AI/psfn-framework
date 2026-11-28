import type { SatelliteHubThreadHistoryEvent } from '../api/client.js';
import type { HubStreamMessage, HubStreamState } from './hub-stream.js';

/** Local IDs of messages restored from the in-session companion memory. */
export const REMEMBERED_ID_PREFIX = 'remembered:';

/**
 * Hydrate a reconnected main thread from the gateway's authorized durable
 * history (psfn-framework-jtr6e). The server transcript replaces the restored
 * in-memory prefix rather than appending to it; messages this connection
 * produced after the read was requested stay after it. A selected shard owns
 * its own server-provided history, so the main thread is left untouched.
 */
export function hydrateThreadHistory(
  state: HubStreamState,
  history: SatelliteHubThreadHistoryEvent['messages'],
): HubStreamState {
  if (state.session?.activeShardId) return state;
  const hydrated: HubStreamMessage[] = history.map((message, index) => ({
    id: `history:${index + 1}:${message.role}`,
    role: message.role,
    content: message.content,
    live: false,
    final: true,
    sequence: index + 1,
    receivedAt: new Date(message.createdAt).toISOString(),
  }));
  const current = state.messages.filter(message => !message.id.startsWith(REMEMBERED_ID_PREFIX));
  return {
    ...state,
    messages: [...hydrated, ...current],
  };
}
