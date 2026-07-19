import type { SessionEntry } from '../../../core/session/types.js';
import { isNonConversationalSessionEntry } from '../../../core/session/manager-primitives.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './types.js';

export interface ExtractionEntrySelectionInput {
  /** Undefined permits foreground live-history lookup; an empty array is authoritative. */
  recoveredEntries: SessionEntry[] | undefined;
  /** Invoked only when no recovered range was handed in. */
  fetchLiveHistory: () => SessionEntry[];
  /**
   * Group runs (write caps present) process their full recovered range; direct
   * runs cap recovery at the legacy RECOVERY_CONTEXT_MESSAGE_LIMIT tail.
   */
  groupRecoveredRange: boolean;
}

export function selectExtractionRecentEntries(
  input: ExtractionEntrySelectionInput,
): SessionEntry[] {
  const recoveredEntries = (input.recoveredEntries !== undefined
    ? input.recoveredEntries
    : input.fetchLiveHistory()
  )
    .filter(entry => !isNonConversationalSessionEntry(entry));
  return input.groupRecoveredRange
    ? recoveredEntries
    : recoveredEntries.slice(-RECOVERY_CONTEXT_MESSAGE_LIMIT);
}
