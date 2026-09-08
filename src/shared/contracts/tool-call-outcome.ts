import { isRecord } from '../utils/types.js';

export const TOOL_CALL_OUTCOMES = [
  'success',
  'execution_failure',
  'validation_rejection',
  'policy_denial',
  'duplicate_skip',
  'dependency_skip',
  'content_withheld',
  'screening_unavailable',
  'partial_result',
] as const;

export type ToolCallOutcome = typeof TOOL_CALL_OUTCOMES[number];

/**
 * Degraded evidence (psfn-framework-lpxg3.2): the call itself ran, but what it
 * returned is not the full requested evidence.
 *
 * - `content_withheld`: intake screening admitted nothing — the turn received a
 *   fixed, content-free notice instead of the read.
 * - `screening_unavailable`: the screener itself failed, so no verdict exists
 *   and the content is withheld fail-closed.
 * - `partial_result`: some of the requested evidence was delivered and some was
 *   not (a sanitizing admission, or a tool that declares a bounded/truncated
 *   read).
 *
 * These are deliberately NOT `success` and NOT `execution_failure`: protected
 * self-work must be able to see that evidence is MISSING rather than read
 * absence as fact, and must not treat a bounded hold as a broken tool.
 */
export const DEGRADED_EVIDENCE_TOOL_CALL_OUTCOMES = [
  'content_withheld',
  'screening_unavailable',
  'partial_result',
] as const;

export type DegradedEvidenceToolCallOutcome =
  typeof DEGRADED_EVIDENCE_TOOL_CALL_OUTCOMES[number];

/**
 * Whether a workflow author declared this evidence edge as load-bearing.
 * Unknown semantics resolve to `required`: a caller that never states its
 * dependency keeps the conservative, halting behavior.
 */
export type ToolCallEvidenceDependency = 'required' | 'optional';

/**
 * Structural, tool-DECLARED signal that a result carries only part of the
 * requested evidence. Never inferred from result text (see the `classSource`
 * rule below): a tool that wants partial semantics must say so.
 */
export const PARTIAL_TOOL_RESULT_DETAILS_KEY = 'partialResult';

export type ToolCallOutcomeCounts = Record<ToolCallOutcome, number>;

export const TOOL_CALL_IDEMPOTENCY_SCHEMA_KEY = 'x-psfn-tool-call-idempotency';
export const HELD_TOOL_CALL_RESULT_STATUS = 'held';

export type ToolCallIdempotency = 'idempotent' | 'effectful';

/**
 * JSON-Schema metadata used by the turn scheduler to decide whether identical
 * calls are safe to collapse. Unknown and malformed declarations resolve to
 * effectful so an undeclared action always executes.
 */
export interface ToolCallIdempotencySchemaMetadata {
  default: ToolCallIdempotency;
  defaultAction?: string;
  actions?: Readonly<Record<string, ToolCallIdempotency>>;
}

export interface ToolResultOutcomeProjection {
  role: 'toolResult';
  toolName: string;
  outcome?: unknown;
  details?: unknown;
  isError?: unknown;
  resultText?: unknown;
}

export const DUPLICATE_TOOL_CALL_SKIP_RESULT =
  'Internal tool status: skipped duplicate tool call because the same tool/action/input already succeeded this turn. This is not a Participant-facing message.';

export const SEQUENTIAL_DEPENDENCY_SKIP_RESULT =
  'Skipped because an earlier sequential tool call failed. Read the tool result and retry only the needed follow-up call.';

function isToolCallIdempotency(value: unknown): value is ToolCallIdempotency {
  return value === 'idempotent' || value === 'effectful';
}

export function resolveToolCallIdempotency(
  parameters: unknown,
  argumentsValue: unknown,
): ToolCallIdempotency {
  if (!isRecord(parameters)) return 'effectful';
  const declaration = parameters[TOOL_CALL_IDEMPOTENCY_SCHEMA_KEY];
  if (!isRecord(declaration) || !isToolCallIdempotency(declaration.default)) {
    return 'effectful';
  }
  if (
    declaration.defaultAction !== undefined
    && (typeof declaration.defaultAction !== 'string' || !declaration.defaultAction.trim())
  ) {
    return 'effectful';
  }
  if (declaration.actions !== undefined) {
    if (!isRecord(declaration.actions)) return 'effectful';
    if (Object.values(declaration.actions).some(value => !isToolCallIdempotency(value))) {
      return 'effectful';
    }
  }

  const declaredAction = isRecord(argumentsValue) ? argumentsValue.action : undefined;
  const action = typeof declaredAction === 'string'
    ? declaredAction.trim()
    : typeof declaration.defaultAction === 'string'
      ? declaration.defaultAction.trim()
      : '';
  if (!action || declaration.actions === undefined) {
    return declaration.default;
  }
  const actionIdempotency = declaration.actions[action];
  return isToolCallIdempotency(actionIdempotency)
    ? actionIdempotency
    : 'effectful';
}

/** A held call did not perform its intended action and is retryable after release. */
export function isHeldToolCallResult(details: unknown): boolean {
  return isRecord(details) && details.status === HELD_TOOL_CALL_RESULT_STATUS;
}

export function isToolCallOutcome(value: unknown): value is ToolCallOutcome {
  return typeof value === 'string'
    && (TOOL_CALL_OUTCOMES as readonly string[]).includes(value);
}

export function isDegradedEvidenceToolCallOutcome(
  outcome: ToolCallOutcome,
): outcome is DegradedEvidenceToolCallOutcome {
  return (DEGRADED_EVIDENCE_TOOL_CALL_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Outcomes whose call produced something the turn can read. A withheld read
 * DID execute and the turn received a typed, content-free notice explaining
 * the hold, so it is not a tool failure — it is missing evidence. Calling it a
 * failure would burn the per-signature failure budget and produce a
 * companion-facing "notify the Operator" notice for a benign, bounded hold.
 */
const NON_FAILURE_TOOL_CALL_OUTCOMES: readonly ToolCallOutcome[] = [
  'success',
  'content_withheld',
  'partial_result',
];

export function isToolCallErrorOutcome(outcome: ToolCallOutcome): boolean {
  return !NON_FAILURE_TOOL_CALL_OUTCOMES.includes(outcome);
}

/**
 * Whether a sequential batch must stop after this outcome instead of running
 * the calls queued behind it (psfn-framework-lpxg3.2).
 *
 * A real failure is always terminal. Degraded evidence is terminal only while
 * the consumer has not declared the edge optional, so an optional withheld or
 * unavailable read lets independent and degraded-tolerant work continue while
 * an undeclared one keeps today's conservative halt. A partial result delivered
 * evidence and never halts.
 */
export function blocksSequentialDependents(
  outcome: ToolCallOutcome,
  evidenceDependency: ToolCallEvidenceDependency,
): boolean {
  if (outcome === 'success' || outcome === 'partial_result') return false;
  if (isDegradedEvidenceToolCallOutcome(outcome)) return evidenceDependency === 'required';
  return true;
}

/**
 * bead sqsz: an errorClass derived only from free-text keyword matching
 * (classSource === 'inferred') is not authoritative evidence of a rejection or
 * denial. A genuine runtime failure that RETURNS a diagnostic whose text merely
 * contains a policy/validation keyword must stay an execution failure, not be
 * hidden from runtime-failure telemetry. Absent classSource is treated as
 * declared, so explicit tool-asserted denials and structured signals are
 * unaffected.
 */
function isInferredErrorClass(details: Record<string, unknown>): boolean {
  return details.classSource === 'inferred';
}

function isPolicyDenialDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  if (details.capabilityDenied === true
    || details.egressGated === true
    || details.policyDenied === true) {
    return true;
  }
  if (isInferredErrorClass(details)) return false;
  return details.errorClass === 'permission_denied'
    || details.errorClass === 'policy_blocked';
}

function isValidationRejectionDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  if (isInferredErrorClass(details)) return false;
  return details.errorClass === 'invalid_input';
}

/**
 * A partial read is only ever tool-DECLARED. There is no text heuristic here:
 * a diagnostic that happens to mention truncation stays whatever outcome its
 * structured details describe.
 */
function isDeclaredPartialResultDetails(details: unknown): boolean {
  return isRecord(details) && details[PARTIAL_TOOL_RESULT_DETAILS_KEY] === true;
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
  if (input.isError === true) return 'execution_failure';
  return isDeclaredPartialResultDetails(input.details) ? 'partial_result' : 'success';
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

export function isToolResultOutcomeProjection(
  value: unknown,
): value is ToolResultOutcomeProjection {
  return isRecord(value)
    && value.role === 'toolResult'
    && typeof value.toolName === 'string';
}

export function hasSuccessfulToolCallOutcome(
  values: readonly unknown[],
  accepts: (result: ToolResultOutcomeProjection) => boolean = () => true,
): boolean {
  return values.some((value) => (
    isToolResultOutcomeProjection(value)
    && accepts(value)
    && resolveToolCallOutcome(value) === 'success'
  ));
}

export function createEmptyToolCallOutcomeCounts(): ToolCallOutcomeCounts {
  return {
    success: 0,
    execution_failure: 0,
    validation_rejection: 0,
    policy_denial: 0,
    duplicate_skip: 0,
    dependency_skip: 0,
    content_withheld: 0,
    screening_unavailable: 0,
    partial_result: 0,
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
