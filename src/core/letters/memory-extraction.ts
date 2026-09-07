import type { MemoryExtractor } from '../agent/contracts.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import { RUNTIME_LANE_CLASSES } from '../../shared/contracts/runtime-lanes.js';
import { createComponentLogger } from '../../shared/logger.js';
import { LETTER_L0_CHANNEL_ID } from './contracts.js';
import type { LetterService } from './service.js';

const log = createComponentLogger('Letters');

export const LETTER_MEMORY_EXTRACTION_ACTION_KIND = 'letters.memory.extract';

/**
 * One fixed key for the whole bin. `maybeExtract` evaluates the channel, not a
 * single entry, so a burst of letter events must collapse into one evaluation
 * instead of queueing one redundant run per letter.
 */
const LETTER_MEMORY_EXTRACTION_DEDUPE_KEY = 'letters:memory-extraction';

export interface LetterMemoryExtractionWiringOptions {
  actions: Pick<PostTurnActionRuntime, 'enqueue' | 'registerHandler'>;
  letters: Pick<LetterService, 'bindMemoryTrigger'>;
  memoryExtractor: Pick<MemoryExtractor, 'maybeExtract'>;
}

/**
 * Make the existing extraction primitive evaluate the letter bin.
 *
 * Letters append to `letters:bin` (LetterService), but the production
 * extraction trigger is keyed to a completed turn's own channel, so nothing
 * ever evaluated that channel and a letter could never become memory.
 *
 * The evaluation cannot run inline. A companion-authored letter is composed
 * from a tool call inside an admitted turn, where SessionManager's captured
 * session owner forbids reads of any other channel
 * (`assertMutableSessionReadAllowed`), and `evaluateExtractionTrigger` reads
 * `getRecentMessages` for its token-threshold arm. So the letter event is
 * handed to the existing deferred-action queue instead: its maintenance lane
 * waits for foreground idle and runs outside every turn scope. No parallel
 * extraction lane, scheduler job, or store is introduced — the handler calls
 * exactly the `maybeExtract` the post-turn path calls, and the usual interval
 * and context-threshold rules decide whether an extraction actually runs.
 */
export function wireLetterMemoryExtraction(options: LetterMemoryExtractionWiringOptions): void {
  options.actions.registerHandler(
    LETTER_MEMORY_EXTRACTION_ACTION_KIND,
    async () => {
      await options.memoryExtractor.maybeExtract(LETTER_L0_CHANNEL_ID);
    },
    {
      executionMode: 'background',
      runtimeClass: RUNTIME_LANE_CLASSES.maintenanceReflection,
      coalescing: 'dedupe_key_with_durable_watermark',
    },
  );

  options.letters.bindMemoryTrigger((event) => {
    let result: ReturnType<PostTurnActionRuntime['enqueue']>;
    try {
      result = options.actions.enqueue({
        id: `${LETTER_MEMORY_EXTRACTION_ACTION_KIND}:${event.event}:${event.letterId}`,
        kind: LETTER_MEMORY_EXTRACTION_ACTION_KIND,
        payload: { letterEvent: event.event, letterId: event.letterId },
        dedupeKey: LETTER_MEMORY_EXTRACTION_DEDUPE_KEY,
        channelId: LETTER_L0_CHANNEL_ID,
        sourceMessageId: event.letterId,
        inferredAt: event.at,
      });
    } catch (error) {
      // The letter is already durable in the store and in L0 by the time the
      // trigger fires. A failure to persist the deferred-action queue entry is
      // a lost evaluation signal, not a failed letter: surfacing it as a
      // compose/read error would report a false failure and, on the tool path,
      // invite a retry that writes a duplicate letter.
      log.error('Letter memory-extraction evaluation could not be queued', {
        letterEvent: event.event,
        letterId: event.letterId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (result === 'dropped_budget') {
      // The letter itself is already durable in L0 and the trigger counts every
      // uncovered bin entry, so the next letter event re-evaluates this same
      // backlog. Report the dropped evaluation instead of failing the letter.
      log.error('Letter memory-extraction evaluation was dropped by the deferred-action budget', {
        letterEvent: event.event,
        letterId: event.letterId,
      });
    }
  });
}
