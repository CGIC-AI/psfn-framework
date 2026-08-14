import type {
  ToolCall,
  ToolSchema,
  StreamCallbacks,
} from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ResolvedCorrelationMetadata } from './correlation.js';
import {
  classifyToolArgumentProvenance,
  findCorruptEmptyToolCalls,
  toDiagnosticCorrelationFields,
} from './client-response-helpers.js';
import type { RoutingCandidate } from './routing.js';
import { isMissingRequiredToolCallError } from './explicit-tool-request.js';

const log = createComponentLogger('LLMClient');

// mihm: bound on how many times a single completion is re-run when its tool call
// arrives with corrupt-empty arguments against a required-property schema. After this
// many retries the (still corrupt) response is returned as-is so downstream validation
// surfaces it — fail closed, never fabricate/drop/default.
export const MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES = 2;

export interface BufferedStreamCallbacks {
  callbacks: StreamCallbacks | undefined;
  flush(): void;
}

/** Hold retryable attempt output until its response postconditions pass. */
export function createBufferedStreamCallbacks(
  callbacks: StreamCallbacks | undefined,
): BufferedStreamCallbacks {
  if (!callbacks) return { callbacks: undefined, flush: () => undefined };
  const pending: Array<() => void> = [];
  let flushed = false;
  return {
    callbacks: {
      ...(callbacks.onText
        ? { onText: (text: string) => pending.push(() => callbacks.onText?.(text)) }
        : {}),
      ...(callbacks.onToolCall
        ? {
          onToolCall: (name: string, input: Record<string, unknown>) => {
            pending.push(() => callbacks.onToolCall?.(name, input));
          },
        }
        : {}),
      ...(callbacks.onFirstOutput
        ? {
          onFirstOutput: (observation: Parameters<NonNullable<StreamCallbacks['onFirstOutput']>>[0]) => {
            pending.push(() => callbacks.onFirstOutput?.(observation));
          },
        }
        : {}),
    },
    flush() {
      if (flushed) return;
      flushed = true;
      for (const publish of pending) publish();
    },
  };
}

/**
 * A required explicit step is a response postcondition, not a provider promise.
 * Retry one fresh physical completion when the provider returns no call at all;
 * every other contract violation remains immediately fatal.
 */
export async function retryCompletionOnMissingRequiredToolCall<T>(input: {
  attempt: () => Promise<T>;
  retryEnabled: boolean;
  candidate: RoutingCandidate;
  correlation: ResolvedCorrelationMetadata | undefined;
  purpose: string;
}): Promise<T> {
  try {
    return await input.attempt();
  } catch (error) {
    if (!input.retryEnabled || !isMissingRequiredToolCallError(error)) throw error;
    log.warn('Retrying completion: provider returned no call for a required explicit tool step', {
      provider: input.candidate.provider,
      model: input.candidate.model,
      purpose: input.purpose,
      ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
    });
  }

  try {
    const result = await input.attempt();
    log.warn('Missing required tool-call retry resolved', {
      outcome: 'recovered',
      provider: input.candidate.provider,
      model: input.candidate.model,
      purpose: input.purpose,
      ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
    });
    return result;
  } catch (error) {
    if (isMissingRequiredToolCallError(error)) {
      log.warn('Missing required tool-call retry resolved', {
        outcome: 'exhausted',
        provider: input.candidate.provider,
        model: input.candidate.model,
        purpose: input.purpose,
        ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
      });
    }
    throw error;
  }
}

/**
 * gu8m diagnostics: when a streamed response contains tool calls with empty
 * arguments, emit a structured, provenance-classified warning so incidents are
 * attributable from logs alone (no live debugger required). Distinguishes:
 *  - provider_emitted_empty: the model called the tool with no arguments at all
 *    (no argument fragments arrived anywhere in the stream).
 *  - stream_parse_dropped: argument fragments DID arrive but a tool call still
 *    ended empty — the accumulator lost them (the pre-upstream-fix failure
 *    mode). This should not fire with pi-ai's index-keyed accumulator; keeping
 *    the classifier lets us confirm the fix holds and catch any regression.
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
  maxRetries?: number;
  onRetriesResolved: (retries: number) => void;
}): Promise<T> {
  const maxRetries = input.maxRetries ?? MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES;
  let result = await input.attempt(0);
  let retries = 0;
  for (;;) {
    const corrupt = findCorruptEmptyToolCalls(input.extractToolCalls(result), input.tools);
    if (corrupt.length === 0) break;
    if (retries >= maxRetries) break;
    retries += 1;
    log.warn('Retrying completion: tool call arguments empty against a required-property schema', {
      toolNames: corrupt.map((call) => call.name),
      attempt: retries,
      maxRetries,
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
      maxRetries,
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
