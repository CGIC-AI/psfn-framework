import { isRecord } from '../utils/types.js';

export const TOOL_CALL_OUTCOMES = [
  'success',
  'execution_failure',
  'validation_rejection',
  'policy_denial',
  'duplicate_skip',
  'dependency_skip',
] as const;

export type ToolCallOutcome = typeof TOOL_CALL_OUTCOMES[number];

export type ToolCallOutcomeCounts = Record<ToolCallOutcome, number>;

export const DUPLICATE_TOOL_CALL_SKIP_RESULT =
  'Internal tool status: skipped duplicate tool call because the same tool/action/input already succeeded this turn. This is not a user-facing message.';

export const SEQUENTIAL_DEPENDENCY_SKIP_RESULT =
  'Skipped because an earlier sequential tool call failed. Read the tool result and retry only the needed follow-up call.';

export function isToolCallOutcome(value: unknown): value is ToolCallOutcome {
  return typeof value === 'string'
    && (TOOL_CALL_OUTCOMES as readonly string[]).includes(value);
}

export function isToolCallErrorOutcome(outcome: ToolCallOutcome): boolean {
  return outcome !== 'success';
}

function isPolicyDenialDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  return details.capabilityDenied === true
    || details.egressGated === true
    || details.policyDenied === true
    || details.errorClass === 'permission_denied'
    || details.errorClass === 'policy_blocked';
}

function isValidationRejectionDetails(details: unknown): boolean {
  return isRecord(details) && details.errorClass === 'invalid_input';
}

/**
 * Classify a result returned from a tool implementation. Scheduler-owned
 * validation corrections and skips pass their explicit outcome instead.
 */
export function classifyExecutedToolCallOutcome(input: {
  details?: unknown;
  isError?: boolean;
}): ToolCallOutcome {
  if (isPolicyDenialDetails(input.details)) return 'policy_denial';
  if (isValidationRejectionDetails(input.details)) return 'validation_rejection';
  return input.isError === true ? 'execution_failure' : 'success';
}

/**
 * Read a durable or event projection. Explicit outcome is authoritative.
 * Legacy isError/details are consulted only for records written before the
 * bounded taxonomy existed; a call with no observed result stays unclassified.
 */
export function resolveToolCallOutcome(input: {
  outcome?: unknown;
  details?: unknown;
  isError?: unknown;
  resultText?: unknown;
}): ToolCallOutcome | undefined {
  if (isToolCallOutcome(input.outcome)) return input.outcome;
  if (typeof input.isError !== 'boolean') return undefined;
  if (input.resultText === DUPLICATE_TOOL_CALL_SKIP_RESULT) return 'duplicate_skip';
  if (input.resultText === SEQUENTIAL_DEPENDENCY_SKIP_RESULT) return 'dependency_skip';
  return classifyExecutedToolCallOutcome({
    details: input.details,
    isError: input.isError,
  });
}

export function createEmptyToolCallOutcomeCounts(): ToolCallOutcomeCounts {
  return {
    success: 0,
    execution_failure: 0,
    validation_rejection: 0,
    policy_denial: 0,
    duplicate_skip: 0,
    dependency_skip: 0,
  };
}

export function countToolCallOutcomes(
  calls: ReadonlyArray<{
    outcome?: unknown;
    details?: unknown;
    isError?: unknown;
    resultText?: unknown;
  }>,
): ToolCallOutcomeCounts {
  const counts = createEmptyToolCallOutcomeCounts();
  for (const call of calls) {
    const outcome = resolveToolCallOutcome(call);
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}
