import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

/**
 * The closing "take notes" turn for a Bus-aware subagent.
 *
 * Workers are told to read their prior notes at spawn and leave concise notes
 * when the job is done. An optional instruction alone is routinely skipped, so
 * a completed run that has written nothing to the Bus gets exactly one bounded
 * extra turn asking it to record its notes. The turn's reply is never the
 * run's deliverable; only its token usage is accounted.
 */
export const SUBAGENT_RUN_NOTES_PROMPT = [
  'Your task is finished; your previous reply is the result and stays unchanged.',
  'Before you stop, leave notes for the next run: call automata_bus with action=note one to three times.',
  'Each note is one short, reusable fact that starts with the job topic: what worked, what failed and why, where to look next time.',
  'Never copy Partner text, personal facts, or transcript content into a note.',
  'Then reply with the single word: noted.',
].join(' ');

export interface SubagentRunNotesTarget {
  /** Null when this run has no governed Bus tool. */
  readonly tool: unknown;
  readonly observedBusWrites: number;
}

export interface SubagentRunNotesUsage {
  requested: boolean;
  inputTokens: number;
  outputTokens: number;
  notesWritten: number;
}

/**
 * Ask a completed worker for its run notes once, when it has a Bus tool and
 * has not already written any. A failed notes turn never discards the
 * completed deliverable: it is reported through `onFailure` and the run
 * settles with the notes it has.
 */
export async function requestSubagentRunNotes(input: {
  run: SubagentRunNotesTarget;
  baseMessage: SubstrateMessage;
  subagentId: string;
  handleMessage: (message: SubstrateMessage) => Promise<{
    metadata: { inputTokens: number; outputTokens: number };
  }>;
  onFailure: (error: string) => void;
}): Promise<SubagentRunNotesUsage> {
  const before = input.run.observedBusWrites;
  if (!input.run.tool || before > 0) {
    return { requested: false, inputTokens: 0, outputTokens: 0, notesWritten: 0 };
  }
  try {
    const response = await input.handleMessage({
      ...input.baseMessage,
      id: `${input.subagentId}-run-notes`,
      content: SUBAGENT_RUN_NOTES_PROMPT,
    });
    return {
      requested: true,
      inputTokens: response.metadata.inputTokens,
      outputTokens: response.metadata.outputTokens,
      notesWritten: input.run.observedBusWrites - before,
    };
  } catch (error) {
    input.onFailure(toErrorMessage(error));
    return { requested: true, inputTokens: 0, outputTokens: 0, notesWritten: 0 };
  }
}
