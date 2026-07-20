import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import { resolveToolCallOutcome } from '../../shared/contracts/tool-call-outcome.js';

const EXECUTION_SUCCESS_CLAIM_PATTERNS = [
  /(?:^|[.!?]\s+)\s*(?:done|completed|finished|success)\s*[.!?]?(?:\s|$)/iu,
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:successfully\s+)?(?:completed|finished|executed|ran|sent|saved|wrote|created|updated|deleted|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled)\b/iu,
  /\b(?:the|that|your)\s+(?:operation|request|task|action|file|message|document|event|job)\s+(?:has been|was|is)\s+(?:successfully\s+)?(?:completed|finished|executed|sent|saved|created|updated|deleted|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled)\b/iu,
  /(?:^|[.!?]\s+)\s*(?:successfully\s+)?(?:completed|finished|executed|ran|sent|saved|wrote|created|updated|deleted|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled)\b/iu,
];

export const UNCONFIRMED_TOOL_EXECUTION_CORRECTION =
  'I could not confirm that operation completed: the tool call was denied, rejected, or skipped, '
  + 'so no successful execution occurred.';

/**
 * Reject a final assistant claim of execution success when every observed tool
 * result was a denial/rejection/skip. A prior success in the same parent turn
 * makes a later duplicate skip truthful and therefore does not trigger this
 * guard.
 */
export function rejectsUnconfirmedToolExecutionClaim(input: {
  responseText: string;
  turnMessages: readonly AgentMessage[];
}): boolean {
  let observedNonExecutionOutcome = false;
  for (const message of input.turnMessages) {
    if ((message as { role?: unknown }).role !== 'toolResult') continue;
    const result = message as unknown as {
      outcome?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    const outcome = resolveToolCallOutcome(result);
    if (outcome === 'success') return false;
    if (
      outcome === 'validation_rejection'
      || outcome === 'policy_denial'
      || outcome === 'duplicate_skip'
      || outcome === 'dependency_skip'
    ) {
      observedNonExecutionOutcome = true;
    }
  }

  return observedNonExecutionOutcome
    && EXECUTION_SUCCESS_CLAIM_PATTERNS.some(pattern => pattern.test(input.responseText));
}
