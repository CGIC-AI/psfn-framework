import type {
  ToolCall,
  ToolSchema,
} from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ResolvedCorrelationMetadata } from './correlation.js';
import {
  classifyToolArgumentProvenance,
  findCorruptEmptyToolCalls,
  toDiagnosticCorrelationFields,
} from './client-response-helpers.js';
import type { RoutingCandidate } from './routing.js';

const log = createComponentLogger('LLMClient');

// mihm: bound on how many times a single completion is re-run when its tool call
// arrives with corrupt-empty arguments against a required-property schema. After this
// many retries the (still corrupt) response is returned as-is so downstream validation
// surfaces it — fail closed, never fabricate/drop/default.
export const MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES = 2;

/**
 * gu8m diagnostics: when a streamed response contains tool calls with empty
 * arguments, emit a structured, provenance-classified warning so incidents are
 * attributable from logs alone (no live debugger required). Distinguishes:
 *  - provider_emitted_empty: the model called the tool with no arguments at all
 *    (no argument fragments arrived anywhere in the stream).
 *  - stream_parse_dropped: argument fragments DID arrive but a tool call still
 *    ended empty — the accumulator lost them (the pre-patch failure mode). This
 *    should not fire once the pi-ai index-routing patch is applied; keeping the
 *    classifier lets us confirm the fix holds and catch any regression.
 */
export function logEmptyToolArgumentProvenance(
  toolCalls: readonly ToolCall[],
  argumentFragmentBytes: number,
  candidate: RoutingCandidate,
  correlation: ResolvedCorrelationMetadata | undefined,
  attempt: number,
): void {
  for (const toolCall of toolCalls) {
    const provenance = classifyToolArgumentProvenance({
      args: toolCall.input,
      argumentFragmentBytes,
    });
    // Non-empty args are a genuine schema rejection if they fail downstream — not an
    // emptiness/loss incident — so the gateway does not warn on them here.
    if (provenance === 'validation_rejected') continue;
    log.warn('Tool call arrived with empty arguments', {
      provenance,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      argumentFragmentBytes,
      // 0 = first completion attempt; ≥1 = mihm empty-args completion retry.
      attempt,
      provider: candidate.provider,
      model: candidate.model,
      ...(correlation ? toDiagnosticCorrelationFields(correlation) : {}),
    });
  }
}

/**
 * mihm fail-closed backstop. Some OpenRouter GLM upstreams intermittently emit a
 * tool call whose streamed arguments are a literal empty object — the provider-side
 * tool-template parser dropped them (nothing client-side can recover). Dispatching
 * such a call fails AJV validation for required-property tools (or, worse, silently
 * runs an optional-action tool's default). Because the flake is a per-request routing
 * lottery, re-running the same completion usually lands a clean upstream. This wraps a
 * single completion attempt and retries the WHOLE attempt (bounded) whenever the result
 * carries a corrupt-empty tool call, then FAILS CLOSED by returning the last response
 * as-is so downstream validation surfaces the error — never fabricating args, never
 * dropping the call, never defaulting the action.
 */
export async function retryCompletionOnCorruptEmptyToolArgs<T>(input: {
  attempt: (attemptIndex: number) => Promise<T>;
  extractToolCalls: (result: T) => readonly ToolCall[];
  tools: readonly ToolSchema[] | undefined;
  candidate: RoutingCandidate;
  correlation: ResolvedCorrelationMetadata | undefined;
  purpose: string;
  onRetriesResolved: (retries: number) => void;
}): Promise<T> {
  let result = await input.attempt(0);
  let retries = 0;
  for (;;) {
    const corrupt = findCorruptEmptyToolCalls(input.extractToolCalls(result), input.tools);
    if (corrupt.length === 0) break;
    if (retries >= MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES) break;
    retries += 1;
    log.warn('Retrying completion: tool call arguments empty against a required-property schema', {
      toolNames: corrupt.map((call) => call.name),
      attempt: retries,
      maxRetries: MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES,
      provider: input.candidate.provider,
      model: input.candidate.model,
      purpose: input.purpose,
      ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
    });
    result = await input.attempt(retries);
  }

  if (retries > 0) {
    const stillCorrupt = findCorruptEmptyToolCalls(input.extractToolCalls(result), input.tools);
    log.warn('Empty-args completion retry resolved', {
      outcome: stillCorrupt.length > 0 ? 'exhausted_returned_corrupt' : 'recovered',
      retries,
      maxRetries: MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES,
      ...(stillCorrupt.length > 0 ? { corruptToolNames: stillCorrupt.map((call) => call.name) } : {}),
      provider: input.candidate.provider,
      model: input.candidate.model,
      purpose: input.purpose,
      ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
    });
  }

  input.onRetriesResolved(retries);
  return result;
}
