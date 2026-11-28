// ── Unreported attempt charge (ge9w7, after 21c4v) ──
// A failed provider attempt that reports no usage still has to land in the
// ledger as a cost the budget guard can trust. What the provider bills depends
// on how far the request got and who stopped it, so this module observes the
// dispatch boundary of each physical attempt and owns the single decision of
// how many tokens such an attempt is charged.

import type { LLMUsageDetails } from '../../shared/contracts/runtime.js';
import type { LLMRequestOptions } from './client-request-capability.js';
import { normalizeLLMUsageDetails } from './client-response-helpers.js';
import { extractReasoningContent, extractTextContent } from './conversion.js';
import { classifyLLMError } from './error-classify.js';
import { countMessageTokens } from './tokens.js';

/**
 * How far one physical attempt got, observed through pi-ai's request hooks:
 * `onPayload` runs immediately before the HTTP request is sent, `onResponse`
 * once the provider answered with status and headers.
 */
export interface AttemptDispatchEvidence {
  dispatched: boolean;
  responded: boolean;
}

export interface AttemptDispatchTracker {
  /** Start observing a new physical attempt; earlier attempts' evidence is not reused. */
  begin(): AttemptDispatchEvidence;
}

/**
 * Install the dispatch hooks on request options that are reused for every
 * physical attempt of one candidate. A payload built after the owner already
 * cancelled is never sent (the transport refuses an aborted signal), so it does
 * not count as dispatched.
 */
export function trackAttemptDispatch(
  requestOptions: LLMRequestOptions,
  signal: AbortSignal,
): AttemptDispatchTracker {
  let current: AttemptDispatchEvidence = { dispatched: false, responded: false };
  const priorOnPayload = requestOptions.onPayload;
  requestOptions.onPayload = async (payload, payloadModel) => {
    const result = await priorOnPayload?.(payload, payloadModel);
    if (!signal.aborted) current.dispatched = true;
    return result;
  };
  const priorOnResponse = requestOptions.onResponse;
  requestOptions.onResponse = async (response, responseModel) => {
    current.dispatched = true;
    current.responded = true;
    await priorOnResponse?.(response, responseModel);
  };
  return {
    begin() {
      current = { dispatched: false, responded: false };
      return current;
    },
  };
}

/** What is known about a failed attempt's end when it reported no usage. */
export interface UnreportedAttemptOutcome {
  /** The attempt's own transport signal fired: its owner cancelled it (caller abort or gate preemption). */
  ownerCancelled: boolean;
  dispatch: AttemptDispatchEvidence;
}

export type UnreportedAttemptChargeBasis =
  /** Never sent: the provider cannot bill it. */
  | 'not_dispatched'
  /** Sent, then cancelled by its owner before any output: prompt processing may be billed, output was never generated. */
  | 'input_bound'
  /** End not observed (timeout or an abort the owner did not initiate): the request bound. */
  | 'worst_case';

export interface UnreportedAttemptCharge {
  basis: UnreportedAttemptChargeBasis;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Tokens to charge a failed attempt that reported no usage and produced no
 * observed output, or undefined when the ordinary accounting applies (usage was
 * reported, output was observed, or the failure is a provider answer such as an
 * HTTP error, which bills nothing).
 *
 * An owner-cancelled attempt is settled from the evidence: the provider stops
 * when the connection closes, so before the first output token it can at most
 * have billed the prompt, and before dispatch nothing. Only an attempt whose end
 * the owner did not observe keeps the request's worst case (21c4v).
 */
export function resolveUnreportedAttemptCharge(input: {
  status: 'success' | 'failure';
  error: Error | undefined;
  reportedTokens: number;
  worstCaseTokens: { input: number; output: number } | undefined;
  outcome: UnreportedAttemptOutcome | undefined;
}): UnreportedAttemptCharge | undefined {
  if (input.status !== 'failure' || !input.error || !input.worstCaseTokens) return undefined;
  if (input.reportedTokens > 0) return undefined;
  const category = classifyLLMError(input.error).category;
  if (category !== 'abort' && category !== 'timeout') return undefined;
  const inputBound = Math.max(0, Math.ceil(input.worstCaseTokens.input));
  if (input.outcome?.ownerCancelled === true) {
    if (!input.outcome.dispatch.dispatched) {
      return { basis: 'not_dispatched', inputTokens: 0, outputTokens: 0 };
    }
    return { basis: 'input_bound', inputTokens: inputBound, outputTokens: 0 };
  }
  return {
    basis: 'worst_case',
    inputTokens: inputBound,
    outputTokens: Math.max(0, Math.ceil(input.worstCaseTokens.output)),
  };
}

/**
 * Usage for an attempt that stopped after output began but before the provider
 * reported usage: the input estimate plus the observed output, at least one
 * token. The provider stops generating when the connection closes, so the
 * observed output is what it produced.
 */
export function estimatePartialAttemptUsage(
  partialOutput: string,
  inputTokens: number,
): LLMUsageDetails {
  return normalizeLLMUsageDetails(
    undefined,
    inputTokens,
    Math.max(1, countMessageTokens([{ role: 'assistant', content: partialOutput }])),
  );
}

/** Output a resolved, failed completion carried (text, reasoning and tool-call arguments). */
export function completionPartialOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const blocks = content as unknown[];
  const toolArguments = blocks
    .filter((block): block is { type: 'toolCall'; arguments?: unknown } => (
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'toolCall'
    ))
    .map(block => JSON.stringify(block.arguments ?? {}))
    .join('');
  return `${extractTextContent(blocks)}${extractReasoningContent(blocks)}${toolArguments}`;
}
