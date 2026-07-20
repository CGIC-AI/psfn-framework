import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import type { SessionEntry } from '../../../core/session/types.js';

/**
 * Resolve the stable turn reference stored on episode spans.
 *
 * Episodic synthesis has always assigned a deterministic session-entry
 * reference when an imported/pre-turn-contract message has no parseable turn
 * envelope. Drill-down must use the identical rule or those already-persisted
 * spans could never be expanded.
 */
export function resolveEpisodeSessionEntryTurnId(entry: SessionEntry): string {
  try {
    return resolveSessionEntryTurnContext(entry).turnId;
  } catch {
    return `session-entry:${entry.channelId}:${entry.id}`;
  }
}
