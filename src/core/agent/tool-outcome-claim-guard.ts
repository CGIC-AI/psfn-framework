import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import {
  isToolResultOutcomeProjection,
  resolveToolCallOutcome,
} from '../../shared/contracts/tool-call-outcome.js';
import { resolveExplicitlyRequestedToolNames } from '../../shared/tools/explicit-tool-request.js';
import { CANONICAL_FIRST_PARTY_TOOL_SURFACES } from './tool-surface/registry.js';

const EXECUTION_SUCCESS_CLAIM_PATTERNS = [
  /(?:^|[.!?]\s+)\s*(?:done|completed|finished|success)\s*[.!?]?(?:\s|$)/iu,
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:successfully\s+)?(?:completed|finished|executed|ran|sent|saved|wrote|created|updated|deleted|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled)\b/iu,
  /\b(?:the|that|your)\s+(?:operation|request|task|action|file|message|document|event|job)\s+(?:has been|was|is)\s+(?:successfully\s+)?(?:completed|finished|executed|sent|saved|created|updated|deleted|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled)\b/iu,
  /(?:^|[.!?]\s+)\s*(?:successfully\s+)?(?:completed|finished|executed|ran|sent|saved|wrote|created|updated|deleted|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled)\b/iu,
];

export const UNCONFIRMED_TOOL_EXECUTION_CORRECTION =
  'No matching successful tool execution was recorded, so I cannot truthfully report that operation as completed.';

export const UNAVAILABLE_REQUESTED_TOOL_CORRECTION =
  'The requested tool is unavailable in the current live catalog, so no operation was executed.';

const STRUCTURED_EXECUTION_SUCCESS_KEY = /^(?:success|succeeded|completed|done|created|updated|deleted|sent|saved|wrote|written|executed|ran|fetched|downloaded|uploaded|attached|posted|published|scheduled|cancelled|canceled|restored|imported|appended|notified|inspected|viewed|listed|linked|redacted|considered|started|worked|toggled(?:Twice)?|disabledThenRestored)$/iu;
const STRUCTURED_EXECUTION_FAILURE_PATTERN = /\b(?:could not|cannot|can't|failed|failure|error|denied|blocked|refused|rejected|retired|unavailable|not executed|not completed)\b/iu;

function parseStructuredResponse(responseText: string): unknown {
  const trimmed = responseText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return undefined;
  }
}

function containsStructuredExecutionSuccess(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsStructuredExecutionSuccess);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => (
    (entry === true && STRUCTURED_EXECUTION_SUCCESS_KEY.test(key))
    || containsStructuredExecutionSuccess(entry)
  ));
}

function claimsExecutionSuccess(responseText: string, explicitToolRequest: boolean): boolean {
  if (EXECUTION_SUCCESS_CLAIM_PATTERNS.some(pattern => pattern.test(responseText))) return true;
  const structured = parseStructuredResponse(responseText);
  if (containsStructuredExecutionSuccess(structured)) return true;
  if (!explicitToolRequest || STRUCTURED_EXECUTION_FAILURE_PATTERN.test(responseText)) return false;
  return (Array.isArray(structured) && structured.length > 0)
    || (!!structured && typeof structured === 'object' && Object.keys(structured).length > 0);
}

/**
 * Reject a final assistant claim of execution success when every observed tool
 * result was a denial/rejection/skip. A prior success in the same parent turn
 * makes a later duplicate skip truthful and therefore does not trigger this
 * guard.
 */
export function rejectsUnconfirmedToolExecutionClaim(input: {
  requestText?: string;
  activeToolNames?: readonly string[];
  responseText: string;
  turnMessages: readonly AgentMessage[];
}): boolean {
  let observedNonExecutionOutcome = false;
  const successfulToolNames = new Set<string>();
  for (const message of input.turnMessages) {
    if (!isToolResultOutcomeProjection(message)) continue;
    const outcome = resolveToolCallOutcome(message);
    if (outcome === 'success') {
      successfulToolNames.add(message.toolName);
      continue;
    }
    if (
      outcome === 'validation_rejection'
      || outcome === 'policy_denial'
      || outcome === 'duplicate_skip'
      || outcome === 'dependency_skip'
    ) {
      observedNonExecutionOutcome = true;
    }
  }

  const explicitlyRequestedToolNames = resolveExplicitlyRequestedToolNames(
    input.requestText ?? '',
    [
      ...new Set([
        ...(input.activeToolNames ?? []),
        ...CANONICAL_FIRST_PARTY_TOOL_SURFACES.map(tool => tool.name),
      ]),
    ],
  );
  const successClaimed = claimsExecutionSuccess(
    input.responseText,
    explicitlyRequestedToolNames.length > 0,
  );
  if (explicitlyRequestedToolNames.length > 0 && successClaimed) {
    return explicitlyRequestedToolNames.some(toolName => !successfulToolNames.has(toolName));
  }

  return successfulToolNames.size === 0 && observedNonExecutionOutcome && successClaimed;
}
